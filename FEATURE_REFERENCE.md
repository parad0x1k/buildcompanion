# BuildCompanion Feature Reference

This document is the exhaustive reference for supported behavior in the current extension implementation.

## Version Scope

- Extension package version: `1.0.0`
- VS Code engine target: `^1.110.0`
- Node engine target: `>=20.0.0`

## High-Level Capability Inventory

- AWS profile discovery: local, SSO, environment, temporary
- Region management with persisted selection
- CodeBuild project listing, trigger, cancel, status checks, latest build lookup
- Retry a past build (`RetryBuild`) reusing its original source version and the project's current configuration
- Active build monitoring with adaptive polling and completion notifications
- Wait-queue flow for project-level build concurrency conflicts
- Batch deployment for selected projects with delay and optional fallback branch
- Build history (lazy loaded per project)
- Dedicated per-build log viewer (read-only virtual editor document) with throttled updates and a configurable line-retention cap, in addition to the shared output channel
- One-shot "View Full Log" snapshot (`codebuild.viewFullLogs`) that paginates CloudWatch from the beginning of the stream into a second, unbounded read-only document, independent of the tailing viewer's line cap
- Log message sanitization: ANSI color/cursor escape codes are stripped and carriage-return progress-bar overwrites are collapsed before display, so colorized/progress-reporting build tool output renders as plain legible text instead of stray control characters
- CloudWatch log streaming with recoverable retry/backoff and failure summary extraction
- Human-readable build status labels in the tree view (e.g. `IN_PROGRESS` → "In Progress") with a generic title-case fallback for any unrecognized status
- Build timestamp Local/UTC display toggle (`codebuild.toggleBuildTimeDisplay`), persisted across sessions, with an explicit timezone abbreviation shown in both modes
- Project environment variable viewing and editing (`BatchGetProjects` / `UpdateProject`)
- "Start Build with Overrides" (`codebuild.startBuildWithOverrides`): one-time, build-scoped overrides (branch, environment variables, image, compute type, environment type, buildspec, privileged mode, image pull credentials, timeouts) sent via `StartBuild`'s `*Override` fields; nothing is written back to the project
- "Edit Project Configuration" (`codebuild.editProjectConfiguration`): the same curated setting categories as the override flow, but permanently saved to the project via `UpdateProject`, with an explicit "every future build will use these values" confirmation before saving
- AWS-managed build image browsing (`ListCuratedEnvironmentImages`) for a cascading Platform → Runtime → Image → Version picker, with a custom-image fallback for ECR/Docker Hub images
- Git branch suggestions and branch validation
- Scope-aware state (profile + region) for branches, selections, queues, and safety blocks
- Managed output channel logging with redaction and retention controls
- Permission-denied error messages that name the specific missing IAM action when known

## Architecture and Data Flow

- Store: central in-memory app state (`AppStore`)
- Commands: user interactions and workflows (`src/commands/index.ts`)
- AWS services: CodeBuild, CloudWatch Logs, credentials, profile and region handling
- Monitor: background polling and queued build progression
- UI: native TreeView provider (no webview)

## Commands and Registrations

### Contributed Command IDs

| Command ID | Title | Category |
| --- | --- | --- |
| `codebuild.switchProfile` | Switch Profile | BuildCompanion |
| `codebuild.switchRegion` | Switch Region | BuildCompanion |
| `codebuild.refresh` | Refresh | BuildCompanion |
| `codebuild.searchProjects` | Search Projects | BuildCompanion |
| `codebuild.clearProjectSearch` | Clear Project Search | BuildCompanion |
| `codebuild.toggleAutoRefresh` | Toggle Auto-Refresh | BuildCompanion |
| `codebuild.toggleBuildTimeDisplay` | Toggle Build Time Display (Local/UTC) | BuildCompanion |
| `codebuild.setTemporaryCredentials` | Set AWS Credentials | BuildCompanion |
| `codebuild.triggerBuild` | Trigger Build | BuildCompanion |
| `codebuild.startBuildWithOverrides` | Start Build with Overrides... | BuildCompanion |
| `codebuild.cancelBuild` | Cancel Build | BuildCompanion |
| `codebuild.cancelAllBuilds` | Cancel All Builds | BuildCompanion |
| `codebuild.viewLogs` | View Logs | BuildCompanion |
| `codebuild.viewFullLogs` | View Full Log | BuildCompanion |
| `codebuild.retryBuild` | Retry Build | BuildCompanion |
| `codebuild.editEnvironmentVariables` | Edit Environment Variables | BuildCompanion |
| `codebuild.editProjectConfiguration` | Edit Project Configuration... | BuildCompanion |
| `codebuild.selectAllProjects` | Select All Visible Projects | BuildCompanion |
| `codebuild.deployAll` | Deploy Selected Projects | BuildCompanion |
| `codebuild.setBranch` | Set Branch | BuildCompanion |
| `codebuild.clearAllBranches` | Clear All Saved Branches | BuildCompanion |
| `codebuild.openTerminal` | Open AWS Setup Terminal | BuildCompanion |

### Activation Events

- `onCommand:codebuild.switchProfile`
- `onCommand:codebuild.switchRegion`
- `onCommand:codebuild.refresh`
- `onCommand:codebuild.searchProjects`
- `onCommand:codebuild.clearProjectSearch`
- `onCommand:codebuild.toggleAutoRefresh`
- `onCommand:codebuild.toggleBuildTimeDisplay`
- `onCommand:codebuild.setTemporaryCredentials`
- `onCommand:codebuild.triggerBuild`
- `onCommand:codebuild.cancelBuild`
- `onCommand:codebuild.cancelAllBuilds`
- `onCommand:codebuild.viewLogs`
- `onCommand:codebuild.viewFullLogs`
- `onCommand:codebuild.selectAllProjects`
- `onCommand:codebuild.deployAll`
- `onCommand:codebuild.setBranch`
- `onCommand:codebuild.clearAllBranches`
- `onCommand:codebuild.openTerminal`
- `onView:codebuildView`

### Menu Visibility Rules

#### `view/item/context`

- `codebuild.triggerBuild`: `view == codebuildView && viewItem == project`
- `codebuild.setBranch`: `view == codebuildView && viewItem == project`
- `codebuild.startBuildWithOverrides`: `view == codebuildView && viewItem == project` (right-click menu only, no inline icon - kept out of the hover row to avoid icon clutter)
- `codebuild.editProjectConfiguration`: `view == codebuildView && viewItem == project` (right-click menu only, no inline icon, same reasoning)
- `codebuild.editEnvironmentVariables`: `view == codebuildView && viewItem == project`
- `codebuild.retryBuild`: `view == codebuildView && viewItem == build`
- `codebuild.viewLogs`: `view == codebuildView && viewItem == build`
- `codebuild.viewFullLogs`: `view == codebuildView && viewItem == build`
- `codebuild.viewLogs`: `view == codebuildView && viewItem == buildInProgress`
- `codebuild.viewFullLogs`: `view == codebuildView && viewItem == buildInProgress`
- `codebuild.cancelBuild`: `view == codebuildView && viewItem == buildInProgress`
- `codebuild.deployAll`: `view == codebuildView && viewItem == projectsRoot`

#### `editor/title`

- `codebuild.viewFullLogs`: `resourceScheme == codebuild-logs` — shown as a toolbar button on any open per-build log viewer tab (tailing or full), so the entire log can be loaded without going back to the tree.

#### `view/title` (toolbar)

- `codebuild.refresh`
- `codebuild.searchProjects`
- `codebuild.toggleAutoRefresh`
- `codebuild.clearProjectSearch`
- `codebuild.cancelAllBuilds`
- `codebuild.selectAllProjects` (only when `codebuild.canSelectMultipleProjects` is true)
- `codebuild.deployAll`
- `codebuild.clearAllBranches` (only when `codebuild.hasSavedBranches` is true)

## TreeView Structure and UI Behavior

Top-level sections:

- Settings
- Projects
- Active Builds
- Build History
- Failed Builds

### Settings Section

Rows:

- Profile (command: `codebuild.switchProfile`)
- Region (command: `codebuild.switchRegion`)
- Auto Refresh toggle (command: `codebuild.toggleAutoRefresh`)
- Build Times Local/UTC toggle, label `Build Times: Local` or `Build Times: UTC` (command: `codebuild.toggleBuildTimeDisplay`); defaults to `Local` and persists across sessions in `globalState` key `codebuild.buildTimeDisplayFormat`. "Local" is resolved via `Intl.DateTimeFormat` on the extension host process - in a remote/container session (`vscode.env.remoteName` set) with no `codebuild.localTimeZone` override, the row's tooltip explains that this is the remote machine's timezone, not necessarily the user's
- Credentials (command: `codebuild.setTemporaryCredentials`)

### Projects Section

- Displays selected count in section description when selection exists.
- Shows setup guidance if no profiles are configured.
- Shows `Open Terminal` setup action (`codebuild.openTerminal`) when no profiles exist.
- Displays `No CodeBuild projects found` when project list is empty.

Search behavior (`codebuild.searchProjects`):

- Accepts comma-separated terms (e.g. `api,fe,middleware`); a project matches if its name contains any one term (case-insensitive, OR semantics).
- Blank segments (e.g. a trailing comma) and duplicate terms are ignored; matching projects are never duplicated in results.

Checkbox behavior:

- Project checkboxes are shown for every currently visible project row, regardless of filter or result count, so narrowing a search down to a single match still allows selecting it into a batch.
- `Select All Visible Projects` remains available only when there is no filter, or the filter matches more than one project.
- Selection state is scoped by profile + region + project name.
- Selecting a project (via checkbox or Select All) beyond `codebuild.batchDeploy.maxSelectedProjects` is blocked with a warning notification; a rejected checkbox reverts to unchecked.

### Active Builds Section

- Displays elapsed duration in item label.
- Uses build `startTime` if available; otherwise falls back to first-seen timestamp in UI layer.
- Context value is `buildInProgress` only while status is `IN_PROGRESS` (internal value; unaffected by the human-readable status label shown in the description/tooltip).
- Status shown in the description and tooltip is a human-readable label (e.g. `In Progress`) via `formatBuildStatusLabel`, not the raw `IN_PROGRESS`-style AWS status code.

### Build History Section

- Project history groups are shown for visible projects.
- History is loaded lazily when a project history group is expanded.
- Loading state shows `Loading build history...`.
- Empty state shows `No build history found`.
- History row label format: `<sourceVersion> (<initiator>)`.
- Status shown in the tooltip is a human-readable label (e.g. `Succeeded`, `Timed Out`) via `formatBuildStatusLabel`.
- The completion time shown in the row description and tooltip (`Completed:`/`Failed:`/`Stopped:`/`Updated:`) honors the Local/UTC toggle and always includes an explicit timezone abbreviation (e.g. `IST`, `UTC`) so it's unambiguous which one is displayed.
- Completed and historical build rows also expose a `View Full Log` inline action (`codebuild.viewFullLogs`) alongside `Retry Build` and `View Logs`.

### Failed Builds Section

- Shows builds that BuildCompanion itself started (Trigger Build, Retry Build, batch Deploy, or an auto-started queued "Wait" build) and that ended in `FAILED`, `FAULT`, or `TIMED_OUT`.
- Builds already in progress before BuildCompanion started watching them (a previous VS Code session, the AWS Console, CI/CD, webhooks) are never attributed to the extension and will not appear here, since AWS has no "started via BuildCompanion" flag to query.
- Capped at the 10 most recent entries per profile + region scope (oldest trimmed first); persisted across VS Code restarts (`globalState`).
- An entry is automatically removed once that project's next build succeeds, regardless of how that later build was triggered.
- Each row exposes `Retry Build`, `View Logs`, and `Dismiss Failed Build` inline actions. A `Clear Failed Builds` toolbar button (shown only when the current scope has entries) clears the whole scoped list.
- Row label format: `<projectName> • <branch>`; description shows status and failure time (honoring the Local/UTC toggle).

## Authentication and Credential Handling

### Profile Discovery

Profile list is assembled from:

1. AWS config file (`AWS_CONFIG_FILE` or `~/.aws/config`)
2. AWS credentials file (`AWS_SHARED_CREDENTIALS_FILE` or `~/.aws/credentials`)
3. Environment credentials virtual profile `environment`
4. Temporary profiles tracked in SecretStorage

Profile type classification:

- `local`: default for config/credentials profiles without SSO keys
- `sso`: profile section contains `sso_start_url` or `sso_session`
- `environment`: virtual profile when both env keys exist
- `temporary`: profile registered from SecretStorage key index

### Temporary Credentials

Stored keys:

- profile payload key: `codebuild.tempCredentials.<profile>`
- profile index key: `codebuild.tempCredentials.profiles`

Validation and fallback behavior:

- Rejects empty profile names
- Rejects profile name `environment` (reserved)
- Rejects temporary profile names that conflict with existing non-temporary profiles
- Requires access key and secret key
- Requires future ISO8601 expiration
- On invalid/malformed/expired temporary payload, the record is purged and provider chain falls back

Credential resolution order (`resolveAwsCredentials`):

1. valid temporary credentials for selected profile
2. environment provider chain if profile is `environment`
3. `fromIni({ profile })` for named profiles
4. `fromNodeProviderChain()` when profile is empty

## Region Support and Resolution

Supported region set (fixed list):

- `us-east-1`
- `us-east-2`
- `us-west-1`
- `us-west-2`
- `eu-west-1`
- `eu-central-1`
- `ap-south-1`
- `ap-southeast-1`
- `ap-southeast-2`
- `ap-northeast-1`

Default region resolution order:

1. persisted region (`globalState` key `codebuild.currentRegion`)
2. selected profile region
3. `AWS_REGION` or `AWS_DEFAULT_REGION`
4. `us-east-1`

## CodeBuild Service Features

### Project and Build Operations

- List projects (`ListProjects`, paginated)
- Start build (`StartBuild`) with optional `sourceVersion` branch
- Retry build (`RetryBuild`) reusing an existing build's resolved source version and the project's current configuration
  - The confirmation prompt shows the branch/source version being retried when the originating row (e.g. a Build History entry) carries it; otherwise it falls back to a generic description.
  - The resolved source version from the `RetryBuild` response (normalized to `default` when none is set) is always shown in the post-retry notification, regardless of whether it was known beforehand.
  - A failed build's completion notification includes a `Retry Build` action button that invokes this exact same confirm-and-retry flow directly, without needing to open Build History.
- Stop build (`StopBuild`)
- Get one build status (`BatchGetBuilds`)
- Get many build statuses in chunks of up to 100 IDs
- Get latest build for project (`ListBuildsForProject` + `BatchGetBuilds`)
- Resolve CloudWatch log group/stream metadata from build details

### Project Environment Variable Management

- Read configured environment variables (`BatchGetProjects`): name, value, and type (`PLAINTEXT`, `PARAMETER_STORE`, or `SECRETS_MANAGER`); missing type is normalized to `PLAINTEXT`.
- Update environment variables (`BatchGetProjects` to fetch the current full `environment` configuration, then `UpdateProject`): since `UpdateProject` replaces the entire `environment` sub-object, every other field (image, compute type, privileged mode, registry credentials, etc.) is preserved unchanged and only `environmentVariables` is replaced.
- Edits are staged in memory (add/edit/remove) in a QuickPick-driven flow and only written to AWS when the user explicitly chooses "Save changes to AWS"; dismissing without saving discards all staged edits.
- Variable values are never written to the output channel log; only the count of updated variables is logged.

### Build Overrides and Project Configuration Editing

Both flows below share one QuickPick-driven "category hub" (`src/commands/projectConfigurationWizard.ts`) covering the same curated set of settings - environment variables, compute type, environment type, image, buildspec, privileged mode, image pull credentials, and build/queued timeouts - so the UI stays identical regardless of which mode is active. Fields with cross-field validation rules that are easy to break outside the AWS Console (VPC config, compute fleets, secondary sources, logs config, encryption key, tags, concurrency limit) are intentionally not exposed here.

- **Start Build with Overrides** (`codebuild.startBuildWithOverrides`): sends only the fields the user actually changed as `StartBuild` `*Override` parameters (`environmentVariablesOverride`, `imageOverride`, `computeTypeOverride`, `environmentTypeOverride`, `buildspecOverride`, `privilegedModeOverride`, `imagePullCredentialsTypeOverride`, `timeoutInMinutesOverride`, `queuedTimeoutInMinutesOverride`, plus `sourceVersion` for the branch). Any field left unchanged is omitted entirely, so CodeBuild falls back to the project's current saved value - nothing is ever written back to the project. If a build is already in progress, the user is offered "Start Anyway" (CodeBuild projects can run concurrent builds) rather than the queueing "Wait" flow used by `codebuild.triggerBuild`, since a queued override build would otherwise have no way to carry its overrides through to the later auto-start.
- **Edit Project Configuration** (`codebuild.editProjectConfiguration`): permanently saves the same category selections via `UpdateProjectConfiguration`/`UpdateProject`, using the same read-modify-write pattern as environment variable editing (only changed fields are merged in; everything else, including settings this editor doesn't expose, is preserved untouched).
- Both flows render a plain-English diff (e.g. `Compute type: Small -> Medium`) before any AWS call, and require an explicit modal confirmation worded differently per mode: the override flow's button reads "Start Build" with detail text clarifying the change is one-time only; the permanent flow's button reads "Update Project" with detail text stating every future build will use the new values.
- The image picker can browse the live AWS-managed catalog (`ListCuratedEnvironmentImages`) as a cascading Platform -> Runtime -> Image -> Version QuickPick, or accept a custom ECR/Docker Hub image URI.
- The buildspec picker offers the project's current buildspec (no-op), a repository-relative path, or browsing a local file whose contents are sent inline as the buildspec.
- Both commands are reachable only from the project's right-click context menu, not as additional inline hover icons, to avoid crowding the tree row.

### Build History

- History retrieval per project (`ListBuildsForProject` + `BatchGetBuilds`)
- Initiator normalization: last path segment from ARN-like strings
- Source version normalization: defaults to `default` when missing
- Duration computed from `endTime - startTime` in seconds
- Completed and historical build rows (`viewItem == build`) expose `Retry Build`, `View Logs`, and `View Full Log` inline actions

### Startup Build Reconciliation

- On initialization, recent active builds are loaded for selected scope.
- `initializeCommandState` requests up to 50 builds.
- Service clamps requested startup limit to range 20 to 50.
- Profile/project/active-build discovery runs in the background and does not block `activate()`: the tree view and all commands are registered and usable immediately, and the tree fills in once discovery completes (reactively, via the existing store refresh mechanism). A failure here surfaces as an error notification instead of leaving the view/commands unregistered.

## Monitoring, Polling, and Notifications

Monitor behavior is active only when:

- auto-refresh is enabled
- there is at least one active build

### Polling Defaults and Adaptive Logic

Constants:

- Base poll interval: 5000 ms (configurable via `codebuild.monitor.pollIntervalMs`)
- Min clamp: 3000 ms
- Max clamp: 15000 ms
- Polling error notification cooldown per build: 30000 ms
- Stale in-progress warning threshold: 2 hours

Adaptive interval (when enabled):

- active builds <= 2: base interval (default 5000 ms)
- active builds 3 to 8: base + 1000 ms (default 6000 ms)
- active builds 9 to 20: base + 3000 ms (default 8000 ms)
- active builds >= 21: max clamp (15000 ms)

Concurrency:

- Max concurrent status checks setting default: 6
- Setting clamp range: 1 to 20

Performance diagnostics:

- Optional monitor diagnostic log emitted every 10 ticks when enabled

### Completion Notifications

Completion status handling:

- `SUCCEEDED`: success notification
- `STOPPED`: warning notification
- `FAILED`, `FAULT`, `TIMED_OUT`: error notification with sound

All completion notifications include the branch/source version that was built (`using <branch>`, or `using default source version` when none was set). Failure notifications (`FAILED`, `FAULT`, `TIMED_OUT`) additionally include a `Retry Build` action button that re-runs the same confirm-and-retry flow as the Build History `Retry Build` inline action, without leaving the notification. When the failed build was started by BuildCompanion itself, it is also added to the Failed Builds section (see TreeView Structure above).

### Stale Build Warning

- Warning is emitted when an in-progress build exceeds 2 hours since `startTime`.
- Warning notifications are throttled by the same polling-error cooldown map.

## Build Concurrency, Queueing, and Scope Safety

When triggering a project with an existing in-progress build:

- Prompt actions: `Wait`, `Trigger anyway`, `Cancel`
- `Wait` creates or updates one pending build for the same project/profile/region scope

Queue details:

- Queue record type: `PendingBuild`
- Queue is in-memory only (not persisted)
- Pending build key semantics: one entry per project + profile + region

Cancellation fence behavior:

- Each scope has a numeric cancellation fence token
- Pending builds capture current fence token when queued
- `Cancel All` bumps scope fence token
- Monitor auto-start skips pending builds whose token no longer matches

## Batch Deployment

Batch mode (`codebuild.deployAll`) operates on selected projects in current scope.

### Guardrails and Limits

- Maximum selected projects per batch: configurable via `codebuild.batchDeploy.maxSelectedProjects` (default 25, absolute ceiling 100); enforced both when selecting projects (checkboxes/Select All) and when starting the deployment
- Minimum delay between triggers: 1000 ms
- Maximum delay between triggers: 60000 ms
- Cancellation check interval while waiting: 250 ms
- One active batch deployment at a time globally in extension session

### Workflow Details

- Requires one or more selected projects in current profile + region
- Prompts for delay in seconds (must be >= 1)
- Prompts for optional fallback branch if selected projects lack scoped branch values
- Shows preview `Project -> Branch` before confirmation
- Deduplicates project names before triggering
- Emits summary with started count, failed count, and cancelled state

### Cancellation Behavior

`Cancel All` in scope:

- cancels active batch deployment for that scope
- removes pending Wait queue entries in that scope
- stops all in-progress builds in that scope

## Branch Handling and Git Integration

### Branch Suggestions

- Uses `git branch --sort=-committerdate`
- Command timeout: 5000 ms
- Max output buffer: 64 KiB
- Default suggestion limit: 5
- Current branch is labeled `current` in picker
- If git fails or folder is not a repository, extension falls back to manual input

### Branch Validation Rules

Invalid when branch:

- is only whitespace
- contains spaces
- starts with `-` or `/`
- ends with `/` or `.`
- contains `..`, `//`, or `@{`
- contains any of these characters: `~`, `^`, `:`, `?`, `*`, `[` or `\\`
- includes `.lock` path segments (`.lock` or `.lock/`)

### Branch Persistence

- Branch mappings are scope-aware (project + profile + region).
- Legacy unscoped branch keys are still read as fallback.
- `Clear All Saved Branches` removes all mappings across all scopes.

## Log Streaming and Failure Extraction

### Per-Build Log Viewer

- `codebuild.viewLogs` opens a dedicated, read-only virtual document (`codebuild-logs:` URI scheme) in a new editor tab beside the current editor (`vscode.ViewColumn.Beside`), instead of only relying on the shared output channel.
- The document has no backing `FileSystemProvider`, so VS Code treats it as read-only automatically; it still supports scrolling, Find, minimap, and can be dragged into its own window like any editor tab.
- Streamed lines are pushed to the viewer once per CloudWatch poll response (not per line), which naturally batches bursts; additional internal throttling coalesces rapid updates into at most one document refresh every 300 ms.
- The viewer retains at most `codebuild.logsViewer.maxLines` lines (default `10000`, minimum `500`); once exceeded, the oldest lines are dropped and a truncation notice is shown.
- Re-opening logs for the same build resets the viewer to a fresh buffer; closing the viewer tab aborts that build's log stream (via `AbortController`) so no further CloudWatch API calls are made for it.
- The same log lines are still written to the shared `BuildCompanion` output channel (unchanged behavior); the output channel is no longer force-shown/focused when logs are opened.
- Before display (and before being written to the output channel), every log message is sanitized via `sanitizeLogMessageForDisplay`: ANSI color/cursor escape codes are stripped, carriage-return progress-bar overwrites (e.g. `docker pull`, `npm`, `pip` progress bars) are collapsed to their final rendered line, and any other stray C0 control character is dropped (tabs are preserved). This prevents colorized/progress-reporting build tool output from rendering as unreadable control-character glyphs.

### Full Log Snapshot (`codebuild.viewFullLogs`)

- Available as an editor-title toolbar button on any open per-build log viewer tab (`resourceScheme == codebuild-logs`), and as a `View Full Log` inline action on Build History / Active Builds rows; resolves its target build either from the tree selection or from the currently active log viewer tab's stored header metadata.
- Opens a second, independent read-only document (same `codebuild-logs:` scheme, distinguished by a `.full.log` path suffix) so the original tailing viewer is left untouched — the default "tail" viewing experience is unchanged.
- Fetches the build's entire available CloudWatch log history from the beginning (`GetLogEvents` with `startFromHead: true`), paginating until it catches up to the latest data, instead of only the recent tail. For a still-running build this returns a snapshot of everything emitted so far (it does not keep polling for new data afterward).
- Runs under a cancellable `vscode.window.withProgress` notification that reports cumulative lines fetched; the viewer document fills in incrementally as each page arrives rather than appearing only once the fetch completes.
- This document is unbounded: unlike the tailing viewer, it is not subject to `codebuild.logsViewer.maxLines`. Instead, the fetch itself is capped at `codebuild.logsViewer.maxFullLogLines` (default `50000`, minimum `1000`) as a safety limit; if reached, the footer explicitly states the log was truncated and names the setting to increase.
- The header of a full-log document is marked `BuildCompanion — Build Logs (Full Log)` with an additional `Mode:` line, so it's visually distinguishable from the tailing viewer's header.

Log streaming (`streamBuildLogs`) details:

- Stream key: `<profile>:<region>:<buildId>`
- Starting a stream for the same key cancels prior active stream
- `stopActiveLogStream()` cancels all active streams

Defaults and limits:

- Poll interval default: 2500 ms
- Poll interval clamp: 2000 to 3000 ms
- Max empty polls default: 4
- Recent line buffer default: 500 lines
- Recent line buffer clamp: 50 to 500
- Log location wait timeout default: 120000 ms
- Log location timeout minimum: 5000 ms
- Max recoverable polling errors: 5
- Max recoverable backoff: 10000 ms
- Additional retry jitter: up to 250 ms

Recoverable poll error classes include:

- throttling / too many requests
- request timeout / timeout error
- networking error
- service unavailable

Failure summary extraction:

- For failed builds only
- Uses recent log buffer
- Up to 5 summary lines
- Summary is provided via callback and output channel logs

## Build History Behavior

- Build history is loaded only when expanding a project under Build History.
- Command layer requests up to 20 entries per project.
- Store applies `CODEBUILD_HISTORY_MAX_ENTRIES` clamp (10 to 20, default 20).
- History loaded state is tracked per project/profile/region scope.

## Search and Selection Behavior

Project filter:

- Case-insensitive substring match on project names
- Filter is stored as trimmed text

Select-all behavior:

- Enabled when no filter is active and at least one project is visible
- Also enabled when filter is active and at least two projects are visible
- Disabled for single-project filtered result

Selection persistence:

- Selection state is in-memory and scope-aware
- `refresh` clears all current selections

## Scope Safety and Destructive Action Blocks

Refresh error protection:

- If project refresh fails for a scope, that scope is blocked for destructive actions
- Block reason is stored per scope
- Trigger / cancel / deploy commands in blocked scope prompt `Switch Profile` or `Cancel`
- Successful refresh clears block for the scope

## Output Channel and Logging

Channel:

- Name: `BuildCompanion`

Redaction behavior (`codebuild.logging.verbose`):

- default `false`: redacts profile, region, build ID identifiers
- `true`: shows raw values

Output retention (`codebuild.logging.maxOutputLines`):

- default: 8000
- minimum non-zero: 1000
- value `0`: disables automatic clearing
- when threshold exceeded, channel clears and retains most recent 50% (minimum retained 200 lines)

Log section prefixes:

- `[INFO]`
- `[ERROR]`
- named sections used by command/service layers, for example `[BUILD]`, `[BATCH]`, `[LOGS]`, `[CANCEL]`, `[HISTORY]`, `[REFRESH]`, `[PERF]`, `[SETTINGS]`

## Error Mapping and User-Friendly Messages

Mapped error classes include:

- SSO expired session
- invalid credentials
- permission denied
- invalid region / endpoint

Fallback behavior:

- With operation context: `<operation> failed. Please check AWS configuration and try again.`
- Without context: `AWS operation failed. Please check AWS configuration and try again.`

Required-permission detail:

- Call sites may supply `requiredPermissions: string[]` (IAM action names) alongside the error context.
- When an error is classified as permission denied, the mapped message appends `Required IAM permission(s): <list>` so the user knows exactly what to grant, without needing to inspect the raw AWS error.
- Currently supplied for: retrying a build (`codebuild:RetryBuild`), reading project environment variables (`codebuild:BatchGetProjects`), updating project environment variables (`codebuild:BatchGetProjects`, `codebuild:UpdateProject`), reading the curated project configuration (`codebuild:BatchGetProjects`), permanently updating project configuration (`codebuild:BatchGetProjects`, `codebuild:UpdateProject`), and browsing AWS-managed build images (`codebuild:ListCuratedEnvironmentImages`). Starting a build with overrides uses the same `codebuild:StartBuild` permission as a normal trigger - no additional IAM action is required for the Tier-1 override fields.

No-profile message:

- `No AWS profiles found. Run 'aws configure' or 'aws sso login'`

## Settings Reference

| Setting | Type | Default | Range | Behavior |
| --- | --- | --- | --- | --- |
| `codebuild.monitor.adaptivePolling` | boolean | `true` | n/a | Adaptive interval scaling by active build count |
| `codebuild.monitor.pollIntervalMs` | integer | `5000` | `3000..15000` | Base interval between active-build status checks |
| `codebuild.monitor.maxConcurrentStatusChecks` | integer | `6` | `1..20` | Max parallel status polling checks |
| `codebuild.performanceDiagnostics.enabled` | boolean | `false` | n/a | Periodic monitor performance logs |
| `codebuild.logging.maxOutputLines` | integer | `8000` | `0` or `>=1000` | Output history truncation threshold |
| `codebuild.logging.verbose` | boolean | `false` | n/a | Redaction toggle for identifiers |
| `codebuild.logsViewer.maxLines` | integer | `10000` | `>=500` | Per-build log viewer line-retention cap before truncation |
| `codebuild.logsViewer.maxFullLogLines` | integer | `50000` | `>=1000` | Safety cap on total lines fetched by "View Full Log" |
| `codebuild.batchDeploy.maxSelectedProjects` | integer | `25` | `1..100` | Maximum projects selectable at once for a batch deployment |
| `codebuild.localTimeZone` | string | `""` | valid IANA zone or empty | Overrides auto-detected system timezone used for the "Local" build time display; falls back to auto-detect on empty/invalid value |

## Environment Variable Reference

| Variable | Used For | Behavior |
| --- | --- | --- |
| `AWS_CONFIG_FILE` | profile discovery | Overrides default config file path |
| `AWS_SHARED_CREDENTIALS_FILE` | profile discovery | Overrides default credentials file path |
| `AWS_ACCESS_KEY_ID` | environment profile detection | Requires secret key pair to create virtual profile |
| `AWS_SECRET_ACCESS_KEY` | environment profile detection | Requires access key pair to create virtual profile |
| `AWS_REGION` | region fallback | Used when persisted/profile region not set |
| `AWS_DEFAULT_REGION` | region fallback | Secondary fallback before `us-east-1` |
| `CODEBUILD_HISTORY_MAX_ENTRIES` | history retention in store | Clamped to `10..20`, default `20` |

## Hard Limits and Constants

| Area | Constant | Value |
| --- | --- | --- |
| Batch deploy | max selected projects (default, configurable) | 25 |
| Batch deploy | max selected projects (absolute ceiling) | 100 |
| Failed Builds | max retained entries per profile+region scope | 10 |
| Batch deploy | min delay | 1000 ms |
| Batch deploy | max delay | 60000 ms |
| Batch deploy | cancellation check interval | 250 ms |
| Monitor | default poll interval (configurable) | 5000 ms |
| Monitor | poll interval bounds | 3000 to 15000 ms |
| Monitor | stale build warning age | 2 hours |
| Monitor | polling error notification cooldown | 30000 ms |
| Monitor | default max concurrent checks | 6 |
| Monitor | max concurrent checks bounds | 1 to 20 |
| Monitor | diagnostics cadence | every 10 ticks |
| Logs | default poll interval | 2500 ms |
| Logs | poll interval bounds | 2000 to 3000 ms |
| Logs | max empty polls | 4 |
| Logs | default recent-line buffer | 500 |
| Logs | recent-line buffer bounds | 50 to 500 |
| Logs | default log-location timeout | 120000 ms |
| Logs | max recoverable poll errors | 5 |
| Logs | max recoverable backoff | 10000 ms |
| CodeBuild API | batch status lookup size | 100 build IDs per call |
| Startup reconcile | active build request bounds | 20 to 50 |
| Startup reconcile | max pages | 10 |
| History service | default history limit parameter | 5 |
| History service | default max pages | 20 |
| Command history loader | per-project request limit | 20 |
| Log viewer | default line-retention cap | 10000 lines |
| Log viewer | minimum configurable line-retention cap | 500 lines |
| Log viewer | update-throttle window | 300 ms |

## Persistence Model

### Persisted in VS Code global state

- current region (`codebuild.currentRegion`)

### Persisted in VS Code SecretStorage

- temporary credential payloads
- temporary profile-name index

### In-memory only (lost on reload)

- active builds
- queued pending builds
- destructive-action block map
- scope cancellation fences
- selected project checkboxes
- project branch mappings
- loaded project list
- build history cache

## Known Limitations

- Queue, selections, and cached state are session-memory only.
- Region support is fixed to the built-in list in this release.
- Logs are presented in output channel format (no custom interactive viewer).
- Git branch suggestions rely on first workspace folder path and local git availability.
- Extension scope is AWS CodeBuild; no CodePipeline-specific command surface.
- "Start Build with Overrides" and "Edit Project Configuration" intentionally expose only a curated Tier-1 field set (see above); settings like VPC config, compute fleets, secondary sources, logs config, encryption key, tags, and concurrency limit are not editable from BuildCompanion and must be changed in the AWS Console.
- Overridden/edited values are not remembered between invocations (each run starts from the project's current saved configuration); only the branch field persists across invocations, via the same per-scope branch memory used by `codebuild.triggerBuild`/`codebuild.setBranch`.

## Source Index

Primary implementation files for this reference:

- `package.json`
- `src/extension.ts`
- `src/commands/index.ts`
- `src/commands/projectConfigurationWizard.ts`
- `src/commands/startBuildWithOverrides.ts`
- `src/commands/editProjectConfiguration.ts`
- `src/state/store.ts`
- `src/ui/treeDataProvider.ts`
- `src/monitor/buildMonitor.ts`
- `src/aws/profileManager.ts`
- `src/aws/credentials.ts`
- `src/aws/regionManager.ts`
- `src/aws/codebuildService.ts`
- `src/aws/logsService.ts`
- `src/aws/batchTriggerManager.ts`
- `src/aws/errorHandling.ts`
- `src/git/gitService.ts`
- `src/logging/outputChannelManager.ts`
