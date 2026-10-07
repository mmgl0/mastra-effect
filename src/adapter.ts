import {
	checkRouteFGA,
	getCustomHTTPExceptionResponse,
	isZodError,
	MastraServer,
	normalizeQueryParams,
	redactStreamChunk,
	serializeStreamChunk,
	type ParsedRequestParams,
	type ServerRoute,
} from "@mastra/server/server-adapter";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/**
 * Framework types `MastraServer` is generic over.
 *
 * Effect's router is a service that routes the *current* request and whose
 * handlers return a response, so there is no mutable per-request response to
 * write into. Because Effect speaks web-standard `Request`/`Response`, we work
 * in those throughout and wrap once at the router boundary.
 */
export type EffectApp = HttpRouter.HttpRouter;
export type EffectRequest = Request;
export type EffectResponse = Request;

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const errorStatus = (error: unknown): number | undefined => {
	if (!error || typeof error !== "object") return undefined;
	const status = (error as { status?: unknown }).status;
	if (typeof status === "number") return status;
	const detail = (error as { details?: { status?: unknown } }).details?.status;
	return typeof detail === "number" ? detail : undefined;
};

const message = (error: unknown) =>
	error instanceof Error ? error.message : "Unknown error";

export class EffectHttpServer extends MastraServer<
	EffectApp,
	EffectRequest,
	EffectResponse
> {
	/** Mastra context travels with the request object, not a middleware chain. */
	registerContextMiddleware(): void {}

	/** Auth runs per route in `registerRoute` via `checkRouteAuth`. */
	registerAuthMiddleware(): void {}

	registerHttpLoggingMiddleware(): void {}

	async getParams(
		route: ServerRoute,
		request: EffectRequest,
	): Promise<ParsedRequestParams> {
		const url = new URL(request.url);
		const queryParams = normalizeQueryParams(
			Object.fromEntries(url.searchParams),
		);

		let body: unknown;
		let bodyParseError: { message: string } | undefined;

		if (route.method !== "GET" && route.method !== "HEAD") {
			const contentType = request.headers.get("content-type") ?? "";
			if (contentType.includes("multipart/form-data")) {
				try {
					body = await parseFormData(await request.clone().formData());
				} catch (error) {
					bodyParseError = { message: message(error) };
				}
			} else if (contentType.includes("application/json")) {
				const text = await request.clone().text();
				if (text.trim() !== "") {
					try {
						body = JSON.parse(text);
					} catch (error) {
						bodyParseError = { message: message(error) };
					}
				}
			}
		}

		return { urlParams: {}, queryParams, body, bodyParseError };
	}

	async sendResponse(
		route: ServerRoute,
		request: EffectResponse,
		result: unknown,
	): Promise<unknown> {
		switch (route.responseType) {
			case "json":
				return json(result ?? {});

			case "stream":
				return this.stream(route, request, result);

			// The handler already produced a web `Response`.
			case "datastream-response":
			case "mcp-http":
			case "mcp-sse":
				return result instanceof Response ? result : json(result ?? {});

			default:
				return new Response(null, { status: 500 });
		}
	}

	async stream(
		route: ServerRoute,
		_request: EffectResponse,
		result: unknown,
	): Promise<unknown> {
		const source =
			result instanceof ReadableStream
				? result
				: (result as { fullStream?: ReadableStream })?.fullStream;
		if (!source) return json(result ?? {});

		const sse = (route.streamFormat ?? "stream") === "sse";
		const redact = this.streamOptions?.redact ?? true;
		const encoder = new TextEncoder();

		const body = new ReadableStream<Uint8Array>({
			start: async (controller) => {
				const reader = source.getReader();
				try {
					if (sse && route.sseFlushOnConnect) {
						controller.enqueue(encoder.encode(": connected\n\n"));
					}
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!value) continue;

						// SSE comments pass through untouched.
						if (sse && typeof value === "string" && value.startsWith(":")) {
							controller.enqueue(encoder.encode(value));
							continue;
						}

						const chunk = redact ? redactStreamChunk(value) : value;
						const serialized = serializeStreamChunk(chunk);
						// One bad chunk must not kill the stream.
						if (!serialized.ok) continue;

						controller.enqueue(
							encoder.encode(
								sse ? `data: ${serialized.json}\n\n` : `${serialized.json}\x1E`,
							),
						);
					}
					if (sse) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch (error) {
					controller.error(error);
				} finally {
					await reader.cancel().catch(() => {});
				}
			},
		});

		return new Response(body, {
			headers: sse
				? {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
						"x-accel-buffering": "no",
					}
				: { "content-type": "text/plain" },
		});
	}

	async registerRoute(
		app: EffectApp,
		route: ServerRoute,
		options?: { prefix?: string },
	): Promise<void> {
		const prefix = options?.prefix ?? this.prefix ?? "";
		const path = `${prefix}${route.path}` || "/";

		const handler = Effect.flatMap(HttpRouter.params, (urlParams) =>
			Effect.flatMap(HttpServerRequest.HttpServerRequest, (serverRequest) =>
				Effect.flatMap(
					Effect.orDie(HttpServerRequest.toWeb(serverRequest)),
					(request) =>
						Effect.map(
							Effect.promise(() =>
								this.handle(route, request, urlParams as Record<string, string>),
							),
							HttpServerResponse.fromWeb,
						),
				),
			),
		);

		// `router.add` mutates the router synchronously and needs nothing at
		// runtime — its `Request.From<…>` requirements are phantom markers for
		// unhandled route errors, and this handler always yields a response.
		Effect.runSync(
			app.add(
				route.method.toUpperCase() as "GET",
				path as `/${string}`,
				handler,
			) as Effect.Effect<void>,
		);
	}

	/** Validate, authorize, run the route handler, and shape the response. */
	private async handle(
		route: ServerRoute,
		request: Request,
		urlParams: Record<string, string>,
	): Promise<Response> {
		const parsed = await this.getParams(route, request);
		if (parsed.bodyParseError) {
			return json(
				{
					error: "Invalid request body",
					issues: [{ field: "body", message: parsed.bodyParseError.message }],
				},
				400,
			);
		}

		const getHeader = (name: string) => request.headers.get(name) ?? undefined;
		const url = new URL(request.url);

		const requestContext = this.mergeRequestContext({
			paramsRequestContext: (parsed.queryParams as Record<string, any>)
				.requestContext,
			bodyRequestContext: (parsed.body as Record<string, any>)?.requestContext,
		});
		this.applyRequestMetadataToContext({ requestContext, getHeader });

		const authError = await this.checkRouteAuth(route, {
			path: url.pathname,
			method: request.method,
			getHeader,
			getQuery: (name) => url.searchParams.get(name) ?? undefined,
			requestContext,
			request,
		});
		if (authError) {
			return json({ error: authError.error }, authError.status, authError.headers);
		}

		// Each group is validated separately so failures carry the right context,
		// which is what the route's `onValidationError` hook keys off.
		let pathParams: Record<string, unknown>;
		let queryParams: Record<string, unknown>;
		let body: unknown;
		try {
			pathParams = await this.parsePathParams(route, urlParams);
			queryParams = await this.parseQueryParams(route, parsed.queryParams);
			body =
				parsed.body !== undefined || route.bodySchema
					? await this.parseBody(route, parsed.body)
					: undefined;
		} catch (error) {
			const context = validationContext(error, route);
			if (isZodError(error)) {
				const resolved = this.resolveValidationError(route, error, context);
				return json(resolved.body, resolved.status);
			}
			return json({ error: message(error) }, 400);
		}

		const params = {
			...pathParams,
			...queryParams,
			...(typeof body === "object" ? body : {}),
		};

		const fgaError = await checkRouteFGA(
			this.mastra,
			route,
			requestContext,
			params,
		);
		if (fgaError) {
			return json(
				{ error: fgaError.error, message: fgaError.message },
				fgaError.status,
			);
		}

		try {
			const result = await route.handler({
				...params,
				requestContext,
				mastra: this.mastra,
				registeredTools: this.tools,
				taskStore: this.taskStore,
				abortSignal: request.signal,
				routePrefix: this.prefix,
				request,
			} as never);
			return (await this.sendResponse(route, request, result)) as Response;
		} catch (error) {
			return (
				getCustomHTTPExceptionResponse(error) ??
				json({ error: message(error) }, errorStatus(error) ?? 500)
			);
		}
	}
}

/**
 * Which parameter group a validation failure came from.
 *
 * The parse calls run in a single `try`, so we recover the context from the
 * only schema the route declares — and fall back to `body`, which is what
 * nearly every validating route uses.
 */
const validationContext = (
	_error: unknown,
	route: ServerRoute,
): "path" | "query" | "body" => {
	if (route.bodySchema) return "body";
	if (route.queryParamSchema) return "query";
	if (route.pathParamSchema) return "path";
	return "body";
};

/** Flattens FormData, turning files into Buffers and JSON strings into values. */
const parseFormData = async (data: {
	entries(): IterableIterator<[string, unknown]>;
}): Promise<Record<string, unknown>> => {
	const result: Record<string, unknown> = {};
	for (const [key, value] of data.entries()) {
		if (typeof value === "string") {
			try {
				result[key] = JSON.parse(value);
			} catch {
				result[key] = value;
			}
		} else if (isFileLike(value)) {
			result[key] = Buffer.from(await value.arrayBuffer());
		} else {
			result[key] = value;
		}
	}
	return result;
};

const isFileLike = (
	value: unknown,
): value is { arrayBuffer(): Promise<ArrayBuffer> } =>
	typeof (value as { arrayBuffer?: unknown })?.arrayBuffer === "function";
