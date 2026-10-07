import type { Mastra } from "@mastra/core/mastra";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { EffectHttpServer } from "./adapter.ts";

export { EffectHttpServer } from "./adapter.ts";
export type { EffectApp, EffectRequest, EffectResponse } from "./adapter.ts";

export interface MastraLayerOptions {
	readonly mastra: Mastra;
	/** Path prefix for the Mastra API routes. Defaults to `/api`. */
	readonly prefix?: string;
	/** Serve the OpenAPI spec at this path, e.g. `/openapi.json`. */
	readonly openapiPath?: string;
	/** When false, stream chunks are sent unredacted. Defaults to true. */
	readonly redact?: boolean;
}

/**
 * Registers every Mastra route on the ambient `HttpRouter`.
 *
 * ```ts
 * import { Layer } from "effect"
 * import { HttpRouter } from "effect/http"
 * import { BunHttpServer } from "effect/platform-bun"
 * import { layerMastra } from "mastra-effect"
 *
 * HttpRouter.serve().pipe(
 *   Layer.provide(layerMastra({ mastra })),
 *   Layer.provide(BunHttpServer.layer({ port: 3000 }))
 * )
 * ```
 */
export const layerMastra = (
	options: MastraLayerOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
	HttpRouter.use((router) =>
		Effect.promise(async () => {
			const server = new EffectHttpServer({
				app: router,
				mastra: options.mastra,
				prefix: options.prefix ?? "/api",
				openapiPath: options.openapiPath,
				streamOptions: { redact: options.redact },
			});
			await server.init();
		}),
	);
