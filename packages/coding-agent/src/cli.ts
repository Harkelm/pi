#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME, VERSION } from "./config.ts";
import { createApplicationTelemetry, shutdownApplicationTelemetry } from "./core/application-telemetry.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const telemetryRuntime = createApplicationTelemetry(VERSION);
try {
	await main(process.argv.slice(2), { telemetryRuntime });
} finally {
	await shutdownApplicationTelemetry(telemetryRuntime);
}
