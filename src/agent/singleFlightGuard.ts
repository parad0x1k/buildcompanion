/**
 * Per-(profile, region, projectName) single-flight guard for the agent-facing trigger tool,
 * modeled on the existing `activeBatchDeployment` singleton pattern in batchDeploy.ts. VS Code's
 * Language Model Tool API lets a user select "Always Allow" after the first confirmation, which
 * removes the per-call confirmation dialog for subsequent calls - so a tight agent loop (a
 * retry, a duplicate tool call in the same turn) must be guarded here rather than relying on the
 * platform's confirmation UI to prevent a double-trigger.
 */
const inFlightTriggers = new Set<string>();

function scopeKey(profile: string, region: string, projectName: string): string {
    return `${profile}\u0000${region}\u0000${projectName}`;
}

/** Marks (profile, region, projectName) busy and returns true, or returns false if already busy. */
export function tryAcquireTriggerLock(profile: string, region: string, projectName: string): boolean {
    const key = scopeKey(profile, region, projectName);
    if (inFlightTriggers.has(key)) {
        return false;
    }

    inFlightTriggers.add(key);
    return true;
}

export function releaseTriggerLock(profile: string, region: string, projectName: string): void {
    inFlightTriggers.delete(scopeKey(profile, region, projectName));
}
