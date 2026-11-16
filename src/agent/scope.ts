import * as vscode from "vscode";
import type { AppStore } from "../state/store";
import type { AgentToolError } from "./types";

/**
 * How a tool call's AWS scope was decided:
 * - "input": the agent passed the profile explicitly (because the user named one).
 * - "selection": the agent omitted it and the profile/region the user already chose in the
 *   BuildCompanion view were used.
 */
export type AgentScopeSource = "input" | "selection";

export type ResolvedAgentScope = {
    /** The real profile name. Used for AWS calls and human-only UI; never put in model-facing output when source is "selection". */
    profile: string;
    region: string;
    source: AgentScopeSource;
    /**
     * What model-facing text (results, error messages) may call the profile. The agent already
     * knows a profile it passed itself; one taken from the user's selection is described
     * generically so the profile name - which often encodes account, client or environment
     * names - never reaches the chat model backend.
     */
    profileLabel: string;
};

export const CURRENT_PROFILE_LABEL = "the current BuildCompanion profile";

export type AgentScopeInput = { profile?: string; region?: string };

const REQUIRE_EXPLICIT_SCOPE_FOR_BUILDS_SETTING = "agentTools.requireExplicitScopeForBuilds";

export function isExplicitScopeRequiredForBuilds(): boolean {
    return vscode.workspace.getConfiguration("codebuild").get<boolean>(REQUIRE_EXPLICIT_SCOPE_FOR_BUILDS_SETTING, false);
}

function noSelectionError(): AgentToolError {
    return {
        ok: false,
        errorType: "NO_SELECTION",
        message: "No AWS profile is selected in BuildCompanion. Ask the user to pick one in the BuildCompanion view " +
            "(Settings > Profile), then retry without passing profile or region."
    };
}

/**
 * Resolves the profile/region a tool call should use. An omitted (or blank) profile or region
 * falls back to the user's current BuildCompanion selection, so agents don't have to ask the user
 * for values the extension already knows. An explicitly passed profile must be one BuildCompanion
 * has discovered, so a model can't guess or probe profile names; the rejection deliberately does
 * not list the profiles that do exist.
 */
export function resolveAgentScope(store: AppStore, input: AgentScopeInput): ResolvedAgentScope | AgentToolError {
    const state = store.getState();
    const explicitProfile = input.profile?.trim() || undefined;
    const explicitRegion = input.region?.trim() || undefined;

    if (explicitProfile) {
        // Only enforced once discovery has produced a profile list; before that (or in a session
        // where discovery failed) the AWS call itself reports an unknown profile.
        if (state.profiles.length > 0 && !state.profiles.some((profile) => profile.name === explicitProfile)) {
            return {
                ok: false,
                errorType: "VALIDATION_ERROR",
                message: "That AWS profile is not configured in BuildCompanion. Omit profile to use the user's current " +
                    "BuildCompanion selection, or ask the user for the exact profile name."
            };
        }

        const region = explicitRegion ?? state.currentRegion;
        if (!region) {
            return { ok: false, errorType: "VALIDATION_ERROR", message: "region is required when no region is selected in BuildCompanion." };
        }

        return { profile: explicitProfile, region, source: "input", profileLabel: explicitProfile };
    }

    if (!state.currentProfile) {
        return noSelectionError();
    }

    return {
        profile: state.currentProfile,
        region: explicitRegion ?? state.currentRegion,
        source: "selection",
        profileLabel: CURRENT_PROFILE_LABEL
    };
}

export function isAgentToolError(value: ResolvedAgentScope | AgentToolError): value is AgentToolError {
    return (value as AgentToolError).ok === false;
}

/**
 * The scope fields a tool result may echo back to the model: always the region and whether the
 * user's selection was used, plus the profile name only if the agent supplied it itself.
 */
export function describeScopeForModel(scope: ResolvedAgentScope): { profile?: string; region: string; usedCurrentSelection: boolean } {
    return scope.source === "input"
        ? { profile: scope.profile, region: scope.region, usedCurrentSelection: false }
        : { region: scope.region, usedCurrentSelection: true };
}

/** "dev (us-east-1)" or "the current BuildCompanion profile (us-east-1)", for model-facing text. */
export function formatScopeForModel(scope: ResolvedAgentScope): string {
    return `${scope.profileLabel} (${scope.region})`;
}

/** Human-only (confirmation dialogs, chat progress lines): the real names, marked when they came from the selection. */
export function formatScopeForUser(scope: ResolvedAgentScope): string {
    const suffix = scope.source === "selection" ? ", your current BuildCompanion selection" : "";
    return `profile \`${scope.profile}\`, region \`${scope.region}\`${suffix}`;
}
