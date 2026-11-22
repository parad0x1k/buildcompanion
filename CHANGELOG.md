# Changelog

All notable changes to BuildCompanion for AWS CodeBuild are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] — 2026-11-22

The first release since 0.1.1. It adds a dedicated build log panel, a Failed Builds view, build retry, build-scoped overrides and project configuration editing, and opt-in AI agent tools. It also fixes slow startup and region persistence. 0.2.0 was never published to the Marketplace, so its changes are included here.

> **Requires VS Code 1.95 or later** (was 1.85). 1.95 is the version that finalized the Language Model Tool API used by the new agent tools.

### Added

#### Build log panel
- **Build logs open in a dedicated panel.** `View Logs` opens each build's logs as a tab beside the editor. Each panel has a live status header, a line filter, Follow / Wrap / Errors-only toggles, colored error, warning and phase lines, and Full log, Copy, Pop out and Reload actions. **Pop out** moves the panel into its own floating window. Set `codebuild.logsViewer.openIn` to `"window"` to always open panels in a window. Closing a panel stops that build's log stream.
- When a build fails, the panel's final banner shows the extracted failure summary.
- Opening `View Logs` on a build that is still queued or provisioning waits for its first log output as long as the panel is open, and shows why it is waiting. If the project has CloudWatch logging disabled, the panel says so right away.
- **`View Full Log`** (`codebuild.viewFullLogs`) loads the complete log from the start of the CloudWatch stream. It is available as an inline action on Build History and Active Builds rows and from any open log panel. Pages fill in as they arrive, under a cancellable progress notification. The total is capped by `codebuild.logsViewer.maxFullLogLines` (default `50000`). Re-opening the full log of a build that was still running when it was fetched loads a fresh copy.
- Log output is cleaned up before display. ANSI color and cursor codes are removed, and carriage-return progress bars (e.g. from `docker pull`, `npm`, `pip`) are collapsed to their final line.
- New log panel settings:
  - `codebuild.logsViewer.maxLines` (default `10000`): how many lines a live panel keeps. Updates are batched to at most one refresh every 300 ms.
  - `codebuild.logsViewer.ttlMinutes` (default `15`): how long log lines stay in memory after a stream ends. Re-opening a build's logs within this window is instant. After it, an open panel offers a reload.
  - `codebuild.logsViewer.openIn` (default `"editor"`): open panels as editor tabs or in their own window.
  - `codebuild.logsViewer.mirrorToOutputChannel` (default `false`): also copy streamed log lines into the `BuildCompanion` output channel, as 0.1.x did.

#### Builds and projects
- **Failed Builds** tree section, below Build History. It lists builds that BuildCompanion started (Trigger Build, Retry Build, batch Deploy, or an auto-started queued "Wait" build) and that ended in `FAILED`, `FAULT` or `TIMED_OUT`. Builds started elsewhere (the AWS Console, CI/CD, an earlier VS Code session) don't appear, because AWS doesn't record where a build was started. Each row has `Retry Build`, `View Logs` and `Dismiss Failed Build` actions, and the toolbar has `Clear Failed Builds`. The list keeps the 10 most recent failures per profile and region, survives restarts, and clears a project's entries once its next build succeeds.
- **`Retry Build`** (`codebuild.retryBuild`) on Build History rows and on build failure notifications. It uses the CodeBuild `RetryBuild` API to re-run a build with its original source version and the project's current configuration. Requires `codebuild:RetryBuild`.
- **`Start Build with Overrides...`** (project right-click menu) starts one build with temporary overrides. You can override the branch, environment variables, compute type, environment type, image (with a browser for AWS-managed images), buildspec, privileged mode, image pull credentials and timeouts. Only the fields you change are sent, and nothing is saved to the project. A plain-English summary of the changes and a confirmation come before the build starts. Uses the same `codebuild:StartBuild` permission as a normal trigger.
- **`Edit Project Configuration...`** (project right-click menu) covers the same settings, but saves them permanently to the project with `UpdateProject`, leaving every other project setting unchanged. A confirmation states that all future builds will use the new values. Requires `codebuild:BatchGetProjects` and `codebuild:UpdateProject`.
- **`Edit Environment Variables`** (gear icon on project rows) lets you view, add, edit and remove a project's environment variables. Changes are saved only when you confirm. Types are shown as "Plain text", "Parameter Store" and "Secrets Manager" instead of raw AWS values. Requires `codebuild:BatchGetProjects` and `codebuild:UpdateProject`.
- **`Clear Project Selection`** unchecks every selected project in the current profile and region. It appears in the view toolbar and on the Projects header while anything is selected.
- Project search accepts comma-separated terms (e.g. `api,fe,middleware`). A project matches if its name contains any of the terms, ignoring case.
- Project checkboxes are shown on every visible project, including when a search narrows the list to a single match. You can build up a batch selection across several searches.
- New setting `codebuild.batchDeploy.maxSelectedProjects` (default `25`, range `1`–`100`) limits how many projects can be selected for a batch deploy. Going over the limit shows a warning, and the rejected checkbox reverts.
- Build completion notifications (success, stopped and failure) name the branch or source version that was built. Failure notifications include a `Retry Build` button.
- Build History rows show how long each build took (`took 4m 12s`), with a `Duration:` line in the tooltip. Failed Builds rows show how long the build ran before failing.
- Build statuses in the tree read as labels such as "In Progress" and "Timed Out" instead of raw AWS codes like `IN_PROGRESS`.
- Build times can be switched between local time and UTC from a new `Build Times: Local` / `Build Times: UTC` row in the Settings section (`codebuild.toggleBuildTimeDisplay`). Both modes show the time zone, and the choice is remembered.
- New setting `codebuild.localTimeZone`: an IANA time zone (e.g. `Europe/London`) to use for "Local" build times. Set it when the extension runs in a Dev Container, WSL or SSH remote whose clock is UTC. Without it, the Local/UTC toggle appears to do nothing there. The Build Times row explains this when it detects a remote session without an override.
- New setting `codebuild.monitor.pollIntervalMs` (default `5000`, range `3000`–`15000`): the base interval between active-build status checks. Raise it if your account hits CodeBuild API throttling.
- Permission-denied errors name the IAM action that is missing, where known (retrying a build, and reading or updating project environment variables).

#### AI agent tools (opt-in, off by default)
- Four VS Code Language Model Tools that AI agents such as GitHub Copilot Chat in agent mode can call once you turn on `codebuild.agentTools.enabled`:
  - `codebuild_trigger_build` starts a build for a project, optionally for a branch, tag or commit. It uses the profile and region selected in BuildCompanion unless the agent names others. It always asks you to confirm, naming the profile, region, project and branch. It refuses if your selection changes before the build starts. It won't start a second build while one is already running for the project. Overrides (image, buildspec, environment variables) are not available to agents; use `Start Build with Overrides...` for those.
  - `codebuild_list_projects`, `codebuild_get_build_status` (up to 100 build IDs per call) and `codebuild_list_recent_builds` (up to 100 results) are read-only.
- Profile names stay on your machine. When a tool uses your current selection, the model is told only the region, never the profile name. A profile named by the agent must be one BuildCompanion already knows, and the error for an unknown one doesn't list the profiles you have.
- Set `codebuild.agentTools.requireExplicitScopeForBuilds` to make agents always name both the profile and the region before triggering a build.
- Tools return structured JSON results, with error types for validation errors, permission denied (naming the missing IAM action), blocked actions and builds already in progress. Errors are redacted the same way as everywhere else in the extension.
- No new IAM permissions are needed. `iam:PassRole` is not used and should not be granted for this feature.
- These tools are off by default because turning them on is the first time BuildCompanion's data (project names, build status, branch names) can reach a third-party chat model. See [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) for the design, limits and permissions.

### Changed
- `View Logs` no longer copies log lines into the `BuildCompanion` output channel or focuses it. The log panel is where you read logs now. Failure summaries and streaming status still go to the output channel, and `codebuild.logsViewer.mirrorToOutputChannel` brings back the old copying.
- Default status polling is slower, to reduce CodeBuild API throttling. The base interval went from 3000 ms to 5000 ms, and with many active builds the adaptive back-off now goes up to 15000 ms (was 5000 ms).
- `Trigger Build`, `Retry Build` and `Start Build with Overrides...` send an idempotency token. A duplicate request within AWS's 5-minute window (a client retry or a double-clicked confirmation) starts one build instead of two.
- The AWS config and credentials file parser now handles quoted values (`region = "us-west-2"`) and indented continuation lines, such as a long `role_arn` wrapped onto the next line.
- The batch deploy confirmation lists projects as `•  api — main`, says `project default` for projects without a branch, describes the delay in words ("Builds start one at a time, 5s apart.") and uses proper singular and plural counts.
- Active-build elapsed times of an hour or more read `1h 15m 3s` instead of `75m 3s`.

### Performance
- The extension is now bundled with esbuild into one minified file. VS Code no longer loads over a thousand separate AWS SDK modules at activation, and the download is much smaller.
- Activation no longer waits for AWS. The tree view and all commands are available immediately, and profiles, projects and active builds fill in when discovery finishes. Before, a slow network or an SSO token refresh could leave the extension looking hung with no commands. A discovery failure now shows an error notification instead of leaving the extension unusable for the rest of the session.
- At startup, active-build reconciliation runs at the same time as the project listing instead of after it, saving one AWS round-trip.
- While no VS Code window is focused, active-build polling slows to a third of its normal rate (at most every 30 seconds). It polls immediately when focus returns. Open log panels keep streaming at full speed.
- Logging settings are read once and refreshed when they change, instead of on every log line.

### Fixed
- **The last-selected AWS region was not restored on startup.** The extension always started in `us-east-1`. It now reopens in the region you last used.
- Viewing logs for a build that stayed queued or provisioning for more than 2 minutes failed with a timeout. It now waits for as long as the log panel is open (see above).
- Log errors raised by BuildCompanion itself (e.g. "log stream is unavailable for this build") were replaced with a generic "check AWS configuration" message. They are now shown as written.
- AWS clients that expired from the internal cache were never closed, leaving their network connections open until they timed out. Several actions running at once (batch deploy, polling, parallel agent tool calls) could also each create their own client and leak all but one. Clients are now shared and closed properly.
- Branch suggestions showed a branch checked out in another git worktree as `+ name`. A `color.branch=always` git setting added color codes to every branch name. Both are fixed.
- An unexpected error in a background status check or in the notification's `Retry Build` action is now logged to the output channel instead of being lost.
- The README's VSIX install step referred to a filename that doesn't exist.

### Development
- Automated test suite (`@vscode/test-cli`, `@vscode/test-electron`, Mocha, `aws-sdk-client-mock`) run with `npm test` and in CI. See [CONTRIBUTING.md](CONTRIBUTING.md#testing).
- `vscode:prepublish` type-checks and builds the production bundle. The packaged VSIX no longer includes dev-only files.

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

[Unreleased]: https://github.com/parad0x1k/buildcompanion/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/parad0x1k/buildcompanion/compare/0.1.1...v0.2.1
[0.1.1]: https://github.com/parad0x1k/buildcompanion/releases/tag/0.1.1
