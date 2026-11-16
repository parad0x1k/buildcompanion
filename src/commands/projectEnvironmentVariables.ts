import * as vscode from "vscode";
import {
    getProjectEnvironmentVariables,
    setProjectEnvironmentVariables,
    type ProjectEnvironmentVariable
} from "../aws/codebuildService";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";
import type { AppStore } from "../state/store";
import { logError, logInfo, sanitizeLogValue } from "../logging/outputChannelManager";
import { formatScope, notify } from "../notifications/notifier";
import { formatSanitizedScope, pluralize, resolveProjectNameFromArg, showShortStatusMessage } from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";

type EnvVarType = ProjectEnvironmentVariable["type"];

/** Human-readable name and codicon for each CodeBuild environment variable type. */
const ENV_VAR_TYPE_DISPLAY: Record<EnvVarType, { name: string; icon: string }> = {
    PLAINTEXT: { name: "Plain text", icon: "$(symbol-string)" },
    PARAMETER_STORE: { name: "Parameter Store", icon: "$(link)" },
    SECRETS_MANAGER: { name: "Secrets Manager", icon: "$(lock)" }
};

export const ENV_VAR_TYPES: Array<{ label: string; description: string; type: EnvVarType }> = [
    {
        label: `${ENV_VAR_TYPE_DISPLAY.PLAINTEXT.icon} ${ENV_VAR_TYPE_DISPLAY.PLAINTEXT.name}`,
        description: "Stored directly on the project. Avoid for secrets.",
        type: "PLAINTEXT"
    },
    {
        label: `${ENV_VAR_TYPE_DISPLAY.PARAMETER_STORE.icon} ${ENV_VAR_TYPE_DISPLAY.PARAMETER_STORE.name}`,
        description: "Resolved from a Systems Manager parameter at build time",
        type: "PARAMETER_STORE"
    },
    {
        label: `${ENV_VAR_TYPE_DISPLAY.SECRETS_MANAGER.icon} ${ENV_VAR_TYPE_DISPLAY.SECRETS_MANAGER.name}`,
        description: "Resolved from a Secrets Manager secret at build time",
        type: "SECRETS_MANAGER"
    }
];

/**
 * Description/detail for an environment variable row in a quick pick: the friendly type name,
 * and the value (plain text) or the parameter/secret it resolves from, marked with that type's
 * icon instead of an ASCII arrow.
 */
export function formatEnvVarPickDetails(variable: ProjectEnvironmentVariable): { description: string; detail: string } {
    const display = ENV_VAR_TYPE_DISPLAY[variable.type] ?? { name: variable.type, icon: "$(question)" };

    if (variable.type === "PLAINTEXT") {
        return { description: display.name, detail: variable.value || "(empty)" };
    }

    return { description: display.name, detail: `${display.icon} ${variable.value}` };
}

type EditorAction =
    | { kind: "add" }
    | { kind: "edit"; variable: ProjectEnvironmentVariable }
    | { kind: "save" };

export function validateVariableName(value: string, existing: ProjectEnvironmentVariable[]): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return "Variable name is required";
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        return "Use letters, numbers, and underscores only; names cannot start with a number";
    }

    if (existing.some((variable) => variable.name === trimmed)) {
        return `Variable '${trimmed}' already exists`;
    }

    return undefined;
}

export async function promptForVariableDetails(
    existingOtherVariables: ProjectEnvironmentVariable[],
    initial?: ProjectEnvironmentVariable
): Promise<ProjectEnvironmentVariable | undefined> {
    const name = await vscode.window.showInputBox({
        title: initial ? `Rename variable (current: ${initial.name})` : "New environment variable name",
        value: initial?.name ?? "",
        ignoreFocusOut: true,
        validateInput: (value) => validateVariableName(value, existingOtherVariables)
    });

    if (name === undefined) {
        return undefined;
    }

    const normalizedName = name.trim();

    const typePick = await vscode.window.showQuickPick(
        // When editing, mark the variable's current type so changing it is a deliberate choice.
        ENV_VAR_TYPES.map((item) => (
            item.type === initial?.type ? { ...item, description: `Current · ${item.description}` } : item
        )),
        {
            title: `Type for ${normalizedName}`,
            placeHolder: "How should CodeBuild resolve this variable's value?"
        }
    );

    if (!typePick) {
        return undefined;
    }

    if (typePick.type === "PLAINTEXT") {
        showShortStatusMessage(
            "Reminder: plain text values are visible to anyone who can view the project. Use Parameter Store or Secrets Manager for secrets.",
            6000
        );
    }

    const valuePrompts: Record<EnvVarType, string> = {
        PLAINTEXT: "Enter the value used during the build",
        PARAMETER_STORE: "Enter the Parameter Store parameter name, e.g. /myapp/prod/db-host",
        SECRETS_MANAGER: "Enter the Secrets Manager secret name or ARN, optionally with :json-key"
    };

    const value = await vscode.window.showInputBox({
        title: `Value for ${normalizedName}`,
        value: initial?.value ?? "",
        prompt: valuePrompts[typePick.type],
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? "Value is required" : undefined)
    });

    if (value === undefined) {
        return undefined;
    }

    return { name: normalizedName, value: value.trim(), type: typePick.type };
}

export async function editProjectEnvironmentVariables(
    context: vscode.ExtensionContext,
    store: AppStore,
    arg?: unknown
): Promise<void> {
    const state = store.getState();
    const profile = state.currentProfile;
    const region = state.currentRegion;

    if (!profile) {
        void notify(
            "warning",
            `Select an AWS profile before editing environment variables in ${formatScope(profile, region)}`
        );
        return;
    }

    let projectName = resolveProjectNameFromArg(arg);
    if (!projectName) {
        if (state.projects.length === 0) {
            void notify("info", `No CodeBuild projects available in ${formatScope(profile, region)}`);
            return;
        }

        projectName = await vscode.window.showQuickPick(state.projects.map((project) => project.name), {
            title: "Select Project to Edit Environment Variables"
        });
    }

    if (!projectName) {
        return;
    }

    const resolvedProjectName = projectName;

    if (!await ensureDestructiveActionsAllowed(context, store, profile, region, "Edit Environment Variables")) {
        return;
    }

    let variables: ProjectEnvironmentVariable[];
    try {
        variables = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Loading environment variables for ${resolvedProjectName}...`
            },
            () => getProjectEnvironmentVariables(profile, region, resolvedProjectName, { secretStorage: context.secrets })
        );
    } catch (error) {
        const message = getUserFriendlyErrorMessage(error, {
            profile,
            region,
            operation: "Reading project environment variables",
            requiredPermissions: ["codebuild:BatchGetProjects"]
        });
        logError(
            `[SETTINGS] Failed to load environment variables for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)}): ${sanitizeLogValue(message)}`
        );
        void notify("error", `Unable to load environment variables for ${resolvedProjectName}`);
        return;
    }

    let dirty = false;

    while (true) {
        const items: Array<vscode.QuickPickItem & { action: EditorAction }> = variables
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((variable) => ({
                label: `$(symbol-variable) ${variable.name}`,
                ...formatEnvVarPickDetails(variable),
                action: { kind: "edit", variable } as const
            }));

        items.push({
            label: "$(add) Add environment variable",
            action: { kind: "add" }
        });

        if (dirty) {
            items.push({
                label: "$(save) Save changes to AWS",
                description: pluralize(variables.length, "variable"),
                action: { kind: "save" }
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            title: `Environment Variables: ${resolvedProjectName}${dirty ? " (unsaved changes)" : ""}`,
            placeHolder: "Select a variable to edit or remove, or choose an action below",
            ignoreFocusOut: true
        });

        if (!picked) {
            if (dirty) {
                const discardConfirm = await notify(
                    "warning",
                    "Discard unsaved environment variable changes?",
                    { modal: true, actions: ["Discard Changes"] }
                );

                if (discardConfirm !== "Discard Changes") {
                    continue;
                }
            }

            return;
        }

        if (picked.action.kind === "add") {
            const created = await promptForVariableDetails(variables);
            if (created) {
                variables = [...variables, created];
                dirty = true;
            }
            continue;
        }

        if (picked.action.kind === "save") {
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Saving environment variables for ${resolvedProjectName}...`
                    },
                    () => setProjectEnvironmentVariables(
                        profile,
                        region,
                        resolvedProjectName,
                        variables,
                        { secretStorage: context.secrets }
                    )
                );

                logInfo(
                    `[SETTINGS] Updated ${pluralize(variables.length, "environment variable")} for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)})`
                );
                showShortStatusMessage(`Environment variables saved for ${resolvedProjectName}`);
                return;
            } catch (error) {
                const message = getUserFriendlyErrorMessage(error, {
                    profile,
                    region,
                    operation: "Updating project environment variables",
                    requiredPermissions: ["codebuild:BatchGetProjects", "codebuild:UpdateProject"]
                });
                logError(
                    `[SETTINGS] Failed to update environment variables for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)}): ${sanitizeLogValue(message)}`
                );
                void notify("error", `Unable to save environment variables for ${resolvedProjectName}`);
                continue;
            }
        }

        const target = picked.action.variable;
        const otherVariables = variables.filter((variable) => variable.name !== target.name);
        const choice = await vscode.window.showQuickPick(
            [
                { label: "$(edit) Edit name, type, or value", action: "edit" as const },
                { label: "$(trash) Remove variable", action: "remove" as const }
            ],
            { title: target.name, ignoreFocusOut: true }
        );

        if (!choice) {
            continue;
        }

        if (choice.action === "remove") {
            variables = otherVariables;
            dirty = true;
            continue;
        }

        const updated = await promptForVariableDetails(otherVariables, target);
        if (updated) {
            variables = [...otherVariables, updated];
            dirty = true;
        }
    }
}
