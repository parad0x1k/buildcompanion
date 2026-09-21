# Contributing to BuildCompanion for AWS CodeBuild

Thanks for your interest in contributing! This project is a focused VS Code extension for AWS CodeBuild operations, and we keep changes small, well-scoped, and regression-free.

## Ground Rules

1. **No regression.** Existing user-observable behaviour in the happy path must not change unless a release explicitly notes the change.
2. **No new features without an issue.** Open a feature request first so scope and security implications are agreed.
3. **No telemetry.** The extension makes zero outbound network calls outside the AWS endpoints the user has configured. Do not introduce analytics.
4. **No dynamic code execution.** No `eval`, no `Function()`, no `child_process` with shell. All `child_process` use must be `execFile` with a fixed argv.
5. **Credentials never leak.** AWS credentials must remain in `vscode.SecretStorage` or in the user's AWS config files. Never log a credential value, even in verbose mode.

## Development Setup

Prerequisites:

- Node.js `>=20.0.0`
- VS Code `^1.85.0`
- An AWS account you can safely test against (a sandbox or dev account is recommended)

Bootstrap:

```powershell
git clone https://github.com/r3scue/codebuildcontrolpanel.git
cd codebuildcontrolpanel
npm install
npm run compile
```

Run the extension in a VS Code Extension Development Host:

1. Open the folder in VS Code.
2. Press `F5` (uses the `.vscode/launch.json` configuration).
3. The Development Host opens with the extension loaded; the BuildCompanion activity bar icon should be visible.

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run compile` | TypeScript build to `out/` |
| `npm run watch` | TypeScript build in watch mode |
| `npm run lint:repo` | Type-check only, no emit |
| `npm run audit` | Production dependency audit (moderate or higher) |
| `npm run package` | Produce a `.vsix` via `vsce` |

## Branching and Pull Requests

- Branch from `main`.
- One topic per PR; keep diffs reviewable.
- Reference the related issue in the PR body.
- The CI workflow (`.github/workflows/ci.yml`) must pass: install, compile, audit.
- Add a CHANGELOG entry under `[Unreleased]` for any user-observable change.

## Reporting Security Issues

Do **not** open a public issue for security findings. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Code Style

The codebase uses TypeScript strict mode (`tsconfig.json` sets `"strict": true`). There is no separate ESLint configuration today; the type-checker is the source of truth. When adding code:

- Prefer `readonly` and immutable updates over in-place mutation of state objects.
- Route every user-facing or operator-facing log through `outputChannelManager` (`logInfo` / `logError` / `logSection`). Do not use `console.*`.
- Sanitize identifiers in logs with `sanitizeLogValue(value, kind)` so verbose-off mode redacts profile/region/buildId by default.
- Wrap AWS SDK call sites in `getUserFriendlyErrorMessage(error, context)` so users see actionable messages.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating you agree to abide by it.
