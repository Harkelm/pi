# @earendil-works/pi-telemetry-otel

Optional OpenTelemetry export for Pi's vendor-neutral telemetry contract.

The adapter exports traces only and uses a bounded batch queue. Pi's built-in spans omit exception messages, prompts, responses, tool arguments, and tool output. Applications that start custom spans must apply the same content policy. An OTLP HTTP/protobuf endpoint is required.

```typescript
import { createOpenTelemetryRuntime } from "@earendil-works/pi-telemetry-otel";

const runtime = createOpenTelemetryRuntime({
	endpoint: "http://127.0.0.1:4318/v1/traces",
	serviceName: "pi",
	serviceVersion: "0.84.4",
});

const sessionTelemetry = runtime.contextForSession("session-id");
// Pass sessionTelemetry through Pi's existing telemetryContext options.

await runtime.shutdown();
```
