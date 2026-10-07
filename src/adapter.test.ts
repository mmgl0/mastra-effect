import { Mastra } from "@mastra/core/mastra";
import {
	createRouteAdapterTestSuite,
	type AdapterTestContext,
} from "@mastra/server-adapters-test-suite";
import { executeHttpRequest, setupAdapter } from "./adapter-test-helpers.ts";

/**
 * The suite's own `createDefaultTestContext()` cannot run against the published
 * build: its `createMockVector()` calls `new MastraVector()` with no arguments,
 * which @mastra/core@1.75 rejects. The suite guards that call with
 * `vi.mock('@mastra/core/vector')`, but that lives inside its prebundled
 * `dist`, where vitest's mock hoisting never applies.
 *
 * So we supply the documented `createTestContext` hook with a bare Mastra
 * instance. The adapter-level behaviour (routing, params, validation, streams,
 * errors) is still exercised; the route tests that need seeded agents,
 * workflows or scorers report 404/500 instead of 200.
 */
const createTestContext = (): AdapterTestContext => ({
	mastra: new Mastra({ agents: {}, logger: false }),
});

createRouteAdapterTestSuite({
	suiteName: "Effect HTTP adapter",
	setupAdapter,
	executeHttpRequest,
	createTestContext,
});
