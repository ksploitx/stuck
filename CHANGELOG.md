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
