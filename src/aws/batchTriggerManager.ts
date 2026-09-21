import { startCodeBuild, type CodeBuildServiceOptions } from "./codebuildService";
import { getUserFriendlyErrorMessage } from "./errorHandling";
import type { BuildState } from "../state/store";
import { logError, logInfo, logSection, sanitizeLogValue } from "../logging/outputChannelManager";

export type BatchTriggerProject = {
    projectName: string;
    branch?: string;
};

export type BatchTriggerRequest = {
    projects: BatchTriggerProject[];
    profile: string;
    region: string;
    delayMs: number;
    isCancelled?: () => boolean;
    onBuildTriggered?: (details: { projectName: string; branch?: string; buildId: string; build: BuildState }) => void;
};

export type BatchTriggerResult = {
    successfulBuilds: BuildState[];
    failedProjects: Array<{ projectName: string; error: string }>;
    cancelled: boolean;
};

export const MAX_BATCH_SELECTED_PROJECTS = 25;
export const MIN_BATCH_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const CANCEL_CHECK_INTERVAL_MS = 250;

function formatSanitizedScope(profile: string, region: string): string {
    return `${sanitizeLogValue(profile, "profile")} (${sanitizeLogValue(region, "region")})`;
}

function sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

async function sleepWithCancellation(delayMs: number, isCancelled?: () => boolean): Promise<boolean> {
    if (delayMs <= 0) {
        return isCancelled?.() === true;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < delayMs) {
        if (isCancelled?.() === true) {
            return true;
        }

        const remaining = delayMs - (Date.now() - startedAt);
        await sleep(Math.min(CANCEL_CHECK_INTERVAL_MS, Math.max(1, remaining)));
    }

    return isCancelled?.() === true;
}

export async function triggerBuildBatch(
    request: BatchTriggerRequest,
    options?: CodeBuildServiceOptions
): Promise<BatchTriggerResult> {
    const profile = request.profile.trim();
    const region = request.region.trim();
    const seenProjects = new Set<string>();
    const projects: BatchTriggerProject[] = [];

    for (const requestProject of request.projects) {
        const normalizedProjectName = requestProject.projectName.trim();
        if (!normalizedProjectName || seenProjects.has(normalizedProjectName)) {
            continue;
        }

        seenProjects.add(normalizedProjectName);
        const normalizedBranch = requestProject.branch?.trim();
        projects.push({
            projectName: normalizedProjectName,
            branch: normalizedBranch && normalizedBranch.length > 0 ? normalizedBranch : undefined
        });
    }

    const requestedDelayMs = Number.isFinite(request.delayMs)
        ? Math.round(request.delayMs)
        : MIN_BATCH_DELAY_MS;
    const normalizedDelayMs = Math.min(Math.max(MIN_BATCH_DELAY_MS, requestedDelayMs), MAX_DELAY_MS);
    const sanitizedScope = formatSanitizedScope(profile, region);

    if (!profile) {
        throw new Error("AWS profile is required for batch deployment");
    }

    if (!region) {
        throw new Error("AWS region is required for batch deployment");
    }

    if (projects.length > MAX_BATCH_SELECTED_PROJECTS) {
        throw new Error(`Batch deployment supports at most ${MAX_BATCH_SELECTED_PROJECTS} selected projects per request`);
    }

    if (projects.length === 0) {
        return {
            successfulBuilds: [],
            failedProjects: [],
            cancelled: false
        };
    }

    logSection("[BATCH] Deployment Start");
    logInfo(`[BATCH] Starting batch deployment for ${projects.length} projects in ${sanitizedScope}`);

    const successfulBuilds: BuildState[] = [];
    const failedProjects: Array<{ projectName: string; error: string }> = [];
    let cancelled = false;

    for (let index = 0; index < projects.length; index += 1) {
        if (request.isCancelled?.() === true) {
            cancelled = true;
            logInfo(`[BATCH] Batch deployment cancelled in ${sanitizedScope}.`);
            break;
        }

        const project = projects[index];
        const sanitizedProjectName = sanitizeLogValue(project.projectName);
        const branchLabel = project.branch ? sanitizeLogValue(project.branch) : "default source version";
        logInfo(`[BATCH] Triggering build ${index + 1}/${projects.length}: ${sanitizedProjectName} in ${sanitizedScope} using ${branchLabel}`);

        try {
            const startedBuild = await startCodeBuild(
                profile,
                region,
                project.projectName,
                project.branch,
                { secretStorage: options?.secretStorage }
            );

            successfulBuilds.push(startedBuild);
            try {
                request.onBuildTriggered?.({
                    projectName: project.projectName,
                    branch: project.branch,
                    buildId: startedBuild.id,
                    build: startedBuild
                });
            } catch (callbackError) {
                logError(
                    `[BATCH] onBuildTriggered callback threw for ${sanitizedProjectName} in ${sanitizedScope}: ${sanitizeLogValue(String(callbackError))}`
                );
            }
            logInfo(
                `[BATCH] Started build for ${sanitizedProjectName} in ${sanitizedScope}: ${sanitizeLogValue(startedBuild.id, "buildId")}`
            );
        } catch (error) {
            const message = getUserFriendlyErrorMessage(error, {
                profile,
                region,
                operation: `Batch trigger for ${project.projectName}`
            });

            failedProjects.push({ projectName: project.projectName, error: message });
            logError(`[BATCH] Failed to start ${sanitizedProjectName} in ${sanitizedScope}: ${sanitizeLogValue(message)}`);
        }

        if (normalizedDelayMs > 0 && index < projects.length - 1) {
            logInfo(`[BATCH] Waiting ${Math.round(normalizedDelayMs / 1000)} seconds before next build in ${sanitizedScope}...`);
            const cancelledDuringDelay = await sleepWithCancellation(normalizedDelayMs, request.isCancelled);
            if (cancelledDuringDelay) {
                cancelled = true;
                logInfo(`[BATCH] Batch deployment cancelled during delay window in ${sanitizedScope}.`);
                break;
            }
        }
    }

    logInfo(
        `[BATCH] Batch deployment complete in ${sanitizedScope}. Success: ${successfulBuilds.length}, Failed: ${failedProjects.length}, Cancelled: ${cancelled}`
    );

    return {
        successfulBuilds,
        failedProjects,
        cancelled
    };
}
