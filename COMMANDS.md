# Commands Reference

Quick reference for managing the **stuck** development environment.

---

## SigNoz (Local Observability Backend)

SigNoz runs as Docker containers via Foundry. The compose file lives at `pours/deployment/compose.yaml`.

### Start SigNoz
```bash
foundryctl cast -f casting.yaml
```

### Stop SigNoz (keeps data)
```bash
docker compose -f pours/deployment/compose.yaml -p signoz stop
```

### Start again after stopping
```bash
docker compose -f pours/deployment/compose.yaml -p signoz start
```

### Destroy SigNoz (deletes all data and volumes)
```bash
docker compose -f pours/deployment/compose.yaml -p signoz down -v
```

### Check container status
```bash
docker compose -f pours/deployment/compose.yaml -p signoz ps
```

### View collector logs
```bash
docker logs signoz-ingester-1 --tail 50 -f
```

### Ports
| Service | URL |
|---|---|
| SigNoz UI | `http://localhost:8080` |
| OTLP HTTP (traces) | `http://localhost:4318` |
| OTLP gRPC (traces) | `localhost:4317` |

### Test that OTLP is accepting data
```bash
curl -s -X POST http://localhost:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}'
# Expected: {"partialSuccess":{}}
```

---

## VS Code Extension

### Compile
```bash
npm run compile
```

### Watch mode (auto-recompile on save)
```bash
npm run watch
```

### Launch Extension Development Host
Press **F5** in VS Code (uses `.vscode/launch.json`).

A second VS Code window opens with the extension loaded. Perform actions there (file saves, terminal commands, git commits) to generate traces.

### Stop the Extension Development Host
- Press **Shift+F5** in the main VS Code window, or
- Click the red stop ⏹ button in the debug toolbar, or
- Close the Extension Development Host window

---

## Typical Workflow

1. `foundryctl cast -f casting.yaml` — start SigNoz
2. Open `http://localhost:8080` — verify SigNoz UI is up
3. Press **F5** — launch the extension
4. Do things in the Extension Development Host window
5. Check traces in SigNoz at `http://localhost:8080` → Traces
6. **Shift+F5** — stop the extension when done testing
7. `docker compose -f pours/deployment/compose.yaml -p signoz stop` — stop SigNoz when done for the day
