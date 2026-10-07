import type {
	AdapterSetupOptions,
	AdapterTestContext,
	HttpRequest,
	HttpResponse,
} from "@mastra/server-adapters-test-suite";
import { Effect } from "effect";
import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http";
import { EffectHttpServer } from "./adapter.ts";

/**
 * The "app" handed back to the suite.
 *
 * It must be the `HttpRouter` itself, because the suite registers ad-hoc routes
 * with `adapter.registerRoute(app, route)`. We attach `fetch` alongside so
 * `executeHttpRequest` can drive the same router.
 */
export type EffectTestApp = HttpRouter.HttpRouter & {
	readonly fetch: (request: Request) => Promise<Response>;
};

export const setupAdapter = async (
	context: AdapterTestContext,
	options?: AdapterSetupOptions,
): Promise<{ adapter: EffectHttpServer; app: EffectTestApp }> => {
	const router = Effect.runSync(HttpRouter.make);

	const adapter = new EffectHttpServer({
		app: router,
		mastra: context.mastra,
		tools: context.tools,
		taskStore: context.taskStore,
		customRouteAuthConfig: context.customRouteAuthConfig,
		prefix: options?.prefix ?? "/api",
	});
	await adapter.init();

	// Serve straight from the router rather than standing up a server layer per
	// test: `asHttpEffect` needs only the request and a scope.
	const httpEffect = router.asHttpEffect();

	const fetch = (request: Request): Promise<Response> =>
		Effect.runPromise(
			Effect.scoped(
				httpEffect.pipe(
					Effect.map(HttpServerResponse.toWeb),
					// Unmatched paths fail with RouteNotFound.
					Effect.catchCause(() =>
						Effect.succeed(
							new Response(JSON.stringify({ error: "Not Found" }), {
								status: 404,
								headers: { "content-type": "application/json" },
							}),
						),
					),
					Effect.provideService(
						HttpServerRequest.HttpServerRequest,
						HttpServerRequest.fromWeb(request),
					),
				),
			),
		);

	return { adapter, app: Object.assign(router, { fetch }) };
};

export const executeHttpRequest = async (
	app: EffectTestApp,
	request: HttpRequest,
): Promise<HttpResponse> => {
	const url = new URL(`http://localhost${request.path}`);
	for (const [key, value] of Object.entries(request.query ?? {})) {
		for (const item of Array.isArray(value) ? value : [value]) {
			url.searchParams.append(key, item);
		}
	}

	const headers = new Headers(request.headers);
	let body: string | undefined;
	if (request.body !== undefined) {
		body = JSON.stringify(request.body);
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
	}

	const response = await app.fetch(
		new Request(url.toString(), { method: request.method, headers, body }),
	);

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	const contentType = response.headers.get("content-type") ?? "";
	const isStream =
		contentType.includes("text/event-stream") ||
		contentType.includes("text/plain") ||
		contentType.includes("application/octet-stream");

	if (isStream) {
		return {
			status: response.status,
			type: "stream",
			stream: response.body ?? undefined,
			headers: responseHeaders,
		};
	}

	const text = await response.text();
	let data: unknown = undefined;
	if (text !== "") {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}

	return { status: response.status, type: "json", data, headers: responseHeaders };
};
