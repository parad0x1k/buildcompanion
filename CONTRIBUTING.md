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
git clone https://github.com/parad0x1k/buildcompanion.git
cd buildcompanion
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
| `npm test` | Compile, then run the automated test suite |
| `npm run audit` | Production dependency audit (moderate or higher) |
| `npm run package` | Produce a `.vsix` via `vsce` |

## Testing

Tests run inside a real VS Code Extension Development Host (downloaded automatically by
`@vscode/test-electron` on first run) using Mocha, via `@vscode/test-cli`. This gives test code full
access to the real `vscode` API — there is no need to mock it.

```powershell
npm test
```

This runs `pretest` (`npm run compile`) and then executes every `*.test.js` file compiled from
`src/test/suite/*.test.ts`, per the `.vscode-test.mjs` config at the repo root.

What is covered:

- Pure logic: `src/commands/shared.ts` validators/formatters, `src/aws/errorExtractor.ts`,
  `src/aws/errorHandling.ts`, `src/aws/regionManager.ts`, `src/state/store.ts`.
- AWS-facing services (`src/aws/codebuildService.ts`, `src/aws/batchTriggerManager.ts`), mocked at the
  SDK client boundary with [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) —
  no real AWS calls, no real credentials needed.
- `src/git/gitService.ts` against real temporary git repositories (and the "not a repository" fallback
  path); skips gracefully if `git` is unavailable on the machine running the tests.
- `src/ui/buildLogsViewer.ts`'s update-throttling and line-retention-cap behavior directly.
- Command registration: `registerCodeBuildCommands` is exercised against a fake
  `vscode.ExtensionContext`, with `src/aws/profileManager.ts` and `src/aws/codebuildService.ts` stubbed via
  Sinon so activation never touches the host machine's real AWS configuration or network.

Conventions when adding tests:

- Add new `*.test.ts` files under `src/test/suite/`. Non-test helpers (not matched by the test glob) live
  directly under `src/test/`, e.g. `testHelpers.ts` (fake `ExtensionContext`/`Memento`/`SecretStorage`) and
  `awsMocks.ts` (shared `aws-sdk-client-mock` client stubs).
- Reuse the shared mocks in `src/test/awsMocks.ts` instead of calling `mockClient(...)` again on the same
  client class in a new file — Sinon throws if the same method is stubbed twice without an intervening
  `.restore()`, and every `*.test.js` file is loaded before any test runs.
- Reset mocks/stubs in `beforeEach`, not `after`, so failures in one test don't leak into the next.

CI (`.github/workflows/ci.yml`) runs the same suite headlessly via `xvfb-run -a npm test` on
`ubuntu-latest` (Xvfb ships preinstalled on GitHub-hosted Ubuntu runners).

## Branching and Pull Requests

- Branch from `main`.
- One topic per PR; keep diffs reviewable.
- Reference the related issue in the PR body.
- The CI workflow (`.github/workflows/ci.yml`) must pass: install, compile, test, audit.
- Add a CHANGELOG entry under `[Unreleased]` for any user-observable change.

## Reporting Security Issues

Do **not** open a public issue for security findings. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Code Style

The codebase uses TypeScript strict mode (`tsconfig.json` sets `"strict": true`). There is no separate ESLint configuration today; the type-checker is the source of truth. When adding code:

- Prefer `readonly` and immutable updates over in-place mutation of state objects.
- Route every user-facing or operator-facing log through `outputChannelManager` (`logInfo` / `logError` / `logSection`). Do not use `console.*`.
- Sanitize identifiers in logs with `sanitizeLogValue(value, kind)` so verbose-off mode redacts profile/region/buildId by default.
- Wrap AWS SDK call sites in `getUserFriendlyErrorMessage(error, context)` so users see actionable messages. Pass `context.requiredPermissions` (an array of IAM action strings, e.g. `["codebuild:RetryBuild"]`) for any operation where a permission-denied failure should tell the user exactly which permission to request.
- Never log the literal value of a credential, secret, or project environment variable — even in verbose mode. Log counts or names only when necessary.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating you agree to abide by it.
