import * as vscode from "vscode";

export type NotificationType = "success" | "error" | "warning" | "info";

export type NotificationOptions = {
    target?: "popup" | "status";
    modal?: boolean;
    detail?: string;
    actions?: string[];
    timeoutMs?: number;
};

export async function notify(
    type: NotificationType,
    message: string,
    options?: NotificationOptions
): Promise<string | undefined | void> {
    const target = options?.target ?? "popup";

    if (target === "status") {
        vscode.window.setStatusBarMessage(message, options?.timeoutMs ?? 3000);
        return;
    }

    const messageOptions: vscode.MessageOptions | undefined = (options?.modal || options?.detail)
        ? {
            modal: options?.modal,
            detail: options?.detail
        }
        : undefined;

    const actions = options?.actions ?? [];

    if (type === "error") {
        if (messageOptions) {
            return vscode.window.showErrorMessage(message, messageOptions, ...actions);
        }

        return vscode.window.showErrorMessage(message, ...actions);
    }

    if (type === "warning") {
        if (messageOptions) {
            return vscode.window.showWarningMessage(message, messageOptions, ...actions);
        }

        return vscode.window.showWarningMessage(message, ...actions);
    }

    // "success" and "info" map to information popups.
    if (messageOptions) {
        return vscode.window.showInformationMessage(message, messageOptions, ...actions);
    }

    return vscode.window.showInformationMessage(message, ...actions);
}

export function formatScope(profile: string | null | undefined, region: string): string {
    const normalizedProfile = profile?.trim() || "unknown-profile";
    const normalizedRegion = region.trim() || "unknown-region";
    return `${normalizedProfile} (${normalizedRegion})`;
}

export function formatProjectScope(projectName: string, profile: string | null | undefined, region: string): string {
    return `${projectName} in ${formatScope(profile, region)}`;
}
