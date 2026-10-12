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
import { formatSanitizedScope, resolveProjectNameFromArg, showShortStatusMessage } from "./shared";
import { ensureDestructiveActionsAllowed } from "./profileCommands";

type EnvVarType = ProjectEnvironmentVariable["type"];

const ENV_VAR_TYPES: Array<{ label: string; description: string; type: EnvVarType }> = [
    { label: "PLAINTEXT", description: "Stored directly on the project. Avoid for secrets.", type: "PLAINTEXT" },
    { label: "PARAMETER_STORE", description: "Value is a Systems Manager Parameter Store name", type: "PARAMETER_STORE" },
    { label: "SECRETS_MANAGER", description: "Value is a Secrets Manager secret name", type: "SECRETS_MANAGER" }
];

type EditorAction =
    | { kind: "add" }
    | { kind: "edit"; variable: ProjectEnvironmentVariable }
    | { kind: "save" };

function validateVariableName(value: string, existing: ProjectEnvironmentVariable[]): string | undefined {
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

async function promptForVariableDetails(
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

    const typePick = await vscode.window.showQuickPick(ENV_VAR_TYPES, {
        title: `Type for ${normalizedName}`,
        placeHolder: "Select how CodeBuild should resolve this variable's value"
    });

    if (!typePick) {
        return undefined;
    }

    if (typePick.type === "PLAINTEXT") {
        showShortStatusMessage(
            "Reminder: avoid storing secrets as PLAINTEXT. Prefer Parameter Store or Secrets Manager.",
            6000
        );
    }

    const value = await vscode.window.showInputBox({
        title: `Value for ${normalizedName}`,
        value: initial?.value ?? "",
        prompt: typePick.type === "PLAINTEXT"
            ? "Enter the literal value used during the build"
            : "Enter the Parameter Store/Secrets Manager name CodeBuild should resolve at build time",
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
                description: variable.type,
                detail: variable.type === "PLAINTEXT" ? variable.value : `-> ${variable.value}`,
                action: { kind: "edit", variable } as const
            }));

        items.push({
            label: "$(add) Add environment variable",
            action: { kind: "add" }
        });

        if (dirty) {
            items.push({
                label: "$(save) Save changes to AWS",
                description: `${variables.length} variable(s)`,
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
                    `[SETTINGS] Updated ${variables.length} environment variable(s) for ${sanitizeLogValue(resolvedProjectName)} (${formatSanitizedScope(profile, region)})`
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
