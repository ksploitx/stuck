# SKILLS.md — build workflow for "stuck"

This file defines how Cursor should behave while building this project. Read it fully before starting any phase. These rules apply for the entire build, not just phase 1.

## What this project is

"stuck" is a VS Code-API extension that runs unmodified on Antigravity, Cursor, and VS Code. It traces AI coding agent activity (file edits, terminal commands, git diffs, and Antigravity's agent panel via CDP) as OpenTelemetry spans sent to a self-hosted SigNoz instance. When a task finishes or fails, it generates an AI postmortem report summarizing what happened. Reports are viewable in a rich sidebar webview (session list) and a full-panel postmortem viewer.

Design system reference: `DESIGN.md` in this repo is the source of truth for all UI colors, typography, spacing, and component style. The two HTML mockups (`mockups/session-list.html`, `mockups/postmortem-report.html`) show the target look for the sidebar webview. The webview implementation in `src/webview/` adapts these mockups into live VS Code webview panels. Match them, don't reinvent the visual language.

## Hard rules for every phase

1. **No automated testing unless explicitly asked.** Don't write test suites, don't run `npm test`, don't add a test runner, don't validate behavior with automated checks, unless a phase prompt specifically says to. Manual verification steps are given to the human instead — see "End of phase" below.

2. **Never stage, commit, or push.** Don't run `git add`, `git commit`, `git push`, or any git write command at any point, even if a task appears complete. Git state is left exactly as it was found at the start of the session.

3. **Never install global tools or modify system state** outside the project folder without asking first.

4. **Stay inside the current phase's scope.** Don't start Phase 2 work while doing Phase 1, even if it seems convenient. Flag it instead: "this would be easier if I also touched X, which is Phase 2, want me to hold off?"

5. **Ask before any destructive action** (deleting files, overwriting configs, rewriting existing working code) instead of assuming it's fine.

## End of every phase, always produce four things

1. **What was built** — a short plain-language summary, not a code dump.
2. **How to verify it manually** — exact commands to run and what the human should see/click to confirm it worked. No automated tests, just "run this, look for that."
3. **Suggested commit message** — conventional-commit style (e.g. `feat(instrumentation): add file and git watcher spans`), given as text only. Never run the commit.
4. **What's next** — one or two sentences on what the following phase will need from what was just built.

## CHANGELOG.md

Keep a `CHANGELOG.md` at the repo root, updated at the end of every phase (create it if it doesn't exist yet). Format:

```md
## [Phase N] - <short title>

### Added

- bullet per meaningful addition

### Verify

- the manual verification steps given to the human

### Next

- one line on what phase N+1 depends on from this phase
```

Append, never rewrite earlier entries.

## Coding conventions

- TypeScript throughout, strict mode on.
- Extension code lives under `src/`, one file per concern (`fileWatcher.ts`, `terminalWatcher.ts`, `gitWatcher.ts`, `cdpBridge.ts`, `otelEmitter.ts`, `postmortem.ts`, `webview/sessionListProvider.ts`, `webview/postmortemPanel.ts`).
- OTel spans go through a single shared emitter module — don't instantiate the OTel SDK in more than one place.
- Keep IDE-specific code (the Antigravity CDP bridge) isolated in its own file behind a feature check, so Cursor/VS Code builds don't break if CDP isn't reachable.
- No secrets or API keys hardcoded. Read from VS Code extension settings/config.

## Environment notes

- SigNoz runs locally via `foundryctl`, OTLP endpoint defaults to `http://localhost:4318`. Assume it's already running unless a phase says to set it up.
- No SigNoz cloud, no external accounts, everything local.
- CDP bridge (`cdpBridge.ts`) connects to Antigravity's remote debugging port, default `localhost:9000` (configurable via `stuck.cdpPort`). This is the Antigravity-specific piece — there's no official agent API, so tool calls are inferred from Network requests and Runtime console output via CDP heuristics. Each span carries a `cdp.inference_quality` attribute (high/medium/low) so you can filter by reliability in SigNoz.
- Launch Antigravity with `--remote-debugging-port=9000` to enable CDP access. On Cursor/plain VS Code the bridge silently skips.
- SigNoz exposes two relevant endpoints: the OTLP ingest endpoint (`localhost:4318`) for sending spans/logs, and the query-service API (`localhost:3301`) for reading traces back. The postmortem engine queries `GET /api/v1/traces/{traceId}` on port 3301. Both are configurable via `stuck.otlpEndpoint` and `stuck.signozQueryEndpoint`.
- The postmortem engine uses a configurable LLM (Anthropic, OpenAI, or Ollama) for report generation. Default is Ollama (`localhost:11434`, model: `llama3`) so it works locally without API keys. If no LLM is reachable, it produces a structured-but-unnarrated fallback report.
