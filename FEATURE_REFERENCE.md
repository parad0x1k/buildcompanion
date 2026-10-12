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
- CloudWatch log streaming with recoverable retry/backoff and failure summary extraction
- Project environment variable viewing and editing (`BatchGetProjects` / `UpdateProject`)
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
| `codebuild.setTemporaryCredentials` | Set AWS Credentials | BuildCompanion |
| `codebuild.triggerBuild` | Trigger Build | BuildCompanion |
| `codebuild.cancelBuild` | Cancel Build | BuildCompanion |
| `codebuild.cancelAllBuilds` | Cancel All Builds | BuildCompanion |
| `codebuild.viewLogs` | View Logs | BuildCompanion |
| `codebuild.retryBuild` | Retry Build | BuildCompanion |
| `codebuild.editEnvironmentVariables` | Edit Environment Variables | BuildCompanion |
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
- `onCommand:codebuild.setTemporaryCredentials`
- `onCommand:codebuild.triggerBuild`
- `onCommand:codebuild.cancelBuild`
- `onCommand:codebuild.cancelAllBuilds`
- `onCommand:codebuild.viewLogs`
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
- `codebuild.editEnvironmentVariables`: `view == codebuildView && viewItem == project`
- `codebuild.retryBuild`: `view == codebuildView && viewItem == build`
- `codebuild.viewLogs`: `view == codebuildView && viewItem == build`
- `codebuild.cancelBuild`: `view == codebuildView && viewItem == buildInProgress`
- `codebuild.deployAll`: `view == codebuildView && viewItem == projectsRoot`

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

### Settings Section

Rows:

- Profile (command: `codebuild.switchProfile`)
- Region (command: `codebuild.switchRegion`)
- Auto Refresh toggle (command: `codebuild.toggleAutoRefresh`)
- Credentials (command: `codebuild.setTemporaryCredentials`)

### Projects Section

- Displays selected count in section description when selection exists.
- Shows setup guidance if no profiles are configured.
- Shows `Open Terminal` setup action (`codebuild.openTerminal`) when no profiles exist.
- Displays `No CodeBuild projects found` when project list is empty.

Checkbox behavior:

- Project checkboxes are shown when there is no filter, or filter result count is greater than 1.
- Project checkboxes are hidden when filtered list has exactly one project.
- Selection state is scoped by profile + region + project name.

### Active Builds Section

- Displays elapsed duration in item label.
- Uses build `startTime` if available; otherwise falls back to first-seen timestamp in UI layer.
- Context value is `buildInProgress` only while status is `IN_PROGRESS`.

### Build History Section

- Project history groups are shown for visible projects.
- History is loaded lazily when a project history group is expanded.
- Loading state shows `Loading build history...`.
- Empty state shows `No build history found`.
- History row label format: `<sourceVersion> (<initiator>)`.

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

### Build History

- History retrieval per project (`ListBuildsForProject` + `BatchGetBuilds`)
- Initiator normalization: last path segment from ARN-like strings
- Source version normalization: defaults to `default` when missing
- Duration computed from `endTime - startTime` in seconds
- Completed and historical build rows (`viewItem == build`) expose both `Retry Build` and `View Logs` inline actions

### Startup Build Reconciliation

- On initialization, recent active builds are loaded for selected scope.
- `initializeCommandState` requests up to 50 builds.
- Service clamps requested startup limit to range 20 to 50.

## Monitoring, Polling, and Notifications

Monitor behavior is active only when:

- auto-refresh is enabled
- there is at least one active build

### Polling Defaults and Adaptive Logic

Constants:

- Base poll interval: 3000 ms
- Min clamp: 2000 ms
- Max clamp: 5000 ms
- Polling error notification cooldown per build: 30000 ms
- Stale in-progress warning threshold: 2 hours

Adaptive interval (when enabled):

- active builds <= 2: 3000 ms
- active builds 3 to 8: 3500 ms
- active builds 9 to 20: 4000 ms
- active builds >= 21: 5000 ms

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

- Maximum selected projects per batch: 25
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
- Currently supplied for: retrying a build (`codebuild:RetryBuild`), reading project environment variables (`codebuild:BatchGetProjects`), and updating project environment variables (`codebuild:BatchGetProjects`, `codebuild:UpdateProject`).

No-profile message:

- `No AWS profiles found. Run 'aws configure' or 'aws sso login'`

## Settings Reference

| Setting | Type | Default | Range | Behavior |
| --- | --- | --- | --- | --- |
| `codebuild.monitor.adaptivePolling` | boolean | `true` | n/a | Adaptive interval scaling by active build count |
| `codebuild.monitor.maxConcurrentStatusChecks` | integer | `6` | `1..20` | Max parallel status polling checks |
| `codebuild.performanceDiagnostics.enabled` | boolean | `false` | n/a | Periodic monitor performance logs |
| `codebuild.logging.maxOutputLines` | integer | `8000` | `0` or `>=1000` | Output history truncation threshold |
| `codebuild.logging.verbose` | boolean | `false` | n/a | Redaction toggle for identifiers |
| `codebuild.logsViewer.maxLines` | integer | `10000` | `>=500` | Per-build log viewer line-retention cap before truncation |

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
| Batch deploy | max selected projects | 25 |
| Batch deploy | min delay | 1000 ms |
| Batch deploy | max delay | 60000 ms |
| Batch deploy | cancellation check interval | 250 ms |
| Monitor | default poll interval | 3000 ms |
| Monitor | poll interval bounds | 2000 to 5000 ms |
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

## Source Index

Primary implementation files for this reference:

- `package.json`
- `src/extension.ts`
- `src/commands/index.ts`
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
