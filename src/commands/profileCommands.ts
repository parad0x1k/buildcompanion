import * as vscode from "vscode";
import { listCodeBuildProjects } from "../aws/codebuildService";
import { listAwsProfiles } from "../aws/profileManager";
import { clearAwsClientCache } from "../aws/clientFactory";
import { getTemporaryCredentialsKey, rememberTemporaryCredentialProfile } from "../aws/credentials";
import { getNoProfilesMessage, getUserFriendlyErrorMessage } from "../aws/errorHandling";
import {
    getEnvironmentRegion,
    getPersistedRegion,
    getSupportedRegions,
    persistRegion,
    resolveDefaultRegion,
    switchRegion
} from "../aws/regionManager";
import type { AppStore } from "../state/store";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatScope, notify } from "../notifications/notifier";
import {
    formatSanitizedScope,
    showShortStatusMessage,
    validateTemporaryCredentialExpiration,
    type RefreshProfilesOptions
} from "./shared";

const MAX_REFRESH_RETRIES = 5;

/**
 * Non-modal accessor for the destructive-action block check: returns the block reason (if any)
 * without any UI side effect. `ensureDestructiveActionsAllowed` below wraps this with the
 * human-facing blocking modal + "Switch Profile" flow; callers that can't show a native modal
 * (e.g. an agent tool invocation) should call this directly and surface the reason as a
 * structured result instead.
 */
export function getDestructiveActionBlockReason(store: AppStore, profile: string, region: string): string | undefined {
    return store.getDestructiveActionBlockForScope(profile, region);
}

export async function ensureDestructiveActionsAllowed(
    context: vscode.ExtensionContext,
    store: AppStore,
    profile: string,
    region: string,
    actionLabel: string
): Promise<boolean> {
    const blockReason = getDestructiveActionBlockReason(store, profile, region);
    if (!blockReason) {
        return true;
    }

    const decision = await notify(
        "warning",
        `${actionLabel} is blocked in ${formatScope(profile, region)} until you switch profiles.`,
        {
            modal: true,
            detail: `Last refresh error: ${blockReason}`,
            actions: ["Switch Profile"]
        }
    );

    if (decision === "Switch Profile") {
        await switchProfile(context, store);
    }

    return false;
}

export async function refreshProfilesAndProjects(
    context: vscode.ExtensionContext,
    store: AppStore,
    options: RefreshProfilesOptions = {}
): Promise<void> {
    const previousState = store.getState();

    const profilesStartedAtMs = Date.now();
    const profiles = await listAwsProfiles({ secretStorage: context.secrets });
    logInfo(`[REFRESH] Discovered ${profiles.length} AWS profile(s) in ${Date.now() - profilesStartedAtMs}ms`);
    store.setProfiles(profiles);

    const currentProfile = previousState.currentProfile;
    const selectedProfile = profiles.find((profile) => profile.name === currentProfile)
        ?? profiles[0]
        ?? null;

    if (previousState.regions.length === 0) {
        store.setRegions(getSupportedRegions());
    }

    const resolvedRegion = resolveDefaultRegion({
        persistedRegion: getPersistedRegion(context),
        profileRegion: selectedProfile?.region,
        environmentRegion: getEnvironmentRegion()
    });

    const regionList = store.getState().regions;
    const activeRegion = regionList.includes(previousState.currentRegion)
        ? previousState.currentRegion
        : resolvedRegion;

    store.setCurrentRegion(activeRegion);
    await persistRegion(context, activeRegion);

    if (!selectedProfile) {
        store.setCurrentProfile(null);
        store.setProjects([]);
        void notify("warning", getNoProfilesMessage());
        return;
    }

    store.setCurrentProfile(selectedProfile.name);

    let retryCount = 0;
    while (true) {
        try {
            const projectsStartedAtMs = Date.now();
            const projects = await listCodeBuildProjects(selectedProfile.name, activeRegion, {
                secretStorage: context.secrets
            });
            logInfo(`[REFRESH] Loaded ${projects.length} CodeBuild project(s) for ${formatSanitizedScope(selectedProfile.name, activeRegion)} in ${Date.now() - projectsStartedAtMs}ms`);

            store.batchUpdate(() => {
                store.setCurrentProfile(selectedProfile.name);
                store.setProjects(projects);
                store.clearDestructiveActionBlockForScope(selectedProfile.name, activeRegion);
            });
            return;
        } catch (error) {
            const message = getUserFriendlyErrorMessage(error, {
                profile: selectedProfile.name,
                region: activeRegion,
                operation: "Listing CodeBuild projects"
            });
            logError(`[REFRESH] ${sanitizeLogValue(message)}`);

            store.batchUpdate(() => {
                store.setCurrentProfile(selectedProfile.name);
                store.setProjects([]);
                store.blockDestructiveActionsForScope(selectedProfile.name, activeRegion, message);
            });

            const scope = formatScope(selectedProfile.name, activeRegion);
            if (!options.interactiveFailurePrompt) {
                void notify("error", `Unable to load projects for ${scope}.`, {
                    detail: "Destructive actions are blocked in this scope until you switch profiles."
                });
                return;
            }

            retryCount += 1;
            if (retryCount >= MAX_REFRESH_RETRIES) {
                void notify("error", `Unable to load projects for ${scope} after ${MAX_REFRESH_RETRIES} attempts.`, {
                    detail: `${message}\n\nDestructive actions are blocked in this scope until you switch profiles.`
                });
                return;
            }

            const decision = await notify(
                "warning",
                `Unable to load projects for ${scope}.`,
                {
                    modal: true,
                    detail: `${message}\n\nDestructive actions are blocked in this scope until you switch profiles.`,
                    actions: ["Retry", "Switch Profile"]
                }
            );

            if (decision === "Retry") {
                continue;
            }

            if (decision === "Switch Profile") {
                await switchProfile(context, store);
            }

            return;
        }
    }
}

export async function switchProfile(
    context: vscode.ExtensionContext,
    store: AppStore
): Promise<void> {
    const state = store.getState();
    if (state.profiles.length === 0) {
        void notify("warning", getNoProfilesMessage());
        return;
    }

    const picks = state.profiles.map((profile) => ({
        label: profile.name,
        description: profile.type,
        profile
    }));

    const selected = await vscode.window.showQuickPick(picks, {
        title: "Select AWS Profile",
        placeHolder: state.currentProfile ?? "Choose profile"
    });

    if (!selected || selected.profile.name === state.currentProfile) {
        return;
    }

    const currentRegion = state.currentRegion;
    const resolvedRegion = resolveDefaultRegion({
        persistedRegion: getPersistedRegion(context),
        profileRegion: selected.profile.region,
        environmentRegion: getEnvironmentRegion()
    });

    const targetRegion = resolvedRegion !== currentRegion ? resolvedRegion : currentRegion;
    const projects = await listCodeBuildProjects(selected.profile.name, targetRegion, {
        secretStorage: context.secrets
    });

    store.batchUpdate(() => {
        store.setCurrentProfile(selected.profile.name);
        if (targetRegion !== currentRegion) {
            store.setCurrentRegion(targetRegion);
        }
        store.setProjects(projects);
        store.clearDestructiveActionBlockForScope(selected.profile.name, targetRegion);
    });

    if (targetRegion !== currentRegion) {
        await persistRegion(context, targetRegion);
    }
}

export async function setTemporaryCredentials(
    context: vscode.ExtensionContext,
    store: AppStore
): Promise<void> {
    const state = store.getState();
    const tempProfileNameInput = await vscode.window.showInputBox({
        title: "Temporary profile name",
        prompt: "Enter a profile name for these temporary credentials",
        value: "",
        ignoreFocusOut: true,
        validateInput: (value) => {
            const normalized = value.trim();
            if (!normalized) {
                return "Profile name is required";
            }

            if (normalized.toLowerCase() === "environment") {
                return "Profile name 'environment' is reserved";
            }

            const conflictsWithAwsProfile = state.profiles.some((profile) => (
                profile.name === normalized && profile.type !== "temporary"
            ));
            if (conflictsWithAwsProfile) {
                return `Profile '${normalized}' already exists in AWS config`;
            }

            return undefined;
        }
    });

    if (tempProfileNameInput === undefined) {
        return;
    }

    const profile = tempProfileNameInput.trim();
    if (!profile) {
        void notify("error", "Profile name is required");
        return;
    }

    const accessKeyIdInput = await vscode.window.showInputBox({
        title: `Access Key ID for ${profile}`,
        prompt: "Enter AWS Access Key ID",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) {
                return "Access Key ID is required";
            }

            // AWS access key IDs start with a 4-character prefix (AKIA, ASIA, AROA, etc.)
            // followed by 16 uppercase alphanumeric characters (total 20 chars).
            if (!/^(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA)[A-Z0-9]{16}$/.test(trimmed)) {
                return "Access Key ID format is invalid. It should be 20 characters starting with AKIA or ASIA.";
            }

            return undefined;
        }
    });

    if (accessKeyIdInput === undefined) {
        return;
    }

    const accessKeyId = accessKeyIdInput.trim();
    if (!accessKeyId) {
        void notify("error", "Access Key ID is required");
        return;
    }

    const secretAccessKeyInput = await vscode.window.showInputBox({
        title: `Secret Access Key for ${profile}`,
        prompt: "Enter AWS Secret Access Key",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length === 0 ? "Secret Access Key is required" : undefined
    });

    if (secretAccessKeyInput === undefined) {
        return;
    }

    const secretAccessKey = secretAccessKeyInput.trim();
    if (!secretAccessKey) {
        void notify("error", "Secret Access Key is required");
        return;
    }

    const sessionTokenInput = await vscode.window.showInputBox({
        title: `Session Token for ${profile} (optional)`,
        prompt: "Leave empty if not needed",
        password: true,
        ignoreFocusOut: true
    });

    if (sessionTokenInput === undefined) {
        return;
    }

    const sessionToken = sessionTokenInput.trim();
    const expirationInput = await vscode.window.showInputBox({
        title: `Expiration for ${profile}`,
        prompt: "Enter credential expiration in ISO 8601 format (for example 2026-05-01T18:00:00Z)",
        ignoreFocusOut: true,
        validateInput: validateTemporaryCredentialExpiration
    });

    if (expirationInput === undefined) {
        return;
    }

    const expirationIso = new Date(expirationInput.trim()).toISOString();
    const storageKey = getTemporaryCredentialsKey(profile);

    const existingCredentials = await context.secrets.get(storageKey);
    if (existingCredentials) {
        const decision = await notify(
            "warning",
            `Temporary credentials already exist for ${formatScope(profile, state.currentRegion)}. Overwrite?`,
            {
                modal: true,
                actions: ["Overwrite"]
            }
        );

        if (decision !== "Overwrite") {
            return;
        }
    }

    const serializedCredentials = JSON.stringify({
        accessKeyId,
        secretAccessKey,
        sessionToken: sessionToken || undefined,
        expiration: expirationIso
    });

    await context.secrets.store(storageKey, serializedCredentials);
    await rememberTemporaryCredentialProfile(profile, context.secrets);
    clearAwsClientCache();

    try {
        await vscode.commands.executeCommand("codebuild.refresh");
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region: state.currentRegion,
            operation: "Refreshing after setting temporary credentials"
        });

        void notify("error", `Refresh failed for ${formatScope(profile, state.currentRegion)}`);
        logError(`[CREDENTIALS] Refresh failed for ${formatSanitizedScope(profile, state.currentRegion)}: ${sanitizeLogValue(message)}`);
        return;
    }

    logInfo(`[CREDENTIALS] Temporary credentials set for ${sanitizeLogValue(profile, "profile")}`);
    showShortStatusMessage(`Temporary credentials set for ${formatScope(profile, state.currentRegion)}`);
}

export async function switchRegionAndReload(
    context: vscode.ExtensionContext,
    store: AppStore
): Promise<void> {
    const previousState = store.getState();
    await switchRegion(context, store);

    const state = store.getState();
    if (state.currentRegion === previousState.currentRegion) {
        return;
    }

    if (!state.currentProfile) {
        store.setProjects([]);
        return;
    }

    try {
        const projects = await listCodeBuildProjects(state.currentProfile, state.currentRegion, {
            secretStorage: context.secrets
        });
        store.setProjects(projects);
    } catch (error) {
        store.batchUpdate(() => {
            store.setCurrentRegion(previousState.currentRegion);
            store.setProjects(previousState.projects);
        });
        await persistRegion(context, previousState.currentRegion);
        throw error;
    }
}
