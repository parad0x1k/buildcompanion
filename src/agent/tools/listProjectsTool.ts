import * as vscode from "vscode";
import { listCodeBuildProjects } from "../../aws/codebuildService";
import type { AppStore } from "../../state/store";
import { describeScopeForModel, formatScopeForUser, isAgentToolError, resolveAgentScope } from "../scope";
import { buildErrorResult, toToolResult, type AgentToolResult } from "../types";

export interface ListProjectsToolInput {
    profile?: string;
    region?: string;
}

type ListProjectsSuccess = {
    profile?: string;
    region: string;
    usedCurrentSelection: boolean;
    projects: Array<{ name: string }>;
};

/** Agent-callable, read-only "list CodeBuild projects" tool. No destructive-action gate needed. */
export class ListProjectsTool implements vscode.LanguageModelTool<ListProjectsToolInput> {
    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly store: AppStore
    ) {}

    public async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ListProjectsToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const scope = resolveAgentScope(this.store, options.input);
        return {
            invocationMessage: isAgentToolError(scope)
                ? "Listing CodeBuild projects"
                : `Listing CodeBuild projects (${formatScopeForUser(scope)})`
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
        const scope = resolveAgentScope(this.store, input);
        if (isAgentToolError(scope)) {
            return scope;
        }

        try {
            const projects = await listCodeBuildProjects(scope.profile, scope.region, { secretStorage: this.context.secrets });
            return {
                ok: true,
                ...describeScopeForModel(scope),
                projects: projects.map((project) => ({ name: project.name }))
            };
        } catch (error) {
            return buildErrorResult(error, {
                scope,
                operation: "Listing projects",
                requiredPermissions: ["codebuild:ListProjects"]
            });
        }
    }
}
