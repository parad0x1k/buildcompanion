# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

If you discover a security vulnerability in BuildCompanion for AWS CodeBuild, please report it **privately** rather than opening a public GitHub issue.

**How to report:**

1. Open a [GitHub Security Advisory](https://github.com/parad0x1k/buildcompanion/security/advisories/new) in this repository.
2. Provide a clear description of the vulnerability, steps to reproduce, and the potential impact.
3. You will receive an acknowledgement within **3 business days** and a resolution timeline within **14 business days** for confirmed vulnerabilities.

## Scope

This extension:
- Communicates exclusively with AWS services using credentials you provide.
- Does **not** transmit any data to third-party servers, **except** when you explicitly enable `codebuild.agentTools.enabled` (default **off**) to expose BuildCompanion's agent tools to a compatible AI agent (e.g. GitHub Copilot Chat agent mode) — in that case, tool call inputs/outputs (project names, build status, branch names) are sent to whichever chat model backend is configured for that chat session, like any other tool call. AWS credentials themselves never flow through agent tool input/output, regardless of this setting.
- Stores temporary AWS credentials only in VS Code Secret Storage (encrypted, never in plaintext files).
- Redacts sensitive identifiers (profile names, region, build IDs) from output logs by default.

## Out of Scope

- Vulnerabilities in AWS SDK dependencies that are not exploitable through this extension's surfaces.
- Issues requiring physical access to the user's machine or VS Code process.

## Compliance Notice

This extension is a community tool and has **not** been developed, tested, or validated against FIPS 140-2/140-3, FedRAMP, DoD IL4/5, CJIS, or ITAR control requirements. The `codebuild.useFipsEndpoint` setting routes AWS API requests to AWS FIPS-validated **service endpoints**, but the VS Code / Electron / Node.js runtime hosting this extension uses standard (non-validated) OpenSSL for client-side TLS. Users operating under a client-side FIPS mandate should not rely on this extension for regulated workloads.
