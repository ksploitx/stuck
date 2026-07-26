## [Phase 1] - Baseline Instrumentation

### Added

- VS Code extension scaffold (TypeScript)
- `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http` dependencies
- `otelEmitter.ts` to initialize OpenTelemetry SDK and export spans to `http://localhost:4318`
- `fileWatcher.ts` to trace file saves with byte delta
- `gitWatcher.ts` to trace git commits with line delta and files changed
- `terminalWatcher.ts` to trace terminal commands and exit codes
- `stuck.otlpEndpoint` configuration setting

### Verify

1. Run `npm run compile` to ensure the project builds without errors.
2. Press `F5` to open the Extension Development Host.
3. Have SigNoz running locally on port 4318.
4. Perform the following actions in the Extension Development Host:
   - Edit and save a text file.
   - Run a command in the integrated terminal.
   - Make a git commit.
5. Check SigNoz traces to confirm `file_save`, `git_commit`, and `terminal_command` spans are appearing with correct attributes.

### Next

- Phase 2 will involve adding Antigravity-specific tracing via the CDP bridge.

## [Phase 2] - CDP Bridge for Antigravity Agent Panel

### Added

- `cdpBridge.ts` — connects to Antigravity's CDP endpoint (default `localhost:9000`) to observe agent panel activity via Network, Runtime, and Page domains
- `loopDetector.ts` — tracks repeated file/command targets within a session and flags retry loops (3+ occurrences) with a `cdp.retry_loop` span attribute
- `stuck.cdpPort` configuration setting (number, default 9000)
- `stuck.cdpEnabled` configuration setting (boolean, default true)
- `getTracer()` export in `otelEmitter.ts` for shared tracer access
- `chrome-remote-interface` dependency for CDP WebSocket communication
- Graceful degradation: CDP bridge logs a warning and skips when endpoint isn't reachable (Cursor, plain VS Code)
- Auto-reconnect with exponential backoff (up to 5 attempts) on disconnect
- Span types emitted: `cdp_tool_call`, `cdp_network_response`, `cdp_task_signal`, `cdp_console`, `cdp_page_load`, `cdp_navigation`
- Each tool-call span includes `cdp.inference_quality` (high/medium/low) to indicate confidence in the heuristic

### Verify

1. Run `npm run compile` — should build with zero errors.
2. **Without CDP (Cursor/VS Code):** Press F5, open the Output panel → "Stuck CDP Bridge" channel. Confirm you see `CDP bridge: endpoint not reachable on port 9000, skipping`. File/git/terminal watchers should still work normally.
3. **With Antigravity + CDP:** Launch Antigravity with `--remote-debugging-port=9000`, press F5, trigger an agent task. Check SigNoz traces for `cdp_tool_call` and `cdp_network_response` spans with attributes like `cdp.tool_name`, `cdp.request_url`.
4. **Loop detection:** Trigger the agent to edit the same file 3+ times. Verify the 3rd+ span has `cdp.retry_loop: true` in SigNoz.

### Next

- Phase 3 will use the CDP-captured tool calls and task signals to generate AI postmortem reports when a task finishes or fails.

## [Phase 3] - Postmortem Engine

### Added

- `postmortem.ts` — session-end detection via CDP `task_end` signal or idle timeout
- SigNoz trace querying via `GET /api/v1/traces/{traceId}` to fetch full session history
- Structured summary builder analyzing time spent (planning/editing/commands/waiting) and retry counts
- AI report generation via configurable LLM provider (Anthropic, OpenAI, Ollama fallback)
- Configuration settings for LLM providers (`stuck.llmProvider`, `stuck.anthropicApiKey`, `stuck.openaiApiKey`, `stuck.ollamaEndpoint`)
- Configuration for timeouts and query endpoints (`stuck.idleTimeoutMinutes`, `stuck.signozQueryEndpoint`)
- Dual output: saves reports to `.agent-reports/*.md` in the workspace and pushes back to SigNoz as a log event

### Verify

1. Run `npm run compile` — should build with zero errors.
2. Ensure SigNoz is running locally (ports 4318 for OTLP, 3301 for query API).
3. Open Extension Development Host (F5). Edit some files or run terminal commands to generate traces.
4. Wait for 5 minutes of inactivity (or trigger a CDP task-end signal if running with Antigravity).
5. A notification will appear. Check `.agent-reports/` in the root workspace folder for the generated `postmortem-*.md` file.
6. (Optional) In SigNoz logs, check for a log containing the report attached to the trace ID.

### Next

- Phase 4 will introduce the interactive webview rendering for the agent panel (implementing the HTML mockups), replacing raw markdown files with a rich UI.
