import * as vscode from "vscode";
import { listRecentBuildHistoryForProject } from "../../aws/codebuildService";
import { formatProjectScope } from "../../notifications/notifier";
import { buildErrorResult, toToolResult, validationError, type AgentToolResult } from "../types";

export interface ListRecentBuildsToolInput {
    profile: string;
    region: string;
    project_name: string;
    limit?: number;
}

type ListRecentBuildsSuccess = {
    profile: string;
    region: string;
    projectName: string;
    builds: Array<{
        buildId: string;
        status: string;
        sourceVersion: string;
        startedAt?: string;
        endedAt?: string;
        durationSeconds?: number;
    }>;
    /** True if more history may exist beyond what was returned (the result reached `limit`). */
    truncated: boolean;
};

const DEFAULT_LIMIT = 20;
// Matches CodeBuild's BatchGetBuilds "ids" field limit (see listRecentBuildHistoryForProject's
// own BATCH_GET_BUILDS_MAX_IDS chunking) - bounding here keeps a single tool call's AWS request
// fan-out and model-context size predictable regardless of what the agent asks for.
const MAX_LIMIT = 100;

/** Agent-callable, read-only "list recent build history for a project" tool. */
export class ListRecentBuildsTool implements vscode.LanguageModelTool<ListRecentBuildsToolInput> {
    public constructor(private readonly context: vscode.ExtensionContext) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListRecentBuildsToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { profile, region, project_name: projectName } = options.input;
        return {
            invocationMessage: `Fetching recent build history for ${formatProjectScope(projectName || "(missing project)", profile || null, region || "(missing region)")}`
        };
    }

    public async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListRecentBuildsToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return toToolResult(await this.run(options.input));
    }

    private async run(input: ListRecentBuildsToolInput): Promise<AgentToolResult<ListRecentBuildsSuccess>> {
        const profile = input.profile?.trim();
        const region = input.region?.trim();
        const projectName = input.project_name?.trim();

        if (!profile || !region || !projectName) {
            return validationError("profile, region, and project_name are required and must be non-empty.");
        }

        const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit as number) : DEFAULT_LIMIT;
        const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit));

        try {
            const history = await listRecentBuildHistoryForProject(profile, region, projectName, limit, {
                secretStorage: this.context.secrets
            });

            return {
                ok: true,
                profile,
                region,
                projectName,
                builds: history.map((entry) => ({
                    buildId: entry.id,
                    status: entry.status,
                    sourceVersion: entry.sourceVersion,
                    startedAt: entry.startedAt,
                    endedAt: entry.endedAt,
                    durationSeconds: entry.durationSeconds
                })),
                // A conservative heuristic, not an exact signal: hitting `limit` exactly might
                // mean there's more, or might mean there were exactly that many. Never silently
                // reports complete when it isn't certain.
                truncated: history.length >= limit
            };
        } catch (error) {
            return buildErrorResult(error, {
                profile,
                region,
                projectName,
                operation: "Fetching build history",
                requiredPermissions: ["codebuild:ListBuildsForProject", "codebuild:BatchGetBuilds"]
            });
        }
    }
}
