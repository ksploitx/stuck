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
