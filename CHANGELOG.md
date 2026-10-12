# Changelog

All notable changes to BuildCompanion for AWS CodeBuild are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Automated test suite (`@vscode/test-cli` + `@vscode/test-electron` + Mocha, with `aws-sdk-client-mock` for AWS SDK v3 boundaries) covering services, state, command wiring, and the new log viewer. Run with `npm test`; wired into CI (`.github/workflows/ci.yml`) via `xvfb-run -a npm test`. See [CONTRIBUTING.md](CONTRIBUTING.md#testing).
- `Retry Build` action (`codebuild.retryBuild`) on completed/historical build rows in Build History, using the CodeBuild `RetryBuild` API to restart a build with its original source version and the project's current configuration. Requires `codebuild:RetryBuild`. The confirmation prompt and the post-retry notification both show the branch/source version being retried, when known.
- Dedicated, scrollable per-build log viewer: `View Logs` now opens a read-only editor document (beside the current editor) instead of only the shared output channel. Updates are throttled (coalesced to at most one refresh every 300ms) and retention-capped (`codebuild.logsViewer.maxLines`, default 10000 lines) so very large log streams stay responsive. Closing the viewer tab stops that build's log stream.
- `Edit Environment Variables` action (settings/gear icon) on project rows: view, add, edit, and remove a CodeBuild project's configured environment variables through a guided picker flow, saved explicitly via `UpdateProject`. Requires `codebuild:BatchGetProjects` and `codebuild:UpdateProject`.
- Permission-denied error messages now name the specific IAM action(s) required for the failing operation when known (currently: retrying a build, and reading/updating project environment variables).
- New setting `codebuild.logsViewer.maxLines` controlling the per-build log viewer's line-retention cap.

### Changed
- `View Logs` no longer automatically shows/focuses the shared `BuildCompanion` output channel; logs still stream into it in the background for continuity, but the primary, focused surface is now the per-build log viewer document.

## [0.1.1] — 2026-09-22

### Changed
- Removed the `visual-studio-marketplace` version and installs README badges, which shields.io permanently retired (see [badges/shields#11792](https://github.com/badges/shields/pull/11792)); replaced with a static install link to the Marketplace listing.

## [0.1.0] — 2026-09-22

### Added
- Tree view with real-time CodeBuild project list, active build monitor, and build history per project
- Trigger builds with optional branch selection and git branch suggestions
- Cancel individual builds or all active builds in the current scope
- Batch deploy selected projects with configurable inter-build delay
- Stream CloudWatch Logs directly into a VS Code output channel
- AWS profile switching (INI profiles, environment credentials, temporary credentials via Secret Storage)
- AWS region switching with custom region support
- Auto-refresh polling with adaptive interval scaling by active build count
- Branch persistence per project/profile/region scope
- Queued build support: "Wait" for an in-progress build to complete before triggering a follow-up
- Temporary credential management: store short-lived access keys securely in VS Code Secret Storage
- Output channel log rotation with configurable maximum line count
- Verbose logging mode for debugging (redacts profile/region/build-id by default)
- Performance diagnostics logging (opt-in)
- `capabilities.untrustedWorkspaces` and `capabilities.virtualWorkspaces` declarations (`supported: false`) so VS Code restricted-mode and remote/virtual workspaces correctly disable the extension and surface the standard restricted-mode indicator (V11-001).
- `extensionKind: ["workspace"]` so VS Code Remote installs route the extension to the workspace side where AWS config files and `git` live (V11-002).
- Marketplace discovery metadata: `bugs`, `homepage`, `qna`, `markdown`, `galleryBanner`, `pricing: "Free"` (V11-003, V11-215).
- `vscode:prepublish`, `audit`, `audit:fix`, `package`, and `lint:repo` npm scripts for a one-shot pre-publish workflow (V11-030).
- Continuous Integration workflow (`.github/workflows/ci.yml`), Dependabot configuration (`.github/dependabot.yml`), and GitHub issue templates (V11-022, V11-023, V11-024, V11-220).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and a `.gitignore` covering build outputs, `.vsix` artefacts, audit reports, and OS metadata (V11-020, V11-021, V11-221, V11-222).
- README marketplace badges and a "Privacy & Telemetry" section confirming the extension makes no network calls outside AWS endpoints and collects no telemetry (V11-040, V11-224).
- `THIRD_PARTY_NOTICES.md` documenting the Apache-2.0 (`@aws-sdk/*`, `@smithy/*`, `@aws/lambda-invoke-store`) and MIT (`fast-deep-equal`) licensed dependencies bundled into the packaged `.vsix`.
- Output channel log sanitization (`sanitizeLogValue`) strips all C0 control characters and DEL, in addition to CR/LF/TAB, preventing log forging via ANSI escapes or terminal-rendering tricks in untrusted identifiers (V11-010).
- Recent-log-lines buffer and shared output channel are now disposed on `deactivate()` so module-scope state does not survive `Developer: Reload Window` invocations (V11-011).
- Unrecognised AWS SDK error names are now logged at `[ERROR]` (was `[INFO]`) so operators triaging failures see correlated diagnostics (V11-012).
- AWS client cache eviction loop hardened against future TS strict-mode regressions (V11-013).
