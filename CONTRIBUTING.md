# Contributing to Stuck

Thanks for considering contributing to stuck! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/ksploitx/stuck.git
cd stuck
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

### Local SigNoz

You need a local SigNoz instance for traces to land:

```bash
curl -fsSL https://signoz.io/foundry.sh | bash  # install foundryctl
foundryctl cast -f casting.yaml                  # deploy SigNoz
```

Open `http://localhost:8080` to verify it's running.

## Project Structure

- `src/` — all TypeScript source, one file per concern
- `src/webview/` — sidebar and panel webview providers
- `mockups/` — HTML mockups that define the target UI look
- `DESIGN.md` — visual design system tokens
- `SKILLS.md` — build workflow rules (read this before coding)

## Coding Conventions

- TypeScript with strict mode
- One file per concern (see `SKILLS.md` for the naming convention)
- All OTel spans go through the shared `otelEmitter.ts` — don't instantiate the SDK elsewhere
- Keep Antigravity-specific code in `cdpBridge.ts` behind feature checks
- No hardcoded secrets — use VS Code extension settings

## Making Changes

1. Read `SKILLS.md` before starting — it defines the workflow rules
2. Make your changes in a feature branch
3. Run `npm run compile` to verify the build
4. Test manually in the Extension Development Host (F5)
5. Open a PR with a description of what changed and how to verify it

## No Automated Tests (For Now)

The project uses manual verification, not automated tests. Each phase in `CHANGELOG.md` includes manual verification steps. Follow those patterns when adding new features.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat(instrumentation): add new watcher for X
fix(cdpBridge): handle disconnection during Y
docs: update README with Z
```
