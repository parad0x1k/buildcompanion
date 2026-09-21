## Summary

<!-- What does this PR change, and why? -->

## Related Issue

<!-- Link the issue this PR addresses. New features must have an issue first (see CONTRIBUTING.md). -->

Closes #

## Type of Change

- [ ] Bug fix
- [ ] New feature (issue already discussed/agreed)
- [ ] Documentation
- [ ] Chore / internal refactor

## Checklist

- [ ] No regression: existing happy-path behavior is unchanged, or the change is explicitly called out.
- [ ] No telemetry or new outbound network calls introduced.
- [ ] No dynamic code execution (`eval`, `Function()`), and any `child_process` use is `execFile` with a fixed argv.
- [ ] AWS credentials are never logged, including in verbose mode.
- [ ] Logs go through `outputChannelManager` (`logInfo` / `logError` / `logSection`), not `console.*`.
- [ ] `npm run compile` and `npm run audit` pass locally.
- [ ] Added a `CHANGELOG.md` entry under `[Unreleased]` for any user-observable change.
