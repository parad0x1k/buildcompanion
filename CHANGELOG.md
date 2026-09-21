# Changelog

All notable changes to BuildCompanion for AWS CodeBuild are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Renamed the product/display branding from "CodeBuild Control Panel" to "BuildCompanion for AWS CodeBuild" to avoid implying an official AWS-provided extension. This updates `displayName`, the activity bar/view titles, the settings section title, the command palette category, and the output channel name. The extension identifier (`r3scue.codebuild-control-panel`), all command IDs, configuration keys, and stored state keys are unchanged for backward compatibility.

## [1.1.0] — 2026-05-01

### Added
- `capabilities.untrustedWorkspaces` and `capabilities.virtualWorkspaces` declarations (`supported: false`) so VS Code restricted-mode and remote/virtual workspaces correctly disable the extension and surface the standard restricted-mode indicator (V11-001).
- `extensionKind: ["workspace"]` so VS Code Remote installs route the extension to the workspace side where AWS config files and `git` live (V11-002).
- Marketplace discovery metadata: `bugs`, `homepage`, `qna`, `markdown`, `galleryBanner`, `pricing: "Free"` (V11-003, V11-215).
- `vscode:prepublish`, `audit`, `audit:fix`, `package`, and `lint:repo` npm scripts for a one-shot pre-publish workflow (V11-030).
- Continuous Integration workflow (`.github/workflows/ci.yml`), Dependabot configuration (`.github/dependabot.yml`), and GitHub issue templates (V11-022, V11-023, V11-024, V11-220).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and a `.gitignore` covering build outputs, `.vsix` artefacts, audit reports, and OS metadata (V11-020, V11-021, V11-221, V11-222).
- README marketplace badges and a "Privacy & Telemetry" section confirming the extension makes no network calls outside AWS endpoints and collects no telemetry (V11-040, V11-224).

### Changed
- Lowered `engines.vscode` floor from `^1.110.0` to `^1.85.0` (and matching `@types/vscode`) to widen the installable user base. No 1.110-only API is in use (V11-210).
- `npm run package` now bundles production dependencies into the `.vsix` (dropped `--no-dependencies`) so the published extension activates correctly on user machines (V11-201).
- `SECURITY.md` supported-versions table updated for the 1.1.x release line (V11-225).
- Repository `repository.url` normalised to canonical `git+https://...git` form (V11-004).

### Security
- Output channel `sanitizeLogValue` now strips all C0 control characters and DEL (in addition to CR/LF/TAB), preventing log forging via ANSI escapes or terminal-rendering tricks in untrusted identifiers (V11-010).
- Recent-log-lines buffer and shared output channel are now disposed on `deactivate()` so module-scope state does not survive `Developer: Reload Window` invocations (V11-011).
- Unrecognised AWS SDK error names are now logged at `[ERROR]` (was `[INFO]`) so operators triaging failures see correlated diagnostics (V11-012).
- AWS client cache eviction loop hardened against future TS strict-mode regressions (V11-013).

### Removed
- Stale `.vsix` artefacts at the repo root, the dead-stub root `extension.ts`, unused `resources/` image variants, and committed audit/dependency JSON reports (V11-207, V11-208, V11-211, V11-212).

## [1.0.0] — 2026-04-30

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
