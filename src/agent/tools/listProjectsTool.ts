import * as vscode from "vscode";
import { listCodeBuildProjects } from "../../aws/codebuildService";
import { formatScope } from "../../notifications/notifier";
import { buildErrorResult, toToolResult, validationError, type AgentToolResult } from "../types";

export interface ListProjectsToolInput {
    profile: string;
    region: string;
}

type ListProjectsSuccess = {
    profile: string;
    region: string;
    projects: Array<{ name: string }>;
};

/** Agent-callable, read-only "list CodeBuild projects" tool. No destructive-action gate needed. */
export class ListProjectsTool implements vscode.LanguageModelTool<ListProjectsToolInput> {
    public constructor(private readonly context: vscode.ExtensionContext) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListProjectsToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Listing CodeBuild projects in ${formatScope(options.input.profile || null, options.input.region || "(missing region)")}`
            // Read-only: no confirmationMessages, unlike the mutating trigger_build tool.
        };
    }

    public async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListProjectsToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return toToolResult(await this.run(options.input));
    }

    private async run(input: ListProjectsToolInput): Promise<AgentToolResult<ListProjectsSuccess>> {
        const profile = input.profile?.trim();
        const region = input.region?.trim();

        if (!profile || !region) {
            return validationError("profile and region are required and must be non-empty.");
        }

        try {
            const projects = await listCodeBuildProjects(profile, region, { secretStorage: this.context.secrets });
            return {
                ok: true,
                profile,
                region,
                projects: projects.map((project) => ({ name: project.name }))
            };
        } catch (error) {
            return buildErrorResult(error, {
                profile,
                region,
                operation: "Listing projects",
                requiredPermissions: ["codebuild:ListProjects"]
            });
        }
    }
}
