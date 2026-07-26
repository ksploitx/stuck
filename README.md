# stuck

A VS Code extension that traces AI coding agent activity and sends it to a self-hosted [SigNoz](https://signoz.io) instance via OpenTelemetry.

Works identically on **Antigravity**, **Cursor**, and **VS Code**.

## What it does

**stuck** monitors your coding activity and emits OpenTelemetry spans for:

- **File saves** — tracks which files were saved and the byte delta between saves
- **Terminal commands** — captures the command text and exit code via the Shell Integration API
- **Git commits** — records files changed and net line delta per commit

All spans are sent to a local SigNoz instance where you can search, filter, and visualize them.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [foundryctl](https://github.com/SigNoz/foundry) — SigNoz deployment CLI

### Install foundryctl
```bash
curl -fsSL https://signoz.io/foundry.sh | bash
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Start SigNoz
Create a `casting.yaml` in the project root:
```yaml
apiVersion: v1alpha1
metadata:
  name: signoz
spec:
  deployment:
    mode: docker
    flavor: compose
```

Then deploy:
```bash
foundryctl cast -f casting.yaml
```

Open `http://localhost:8080` and create your local account on first run.

### 3. Compile and run
```bash
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `stuck.otlpEndpoint` | `http://localhost:4318` | OTLP HTTP endpoint URL |

Change via **Settings → Extensions → Stuck** or in `settings.json`:
```json
{
  "stuck.otlpEndpoint": "http://localhost:4318"
}
```

## Project Structure

```
src/
├── extension.ts        # Extension entry point, wires everything together
├── otelEmitter.ts      # Shared OpenTelemetry SDK initialization and span helpers
├── fileWatcher.ts      # Traces file saves with byte delta
├── gitWatcher.ts       # Traces git commits with files changed and line delta
└── terminalWatcher.ts  # Traces terminal commands with exit code
```

## Commands Reference

See [COMMANDS.md](COMMANDS.md) for the full list of commands to manage SigNoz and the extension.

## Roadmap

- **Phase 1** ✅ — Baseline instrumentation (file, git, terminal watchers)
- **Phase 2** — Antigravity-specific tracing via CDP bridge
- **Phase 3** — AI postmortem report generation
- **Phase 4** — Sidebar webview UI

## License

TBD
