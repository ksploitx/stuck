# stuck

**Observability for AI coding agents.** Traces what your agent actually does — file edits, terminal commands, git commits, tool calls — and generates a postmortem report when a task finishes or fails.

Built as a VS Code–API extension. Runs on **Antigravity**, **Cursor**, and **VS Code**.

---

## The Problem

AI coding agents operate as black boxes. You kick off a task, wait, and either get a result or a mess — with no visibility into what happened in between. There's no timeline of actions, no breakdown of time spent, and no record of retry loops or wasted cycles. When something goes wrong, you're left re-reading diffs and terminal output to reconstruct the story yourself.

**stuck** fixes this by instrumenting agent activity as [OpenTelemetry](https://opentelemetry.io/) spans and sending them to a local [SigNoz](https://signoz.io) instance. When a session ends, it queries the trace tree and uses an LLM to generate a structured postmortem — what happened, where time was spent, what went wrong, and what to do differently next time.

## What It Traces

| Signal | Source | All IDEs | Antigravity Only |
|---|---|---|---|
| File saves (with byte delta) | VS Code API | ✅ | ✅ |
| Terminal commands + exit codes | Shell Integration API | ✅ | ✅ |
| Git commits (files changed, line delta) | VS Code Git extension | ✅ | ✅ |
| Agent tool calls (file edits, searches) | CDP bridge | ❌ | ✅ |
| Agent task lifecycle (start/end) | CDP bridge | ❌ | ✅ |
| Retry loop detection | CDP bridge | ❌ | ✅ |

> **Cross-IDE honesty:** On Cursor and plain VS Code, stuck traces file/terminal/git activity — the same signals any extension can observe. The deeper agent-specific instrumentation (tool calls, task lifecycle, retry loops) requires Antigravity's CDP remote debugging port. There is no official agent API, so tool calls are inferred from CDP Network requests and Runtime console output via heuristics. Each span carries a `cdp.inference_quality` attribute (`high`/`medium`/`low`) so you can filter by reliability.

## Features

- **Live instrumentation** — file, terminal, and git spans flow to SigNoz in real time
- **CDP bridge** (Antigravity only) — captures agent tool calls and task signals via Chrome DevTools Protocol
- **Retry loop detection** — flags when the agent edits the same file or runs the same command 3+ times, with an in-editor warning notification
- **Postmortem reports** — LLM-generated session summaries with time breakdown, retry analysis, root cause, and recommendations
- **Session sidebar** — grouped session list (Active / Recent / Yesterday / Earlier) in the activity bar with status dots and metadata
- **Rich postmortem viewer** — full-panel webview with structured report sections, time breakdown bar, and "View in SigNoz" deep-link
- **Graceful degradation** — CDP bridge silently skips on non-Antigravity editors; LLM fallback produces structured-but-unnarrated reports if no model is reachable

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [foundryctl](https://github.com/SigNoz/foundry) — SigNoz deployment CLI

Install foundryctl:
```bash
curl -fsSL https://signoz.io/foundry.sh | bash
```

### 1. Clone and install

```bash
git clone https://github.com/ksploitx/stuck.git
cd stuck
npm install
```

### 2. Start SigNoz locally

The repo includes a `casting.yaml` for Foundry. Deploy it:

```bash
foundryctl cast -f casting.yaml
```

This spins up the full SigNoz stack in Docker. Open `http://localhost:8080` and create your local account on first run.

> **Note for judges:** `casting.yaml` and `casting.yaml.lock` are both checked into the repo. You can re-run `foundryctl cast -f casting.yaml` to reproduce the exact deployment.

### 3. Compile the extension

```bash
npm run compile
```

### 4. Run the extension

Press **F5** in VS Code / Cursor / Antigravity to launch the Extension Development Host.

**For Antigravity users** who want CDP bridge instrumentation, launch Antigravity with the remote debugging port enabled:
```bash
antigravity --remote-debugging-port=9000
```

---

## Configuration

All settings are under **Settings → Extensions → Stuck** or in `settings.json`:

| Setting | Default | Description |
|---|---|---|
| `stuck.otlpEndpoint` | `http://localhost:4318` | OTLP HTTP endpoint for SigNoz |
| `stuck.cdpPort` | `9000` | CDP remote debugging port (Antigravity) |
| `stuck.cdpEnabled` | `true` | Enable/disable CDP bridge |
| `stuck.idleTimeoutMinutes` | `5` | Inactivity minutes before postmortem triggers |
| `stuck.signozQueryEndpoint` | `http://localhost:3301` | SigNoz query API for trace retrieval |
| `stuck.llmProvider` | `ollama` | LLM for postmortem generation (`ollama`, `anthropic`, `openai`) |
| `stuck.ollamaEndpoint` | `http://localhost:11434` | Ollama API endpoint |
| `stuck.ollamaModel` | `llama3` | Ollama model name |
| `stuck.anthropicApiKey` | *(empty)* | Anthropic API key (if using Anthropic) |
| `stuck.openaiApiKey` | *(empty)* | OpenAI API key (if using OpenAI) |

---

## Usage Walkthrough

### Basic flow (any IDE)

1. **Start SigNoz:** `foundryctl cast -f casting.yaml`
2. **Press F5** to launch the extension in the Extension Development Host
3. **Work normally** — edit files, run terminal commands, make commits
4. **Check SigNoz** at `http://localhost:8080` → Traces → filter by service `stuck`
5. **Wait for postmortem** — after 5 minutes of inactivity (configurable), a notification appears and a report is saved to `.agent-reports/`
6. **Open the sidebar** — click the Stuck icon (pulse) in the activity bar to see the session list
7. **Click a session** to open the rich postmortem viewer

### Antigravity-specific flow

1. Launch Antigravity with `--remote-debugging-port=9000`
2. Press F5, then trigger an agent task
3. The CDP bridge captures tool calls, network requests, and task lifecycle events
4. If the agent retries the same operation 3+ times, you'll see an in-editor warning
5. When the task completes (or the agent idles out), the postmortem includes agent-specific breakdown: which tools were called, time in planning vs. editing vs. commands, and retry analysis

---

## Project Structure

```
stuck/
├── src/
│   ├── extension.ts             # Entry point — wires all modules
│   ├── otelEmitter.ts           # Shared OpenTelemetry SDK + span helpers
│   ├── fileWatcher.ts           # File save tracing (byte delta)
│   ├── gitWatcher.ts            # Git commit tracing (line delta, files changed)
│   ├── terminalWatcher.ts       # Terminal command tracing (exit code)
│   ├── cdpBridge.ts             # Antigravity CDP agent panel instrumentation
│   ├── loopDetector.ts          # Retry loop detection (3+ repeated targets)
│   ├── postmortem.ts            # Session-end detection, trace query, LLM report
│   └── webview/
│       ├── sessionListProvider.ts   # Sidebar session list (WebviewViewProvider)
│       └── postmortemPanel.ts       # Full-panel postmortem viewer (WebviewPanel)
├── mockups/                     # Target HTML mockups for webview UI
├── pours/deployment/            # SigNoz deployment artifacts (via foundryctl)
├── casting.yaml                 # Foundry deployment config (checked in)
├── casting.yaml.lock            # Foundry lockfile (checked in)
├── DESIGN.md                    # Visual design system reference
├── CHANGELOG.md                 # Phase-by-phase changelog
├── COMMANDS.md                  # Quick reference for dev commands
└── SKILLS.md                    # Build workflow rules for AI assistants
```

---

## Known Limitations

### CDP bridge is Antigravity-first

The deepest instrumentation — agent tool calls, task lifecycle, retry loop detection — depends on connecting to Antigravity's CDP remote debugging port. **This does not work on Cursor or plain VS Code** because those editors don't expose an agent panel via CDP. On non-Antigravity editors, the bridge silently skips and you still get file/terminal/git tracing, but without the agent-specific layer.

### CDP heuristics, not an API

There is no official API for observing Antigravity agent actions. The CDP bridge infers tool calls from Network request patterns and Runtime console output. This works well for common patterns but is inherently heuristic. Each span carries a `cdp.inference_quality` attribute so you can assess confidence. Future Antigravity API changes could break these heuristics.

### LLM dependency for narrative reports

The postmortem engine can use Anthropic, OpenAI, or a local Ollama model. If no LLM is reachable, it falls back to a structured-but-unnarrated report — you still get the data, just without the AI-generated summary and recommendations.

### Local-only SigNoz

Everything runs locally via Docker. There's no SigNoz cloud integration. The extension and SigNoz need to be on the same machine (or you need to adjust endpoint URLs if running remotely).

### No real-time streaming of postmortem generation

The postmortem is generated as a batch after session-end detection. There's no streaming output or partial results while the LLM is working.

---

## Commands Reference

See [COMMANDS.md](COMMANDS.md) for the full list of commands to manage SigNoz and the extension.

## License

MIT
