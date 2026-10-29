import * as vscode from "vscode";
import type { AppStore } from "../state/store";
import { GetBuildStatusTool } from "./tools/getBuildStatusTool";
import { ListProjectsTool } from "./tools/listProjectsTool";
import { ListRecentBuildsTool } from "./tools/listRecentBuildsTool";
import { TriggerBuildTool } from "./tools/triggerBuildTool";

const AGENT_TOOLS_ENABLED_SETTING = "agentTools.enabled";

export function isAgentToolsEnabled(): boolean {
    return vscode.workspace.getConfiguration("codebuild").get<boolean>(AGENT_TOOLS_ENABLED_SETTING, false);
}

/**
 * Registers BuildCompanion's Language Model Tools (agent-callable trigger/query operations) when
 * codebuild.agentTools.enabled is on, and live-toggles registration as that setting changes -
 * no reload required. Off by default: this is the first capability in this extension whose
 * input/output can reach a third-party chat model backend, a new boundary beyond this
 * extension's existing AWS-only communication (see README "Privacy & Telemetry"), so it ships as
 * an explicit opt-in rather than default-on for this first release.
 */
export function registerAgentTools(context: vscode.ExtensionContext, store: AppStore): vscode.Disposable {
    let toolSubscriptions: vscode.Disposable[] = [];

    function register(): void {
        if (!isAgentToolsEnabled() || toolSubscriptions.length > 0) {
            return;
        }

        toolSubscriptions = [
            vscode.lm.registerTool("codebuild_trigger_build", new TriggerBuildTool(context, store)),
            vscode.lm.registerTool("codebuild_list_projects", new ListProjectsTool(context)),
            vscode.lm.registerTool("codebuild_get_build_status", new GetBuildStatusTool(context)),
            vscode.lm.registerTool("codebuild_list_recent_builds", new ListRecentBuildsTool(context))
        ];
    }

    function unregister(): void {
        for (const subscription of toolSubscriptions.splice(0)) {
            subscription.dispose();
        }
    }

    register();

    const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`codebuild.${AGENT_TOOLS_ENABLED_SETTING}`)) {
            return;
        }

        if (isAgentToolsEnabled()) {
            register();
        } else {
            unregister();
        }
    });

    return {
        dispose: () => {
            unregister();
            configSubscription.dispose();
        }
    };
}
