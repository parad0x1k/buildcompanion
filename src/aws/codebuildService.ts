import {
    BatchGetBuildsCommand,
    BatchGetProjectsCommand,
    ListBuildsCommand,
    ListBuildsForProjectCommand,
    ListProjectsCommand,
    RetryBuildCommand,
    StopBuildCommand,
    StartBuildCommand,
    UpdateProjectCommand,
    type Build,
    type EnvironmentVariableType
} from "@aws-sdk/client-codebuild";
import type * as vscode from "vscode";
import { createCodeBuildClient } from "./clientFactory";
import type { BuildHistoryEntry, BuildState, BuildStatus, Project } from "../state/store";
import { getUserFriendlyErrorMessage } from "./errorHandling";

export type ProjectEnvironmentVariable = {
    name: string;
    value: string;
    type: EnvironmentVariableType | "PLAINTEXT";
};

export type CodeBuildServiceOptions = {
    secretStorage?: vscode.SecretStorage;
    maxPageCount?: number;
    signal?: AbortSignal;
};

export type BuildLogsLocation = {
    buildId: string;
    projectName: string;
    status: BuildStatus;
    logGroupName?: string;
    logStreamName?: string;
};

const DEFAULT_BUILD_HISTORY_LIMIT = 20;
const DEFAULT_BUILD_HISTORY_MAX_PAGES = 20;
const STARTUP_ACTIVE_BUILDS_MIN_LIMIT = 20;
const STARTUP_ACTIVE_BUILDS_MAX_LIMIT = 50;
const STARTUP_ACTIVE_BUILDS_DEFAULT_LIMIT = 30;
const STARTUP_ACTIVE_BUILDS_MAX_PAGES = 10;
const BATCH_GET_BUILDS_MAX_IDS = 100;
const MAX_PROJECT_LIST_PAGES = 100;

export function isBuildInProgress(build: BuildState | null): boolean {
    return Boolean(build && build.status === "IN_PROGRESS");
}

export function isTerminalState(status: BuildStatus): boolean {
    return status !== "IN_PROGRESS";
}

function normalizeBuildStatus(status?: string): BuildStatus {
    switch (status) {
        case "SUCCEEDED":
            return "SUCCEEDED";
        case "FAILED":
            return "FAILED";
        case "STOPPED":
            return "STOPPED";
        case "FAULT":
            return "FAULT";
        case "TIMED_OUT":
            return "TIMED_OUT";
        case "IN_PROGRESS":
        default:
            // Treat queued/submitted/unknown states as in-progress for MVP state tracking.
            return "IN_PROGRESS";
    }
}

function toBuildState(build: Build, profile: string, region: string): BuildState | null {
    if (!build.id || !build.projectName) {
        return null;
    }

    return {
        id: build.id,
        projectName: build.projectName,
        status: normalizeBuildStatus(build.buildStatus),
        profile,
        region,
        startTime: build.startTime?.toISOString()
    };
}

function toBuildLogsLocation(build: Build): BuildLogsLocation | null {
    if (!build.id || !build.projectName) {
        return null;
    }

    return {
        buildId: build.id,
        projectName: build.projectName,
        status: normalizeBuildStatus(build.buildStatus),
        logGroupName: build.logs?.groupName,
        logStreamName: build.logs?.streamName
    };
}

function normalizeInitiator(initiator?: string): string {
    const normalized = initiator?.trim();
    if (!normalized) {
        return "unknown";
    }

    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? "unknown";
}

export function normalizeSourceVersion(sourceVersion?: string): string {
    const normalized = sourceVersion?.trim();
    return normalized && normalized.length > 0 ? normalized : "default";
}

function toBuildHistoryEntry(build: Build, profile: string, region: string): BuildHistoryEntry | null {
    if (!build.id || !build.projectName) {
        return null;
    }

    const startedAtMs = build.startTime?.getTime();
    const endedAtMs = build.endTime?.getTime();
    const hasDuration = startedAtMs !== undefined && endedAtMs !== undefined && endedAtMs >= startedAtMs;

    return {
        id: build.id,
        projectName: build.projectName,
        status: normalizeBuildStatus(build.buildStatus),
        profile,
        region,
        initiator: normalizeInitiator(build.initiator),
        sourceVersion: normalizeSourceVersion(build.sourceVersion),
        startedAt: build.startTime?.toISOString(),
        endedAt: build.endTime?.toISOString(),
        durationSeconds: hasDuration ? Math.round((endedAtMs - startedAtMs) / 1000) : undefined
    };
}

function toReadableError(error: unknown, context: {
    profile: string;
    region: string;
    operation: string;
    requiredPermissions?: string[];
}): Error {
    const message = getUserFriendlyErrorMessage(error, context);
    return new Error(`${message} (profile: ${context.profile}, region: ${context.region})`);
}

function validateScope(profile: string, region: string): void {
    if (!profile.trim()) {
        throw new Error("AWS profile is required");
    }

    if (!region.trim()) {
        throw new Error("AWS region is required");
    }
}

export async function listCodeBuildProjects(
    profile: string,
    region: string,
    options?: CodeBuildServiceOptions
): Promise<Project[]> {
    validateScope(profile, region);

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const projects: string[] = [];
        let nextToken: string | undefined;
        let pageCount = 0;

        do {
            const response = await client.send(new ListProjectsCommand({ nextToken }));
            projects.push(...(response.projects ?? []));
            nextToken = response.nextToken;
            pageCount += 1;
        } while (nextToken && pageCount < MAX_PROJECT_LIST_PAGES);

        return projects
            .sort((a, b) => a.localeCompare(b))
            .map((name) => ({ name }));
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Listing CodeBuild projects"
        });
    }
}

export async function startCodeBuild(
    profile: string,
    region: string,
    projectName: string,
    branch?: string,
    options?: CodeBuildServiceOptions
): Promise<BuildState> {
    validateScope(profile, region);

    const normalizedProjectName = projectName.trim();
    if (!normalizedProjectName) {
        throw new Error("Project name is required to start a build");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const normalizedBranch = branch?.trim();
        const response = await client.send(new StartBuildCommand({
            projectName: normalizedProjectName,
            sourceVersion: normalizedBranch ? normalizedBranch : undefined
        }));

        const buildState = response.build ? toBuildState(response.build, profile, region) : null;
        if (!buildState) {
            throw new Error("StartBuild did not return a valid build payload");
        }

        return buildState;
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Starting CodeBuild build"
        });
    }
}

export async function getBuildStatus(
    profile: string,
    region: string,
    buildId: string,
    options?: CodeBuildServiceOptions
): Promise<BuildState | null> {
    validateScope(profile, region);

    const normalizedBuildId = buildId.trim();
    if (!normalizedBuildId) {
        throw new Error("Build ID is required to fetch build status");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const response = await client.send(new BatchGetBuildsCommand({ ids: [normalizedBuildId] }), {
            abortSignal: options?.signal
        });
        const build = response.builds?.[0];
        if (!build) {
            return null;
        }

        return toBuildState(build, profile, region);
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Fetching build status"
        });
    }
}

export async function getBuildStatuses(
    profile: string,
    region: string,
    buildIds: string[],
    options?: CodeBuildServiceOptions
): Promise<Map<string, BuildState | null>> {
    validateScope(profile, region);

    const normalizedBuildIds = Array.from(new Set(
        buildIds
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
    ));

    const byBuildId = new Map<string, BuildState | null>();
    for (const buildId of normalizedBuildIds) {
        byBuildId.set(buildId, null);
    }

    if (normalizedBuildIds.length === 0) {
        return byBuildId;
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        for (let index = 0; index < normalizedBuildIds.length; index += BATCH_GET_BUILDS_MAX_IDS) {
            const ids = normalizedBuildIds.slice(index, index + BATCH_GET_BUILDS_MAX_IDS);
            const response = await client.send(new BatchGetBuildsCommand({ ids }));

            for (const build of response.builds ?? []) {
                const mapped = toBuildState(build, profile, region);
                if (!mapped) {
                    continue;
                }

                byBuildId.set(mapped.id, mapped);
            }
        }

        return byBuildId;
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Fetching build statuses"
        });
    }
}

export async function stopBuild(
    profile: string,
    region: string,
    buildId: string,
    options?: CodeBuildServiceOptions
): Promise<BuildState> {
    validateScope(profile, region);

    const normalizedBuildId = buildId.trim();
    if (!normalizedBuildId) {
        throw new Error("Build ID is required to stop a build");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const response = await client.send(new StopBuildCommand({ id: normalizedBuildId }));
        const stoppedBuild = response.build ? toBuildState(response.build, profile, region) : null;
        if (!stoppedBuild) {
            throw new Error("StopBuild did not return a valid build payload");
        }

        return stoppedBuild;
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Stopping CodeBuild build"
        });
    }
}

export async function getBuildLogsLocation(
    profile: string,
    region: string,
    buildId: string,
    options?: CodeBuildServiceOptions
): Promise<BuildLogsLocation | null> {
    validateScope(profile, region);

    const normalizedBuildId = buildId.trim();
    if (!normalizedBuildId) {
        throw new Error("Build ID is required to fetch build log location");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const response = await client.send(new BatchGetBuildsCommand({ ids: [normalizedBuildId] }), {
            abortSignal: options?.signal
        });
        const build = response.builds?.[0];
        if (!build) {
            return null;
        }

        return toBuildLogsLocation(build);
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Fetching build log location"
        });
    }
}

export async function getLatestBuildForProject(
    profile: string,
    region: string,
    projectName: string,
    options?: CodeBuildServiceOptions
): Promise<BuildState | null> {
    validateScope(profile, region);

    const normalizedProjectName = projectName.trim();
    if (!normalizedProjectName) {
        throw new Error("Project name is required to get latest build");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const listResponse = await client.send(new ListBuildsForProjectCommand({
            projectName: normalizedProjectName,
            sortOrder: "DESCENDING"
        }));

        const latestBuildId = listResponse.ids?.[0];
        if (!latestBuildId) {
            return null;
        }

        const statusResponse = await client.send(new BatchGetBuildsCommand({
            ids: [latestBuildId]
        }));

        const latestBuild = statusResponse.builds?.[0];
        if (!latestBuild) {
            return null;
        }

        return toBuildState(latestBuild, profile, region);
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Fetching latest build"
        });
    }
}

export async function listRecentActiveBuilds(
    profile: string,
    region: string,
    limit: number = STARTUP_ACTIVE_BUILDS_DEFAULT_LIMIT,
    options?: CodeBuildServiceOptions
): Promise<BuildState[]> {
    validateScope(profile, region);

    const normalizedLimit = Math.floor(Math.min(
        STARTUP_ACTIVE_BUILDS_MAX_LIMIT,
        Math.max(STARTUP_ACTIVE_BUILDS_MIN_LIMIT, limit)
    ));

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const recentBuildIds: string[] = [];
        let nextToken: string | undefined;
        let pageCount = 0;

        do {
            const recentBuildsResponse = await client.send(new ListBuildsCommand({
                sortOrder: "DESCENDING",
                nextToken
            }));

            const remaining = normalizedLimit - recentBuildIds.length;
            if (remaining > 0) {
                recentBuildIds.push(...(recentBuildsResponse.ids ?? []).slice(0, remaining));
            }

            nextToken = recentBuildsResponse.nextToken;
            pageCount += 1;
        } while (nextToken && recentBuildIds.length < normalizedLimit && pageCount < STARTUP_ACTIVE_BUILDS_MAX_PAGES);

        if (recentBuildIds.length === 0) {
            return [];
        }

        const detailsResponse = await client.send(new BatchGetBuildsCommand({ ids: recentBuildIds }));

        return (detailsResponse.builds ?? [])
            .map((build) => toBuildState(build, profile, region))
            .filter((build): build is BuildState => Boolean(build && build.status === "IN_PROGRESS"));
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Reconciling active builds"
        });
    }
}

export async function listRecentBuildHistoryForProject(
    profile: string,
    region: string,
    projectName: string,
    limit: number = DEFAULT_BUILD_HISTORY_LIMIT,
    options?: CodeBuildServiceOptions
): Promise<BuildHistoryEntry[]> {
    validateScope(profile, region);

    const normalizedProjectName = projectName.trim();
    if (!normalizedProjectName) {
        throw new Error("Project name is required to get build history");
    }

    const normalizedLimit = Math.max(1, limit);
    const normalizedMaxPages = Math.max(1, options?.maxPageCount ?? DEFAULT_BUILD_HISTORY_MAX_PAGES);

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const buildIds: string[] = [];
        let nextToken: string | undefined;
        let pageCount = 0;

        do {
            const listResponse = await client.send(new ListBuildsForProjectCommand({
                projectName: normalizedProjectName,
                sortOrder: "DESCENDING",
                nextToken
            }));

            const remaining = normalizedLimit - buildIds.length;
            if (remaining > 0) {
                buildIds.push(...(listResponse.ids ?? []).slice(0, remaining));
            }

            nextToken = listResponse.nextToken;
            pageCount += 1;
        } while (nextToken && buildIds.length < normalizedLimit && pageCount < normalizedMaxPages);

        const limitedBuildIds = buildIds.slice(0, normalizedLimit);
        if (limitedBuildIds.length === 0) {
            return [];
        }

        const detailsResponse = await client.send(new BatchGetBuildsCommand({ ids: limitedBuildIds }));
        const byId = new Map((detailsResponse.builds ?? [])
            .filter((build): build is Build => Boolean(build.id))
            .map((build) => [build.id as string, build]));

        return limitedBuildIds
            .map((id) => byId.get(id))
            .filter((build): build is Build => Boolean(build))
            .map((build) => toBuildHistoryEntry(build, profile, region))
            .filter((entry): entry is BuildHistoryEntry => Boolean(entry));
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Fetching build history"
        });
    }
}

export type RetryBuildResult = BuildState & { sourceVersion: string };

export async function retryBuild(
    profile: string,
    region: string,
    buildId: string,
    options?: CodeBuildServiceOptions
): Promise<RetryBuildResult> {
    validateScope(profile, region);

    const normalizedBuildId = buildId.trim();
    if (!normalizedBuildId) {
        throw new Error("Build ID is required to retry a build");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const response = await client.send(new RetryBuildCommand({ id: normalizedBuildId }), {
            abortSignal: options?.signal
        });

        const buildState = response.build ? toBuildState(response.build, profile, region) : null;
        if (!buildState) {
            throw new Error("RetryBuild did not return a valid build payload");
        }

        return {
            ...buildState,
            sourceVersion: normalizeSourceVersion(response.build?.sourceVersion)
        };
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Retrying build",
            requiredPermissions: ["codebuild:RetryBuild"]
        });
    }
}

export async function getProjectEnvironmentVariables(
    profile: string,
    region: string,
    projectName: string,
    options?: CodeBuildServiceOptions
): Promise<ProjectEnvironmentVariable[]> {
    validateScope(profile, region);

    const normalizedProjectName = projectName.trim();
    if (!normalizedProjectName) {
        throw new Error("Project name is required to read environment variables");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const response = await client.send(new BatchGetProjectsCommand({ names: [normalizedProjectName] }), {
            abortSignal: options?.signal
        });

        const project = response.projects?.[0];
        if (!project) {
            throw new Error(`Project '${normalizedProjectName}' was not found`);
        }

        return (project.environment?.environmentVariables ?? [])
            .filter((variable): variable is { name: string; value: string; type?: EnvironmentVariableType } => (
                Boolean(variable.name && variable.value !== undefined)
            ))
            .map((variable) => ({
                name: variable.name,
                value: variable.value,
                type: variable.type ?? "PLAINTEXT"
            }));
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Reading project environment variables",
            requiredPermissions: ["codebuild:BatchGetProjects"]
        });
    }
}

export async function setProjectEnvironmentVariables(
    profile: string,
    region: string,
    projectName: string,
    environmentVariables: ProjectEnvironmentVariable[],
    options?: CodeBuildServiceOptions
): Promise<void> {
    validateScope(profile, region);

    const normalizedProjectName = projectName.trim();
    if (!normalizedProjectName) {
        throw new Error("Project name is required to update environment variables");
    }

    try {
        const client = await createCodeBuildClient(profile, region, {
            secretStorage: options?.secretStorage
        });

        const existing = await client.send(new BatchGetProjectsCommand({ names: [normalizedProjectName] }), {
            abortSignal: options?.signal
        });

        const project = existing.projects?.[0];
        if (!project?.environment) {
            throw new Error(`Project '${normalizedProjectName}' was not found`);
        }

        // UpdateProject replaces the entire `environment` sub-object, so the existing
        // configuration (image, computeType, privilegedMode, etc.) must be preserved
        // and only `environmentVariables` swapped out.
        await client.send(new UpdateProjectCommand({
            name: normalizedProjectName,
            environment: {
                ...project.environment,
                environmentVariables: environmentVariables.map((variable) => ({
                    name: variable.name,
                    value: variable.value,
                    type: variable.type
                }))
            }
        }), {
            abortSignal: options?.signal
        });
    } catch (error) {
        throw toReadableError(error, {
            profile,
            region,
            operation: "Updating project environment variables",
            requiredPermissions: ["codebuild:BatchGetProjects", "codebuild:UpdateProject"]
        });
    }
}
