import * as vscode from "vscode";
import { getBuildStatuses } from "../../aws/codebuildService";
import { formatScope } from "../../notifications/notifier";
import { buildErrorResult, toToolResult, validationError, type AgentToolResult } from "../types";

export interface GetBuildStatusToolInput {
    profile: string;
    region: string;
    build_ids: string[];
}

type BuildStatusEntry =
    | { buildId: string; found: true; status: string; projectName: string; sourceVersion?: string; startTime?: string }
    | { buildId: string; found: false };

type GetBuildStatusSuccess = {
    profile: string;
    region: string;
    builds: BuildStatusEntry[];
};

// Matches CodeBuild's BatchGetBuilds "ids" field limit (verified against the current AWS API
// reference - see getBuildStatuses/BATCH_GET_BUILDS_MAX_IDS). getBuildStatuses already chunks
// internally, but this tool still bounds its own input so one call can't silently fan out into
// dozens of AWS requests.
const MAX_BUILD_IDS_PER_CALL = 100;

/** Agent-callable, read-only "get build status" tool for one or more build IDs. */
export class GetBuildStatusTool implements vscode.LanguageModelTool<GetBuildStatusToolInput> {
    public constructor(private readonly context: vscode.ExtensionContext) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetBuildStatusToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const count = options.input.build_ids?.length ?? 0;
        return {
            invocationMessage: `Fetching status for ${count} build(s) in ${formatScope(options.input.profile || null, options.input.region || "(missing region)")}`
        };
    }

    public async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetBuildStatusToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return toToolResult(await this.run(options.input));
    }

    private async run(input: GetBuildStatusToolInput): Promise<AgentToolResult<GetBuildStatusSuccess>> {
        const profile = input.profile?.trim();
        const region = input.region?.trim();
        const buildIds = (input.build_ids ?? [])
            .map((id) => id?.trim())
            .filter((id): id is string => Boolean(id));

        if (!profile || !region) {
            return validationError("profile and region are required and must be non-empty.");
        }

        if (buildIds.length === 0) {
            return validationError("build_ids must contain at least one non-empty build ID.");
        }

        if (buildIds.length > MAX_BUILD_IDS_PER_CALL) {
            return validationError(`build_ids supports at most ${MAX_BUILD_IDS_PER_CALL} IDs per call.`);
        }

        try {
            const statuses = await getBuildStatuses(profile, region, buildIds, { secretStorage: this.context.secrets });

            const builds: BuildStatusEntry[] = buildIds.map((buildId) => {
                const build = statuses.get(buildId);
                if (!build) {
                    return { buildId, found: false };
                }

                return {
                    buildId,
                    found: true,
                    status: build.status,
                    projectName: build.projectName,
                    sourceVersion: build.sourceVersion,
                    startTime: build.startTime
                };
            });

            return { ok: true, profile, region, builds };
        } catch (error) {
            return buildErrorResult(error, {
                profile,
                region,
                operation: "Fetching build statuses",
                requiredPermissions: ["codebuild:BatchGetBuilds"]
            });
        }
    }
}
