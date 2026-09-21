# BuildCompanion for AWS CodeBuild

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/r3scue.codebuild-control-panel)](https://marketplace.visualstudio.com/items?itemName=r3scue.codebuild-control-panel)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/r3scue.codebuild-control-panel)](https://marketplace.visualstudio.com/items?itemName=r3scue.codebuild-control-panel)
[![CI](https://github.com/r3scue/codebuildcontrolpanel/actions/workflows/ci.yml/badge.svg)](https://github.com/r3scue/codebuildcontrolpanel/actions/workflows/ci.yml)

BuildCompanion is a native VS Code extension to trigger, monitor, and debug AWS CodeBuild projects directly from your editor.

> BuildCompanion is an independent, community-built open-source project. It is not affiliated with, endorsed by, or sponsored by Amazon Web Services (AWS). "AWS" and "CodeBuild" are trademarks of Amazon.com, Inc. or its affiliates.

## Privacy & Telemetry

This extension makes **no network calls outside the AWS endpoints implied by the active profile and region**. It collects **no telemetry** and ships **no analytics SDK**. The `telemetry.telemetryLevel` VS Code setting is respected by default (no-op since no telemetry is sent). All AWS credentials live in your local AWS configuration files or in VS Code's encrypted Secret Storage; they are never written to logs, never transmitted to third parties, and never persisted in plaintext.

## Compliance & FIPS Notice

This extension is a community tool and has **not** been developed, tested, or validated against FIPS 140-2/140-3, FedRAMP, DoD IL4/5, CJIS, or ITAR control requirements. The `codebuild.useFipsEndpoint` setting routes AWS API requests to AWS FIPS-validated **service endpoints** (e.g. `codebuild-fips.us-gov-west-1.amazonaws.com`), but the VS Code / Electron / Node.js runtime hosting this extension uses standard (non-validated) OpenSSL for client-side TLS. Users operating under a client-side FIPS mandate should not rely on this extension for regulated workloads.

## Documentation Map

- This README is focused on installation, daily workflows, and troubleshooting.
- For an exhaustive capability matrix (including niche and edge-case behavior), see [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md).

## Installation

### Option 1: Install from Marketplace

1. Open VS Code.
2. Open Extensions.
3. Search for "BuildCompanion for AWS CodeBuild".
4. Install and reload VS Code.

### Option 2: Install from VSIX

1. Open VS Code.
2. Open Extensions.
3. Select "Install from VSIX...".
4. Choose a package file such as `codebuild-control-panel-1.1.0.vsix`.
5. Reload VS Code.

## Requirements

- VS Code: `^1.85.0`
- Node.js: `>=20.0.0` (development only)
- AWS account access to CodeBuild and CloudWatch Logs
- One of the supported auth sources:

1. Local AWS profile (`~/.aws/config`, `~/.aws/credentials`)
2. AWS SSO profile
3. Environment credentials
4. Temporary credentials stored through extension command

### Minimum IAM Permissions

Grant enough permissions for the APIs used by the extension:

- `codebuild:ListProjects`
- `codebuild:ListBuilds`
- `codebuild:ListBuildsForProject`
- `codebuild:BatchGetBuilds`
- `codebuild:StartBuild`
- `codebuild:StopBuild`
- `logs:GetLogEvents`

## Quick Start

1. Open the BuildCompanion activity bar view.
2. Select an AWS profile.
3. Select an AWS region.
4. Refresh projects.
5. Trigger a build from a project row.
6. Monitor active builds and open logs from the same view.

## What This Extension Supports

- Profile discovery across local, SSO, environment, and temporary credentials.
- Region switching with persisted selection.
- CodeBuild project listing, trigger, status monitoring, cancel, and history.
- Build concurrency prompts (Wait, Trigger anyway, Cancel) with queue handling.
- Batch deployment for selected projects with per-project branch memory and fallback branch.
- CloudWatch log streaming with recoverable retry/backoff behavior.
- Failure summary extraction from recent log lines.
- Search and filtering of projects in TreeView.
- Scope-aware state for profile, region, branches, selections, queued items, and destructive-action blocks.
- Output channel logging with identifier redaction by default and configurable retention.

## Command Surface

All contributed commands are available through the Command Palette. Several are also available in the TreeView toolbar or context menus.

| Command ID | Title | Typical Location | Purpose |
| --- | --- | --- | --- |
| `codebuild.switchProfile` | Switch Profile | Settings row, Command Palette | Change active AWS profile |
| `codebuild.switchRegion` | Switch Region | Settings row, Command Palette | Change active AWS region |
| `codebuild.refresh` | Refresh | Toolbar, context menu, Command Palette | Reload profiles and projects |
| `codebuild.searchProjects` | Search Projects | Toolbar, Command Palette | Filter project list |
| `codebuild.clearProjectSearch` | Clear Project Search | Toolbar, Command Palette | Clear filter text |
| `codebuild.toggleAutoRefresh` | Toggle Auto-Refresh | Settings row, toolbar, Command Palette | Enable or disable build polling |
| `codebuild.setTemporaryCredentials` | Set AWS Credentials | Settings row, Command Palette | Store temporary credentials in SecretStorage |
| `codebuild.triggerBuild` | Trigger Build | Project inline action, context menu, Command Palette | Start build for a project |
| `codebuild.cancelBuild` | Cancel Build | Active build inline action, Command Palette | Stop a selected in-progress build |
| `codebuild.cancelAllBuilds` | Cancel All Builds | Toolbar, Command Palette | Cancel in-progress and queued operations in current scope |
| `codebuild.viewLogs` | View Logs | Build history inline action, Command Palette | Stream CloudWatch logs |
| `codebuild.selectAllProjects` | Select All Visible Projects | Toolbar (conditional), Command Palette | Select visible projects for batch deploy |
| `codebuild.deployAll` | Deploy Selected Projects | Toolbar, projects root context menu, Command Palette | Start sequential batch deployment |
| `codebuild.setBranch` | Set Branch | Project inline action, context menu, Command Palette | Save scoped branch mapping |
| `codebuild.clearAllBranches` | Clear All Saved Branches | Toolbar (conditional), Command Palette | Clear all saved branch mappings |
| `codebuild.openTerminal` | Open AWS Setup Terminal | Command Palette, setup message action | Open terminal for AWS CLI setup |

## Authentication and Region Behavior

### Profile Sources

The extension builds a merged profile list from:

1. `AWS_CONFIG_FILE` or `~/.aws/config`
2. `AWS_SHARED_CREDENTIALS_FILE` or `~/.aws/credentials`
3. Environment credentials (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`) as virtual profile `environment`
4. Temporary profiles remembered in VS Code SecretStorage

### Temporary Credentials

Use `Set AWS Credentials` to store:

- profile name
- access key ID
- secret access key
- optional session token
- ISO8601 expiration timestamp

Notes:

- Profile name `environment` is reserved.
- Existing non-temporary AWS profiles cannot be overwritten by temporary profile names.
- Expired, malformed, or incomplete temporary credentials are automatically purged and the extension falls back to standard provider resolution.

### Region Resolution

Default region order:

1. Persisted selection in VS Code global state
2. Selected profile region
3. `AWS_REGION` or `AWS_DEFAULT_REGION`
4. `us-east-1`

Supported regions are fixed in this version. See [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) for the full list.

## Daily Workflows

### Trigger a Single Build

1. Select profile and region.
2. Trigger build from a project.
3. Use saved branch, suggested Git branch, or manual branch input.
4. If another build is already in progress for the same project and scope, choose one:

- Wait (queue)
- Trigger anyway
- Cancel

### Deploy Selected Projects (Batch)

1. Select projects from the Projects section.
2. Run Deploy Selected Projects.
3. Provide delay in seconds (`>= 1`).
4. If some projects do not have saved branches, optionally provide a fallback branch.
5. Confirm deployment preview and start.

### View Logs and Failure Summary

1. Open logs from a history row or command.
2. Logs stream into the extension Output Channel.
3. For failed builds, a failure summary is extracted from recent log lines.

### Cancel Active Operations in Scope

`Cancel All Builds` for current profile and region performs scope-aware cancellation:

- cancels active batch deployment in scope
- removes queued Wait deployments in scope
- stops in-progress builds in scope
- leaves builds in other scopes untouched

## Monitoring and Notifications

- Active build polling is enabled by default.
- Adaptive polling can automatically increase poll interval when many builds are active.
- Completion notifications are shown for success, failure, timeout, fault, and stopped states.
- If auto-refresh is disabled, completion popups and queued Wait progression are paused.
- Stale in-progress builds (long-running) raise warning notifications.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `codebuild.monitor.adaptivePolling` | `true` | Increase polling interval with higher active-build count to reduce pressure |
| `codebuild.monitor.maxConcurrentStatusChecks` | `6` | Maximum parallel status-check concurrency (`1` to `20`) |
| `codebuild.performanceDiagnostics.enabled` | `false` | Emit periodic monitor performance diagnostics |
| `codebuild.logging.maxOutputLines` | `8000` | Output retention threshold; set `0` to disable automatic clearing |
| `codebuild.logging.verbose` | `false` | Disable identifier redaction in output logs |

## Security Notes

- Temporary credentials are stored in VS Code SecretStorage, not plaintext workspace files.
- Logs redact profile, region, and build identifiers by default unless verbose logging is enabled.
- Temporary credential entries are validated and purged when invalid or expired.

## Troubleshooting

### No profiles shown

- Run `aws configure` or `aws sso login`.
- Check `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` values.

### SSO session expired

- Reauthenticate with `aws sso login` for the active profile.

### Projects fail to refresh

- Confirm profile/region credentials and IAM permissions.
- Use Retry or Switch Profile when prompted.
- If refresh fails, destructive actions are blocked in that scope until profile switch.

### Queued builds do not start

- Ensure auto-refresh is enabled.

### Log stream unavailable

- Ensure CloudWatch Logs permissions are granted.
- Some builds may complete without available log stream metadata.

## Known Limitations

- Queue and selection state are in-memory only and are not persisted across extension reload.
- Build history is loaded lazily per project (on expand), not preloaded globally.
- Logs are output-channel based and not a custom full log viewer UI.
- Region list is fixed in this release.
- Only one batch deployment can be active at a time in the extension session.
- Git branch suggestions use the first workspace folder and may be limited in complex multi-root workspaces.

## Development

Install dependencies and compile:

```bash
npm install
npm run compile
```

Available scripts:

- `npm run compile`
- `npm run watch`
- `npm run test` (placeholder)
- `npm run audit:production`
- `npm run audit:production:json`
- `npm run audit:production:fix-dry-run`

## Additional Reference

For complete command/menu conditions, environment variable behavior, hard limits, retry/backoff details, and scope semantics, see [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md).

## License

MIT. See [LICENSE](LICENSE).
