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
- Configuration settings for LLM providers (`stuck.llmProvider`, `stuck.anthropicApiKey`, `stuck.openaiApiKey`, `stuck.ollamaEndpoint`, `stuck.ollamaModel`)
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

## [Phase 4] - Webview UI & Final Polish

### Added

- `DESIGN.md` — visual design system (color palette, typography, spacing, component specs)
- `mockups/session-list.html` — target HTML mockup for the sidebar session list
- `mockups/postmortem-report.html` — target HTML mockup for the postmortem report viewer
- `src/webview/sessionListProvider.ts` — sidebar `WebviewViewProvider` that reads `.agent-reports/` and live session state, renders grouped session list (Active / Recent / Yesterday / Earlier) with status dots, duration, retry badges
- `src/webview/postmortemPanel.ts` — full-panel `WebviewPanel` that parses postmortem `.md` files into structured view: header with status badge, attempted actions list, time breakdown bar with color legend, root cause card (failure only), retries section, recommendations, and "View in SigNoz" deep-link button
- Activity bar icon and `stuck-sessions` sidebar view via `package.json` views/viewsContainers
- `stuck.openPostmortem` and `stuck.refreshSessions` commands
- Retry-loop in-editor notification: `vscode.window.showWarningMessage()` fires when CDP detects 3+ retries on the same target — active notification, not just a sidebar dot
- `pours/deployment/alerts/retry-threshold-alert.yml` — SigNoz alert rule (YAML, no extension code) that fires when any session exceeds 5 retries
- `postmortem.ts` exports: `isPostmortemGenerating()`, `onPostmortemGenerated()`, `parseReportFile()` for webview consumption
- Empty state, loading state (spinner + pulse animation), and SigNoz-unreachable graceful degradation (button disabled with tooltip)
- CSP-safe webview rendering with nonce-based inline styles and scripts

### Verify

1. Run `npm run compile` — should build with zero errors.
2. Press F5 to launch Extension Development Host.
3. Check the activity bar for the "Stuck" icon (pulse icon) → clicking it opens the sidebar.
4. **Empty state:** If no `.agent-reports/` folder exists, sidebar shows "No sessions yet" with a friendly message.
5. Create a dummy `.agent-reports/postmortem-2026-07-26T12-00-00-abcd1234.md` file with valid YAML frontmatter (`trace_id`, `generated_at`) → use `Stuck: Refresh Sessions` command → session appears in the sidebar with correct status dot and metadata.
6. Click the session → postmortem panel opens with structured report view (header, time bar, retries, etc.).
7. Check the "View in SigNoz" button URL is correctly formed as `http://localhost:3301/trace/{traceId}`. If SigNoz is not running, button appears disabled.
8. **Retry alert:** With CDP enabled (Antigravity + `--remote-debugging-port=9000`), trigger a retry loop (same file 3+ times) → warning notification appears in the editor.
9. Verify `pours/deployment/alerts/retry-threshold-alert.yml` is valid YAML: `cat pours/deployment/alerts/retry-threshold-alert.yml | head -20`.

### Next

- Phase 5 (if planned) would add real-time session title inference, trace waterfall visualization inside the postmortem panel, and dashboard embedding from SigNoz.

## [Phase 5] - Packaging & Submission Prep

### Added

- Complete README.md rewrite: what stuck does, the problem it solves, honest cross-IDE feature matrix, setup with foundryctl + casting.yaml, full config table, usage walkthrough, and known limitations
- `.vscodeignore` to exclude dev-only files (src/, mockups/, SKILLS.md, DESIGN.md, pours/, casting files) from the packaged .vsix
- `CONTRIBUTING.md` with dev setup, coding conventions, and contribution workflow
- Updated `package.json` manifest: displayName, expanded description, `ksploitx` publisher, `MIT` license, repository URL, keywords (ai, agent, observability, opentelemetry, signoz, tracing, postmortem, antigravity), categories (Visualization, Debuggers, Other), `onStartupFinished` activation event (replaced wildcard `*`)
- Fixed `.gitignore` to track `casting.yaml`, `casting.yaml.lock`, and `COMMANDS.md` (Foundry competition requirement: judges re-run foundryctl against these files)

### Changed

- `activationEvents` from `"*"` to `"onStartupFinished"` — defers activation until the editor is fully loaded, improving startup performance

### Verify

1. Run `npm run compile` — builds with zero errors.
2. Read `README.md` — should have complete setup instructions, honest feature matrix, config table, usage walkthrough, and known limitations.
3. Check `.vscodeignore` exists and lists `src/**`, `mockups/**`, `SKILLS.md`, `DESIGN.md`, `casting.yaml`, `pours/**`.
4. Check `package.json` has `publisher`, `license`, `repository`, `keywords`, and `categories` fields.
5. Check `.gitignore` does NOT contain `casting.yaml` or `casting.yaml.lock`.
6. Run `npx @vscode/vsce ls` to preview what files would be included in the packaged extension.

### Next

- Ready for submission. Package with `npx @vscode/vsce package` and submit the .vsix along with the repo.
