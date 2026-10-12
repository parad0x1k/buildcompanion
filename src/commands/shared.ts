import * as vscode from "vscode";
import type { AppStore, BuildState, Project } from "../state/store";
import { sanitizeLogValue } from "../logging/outputChannelManager";
import { formatProjectScope, formatScope, notify } from "../notifications/notifier";
import { getRecentGitBranchSuggestions } from "../git/gitService";

export const BUILD_HISTORY_LIMIT = 20;

export type CommandDeps = {
    context: vscode.ExtensionContext;
    store: AppStore;
};

export type BuildArg = {
    id: string;
    projectName: string;
    status?: BuildState["status"];
    profile: string;
    region: string;
    /** Resolved source version/branch, when the caller (e.g. a Build History row) has it available. */
    sourceVersion?: string;
};

export type BranchPickItem = {
    label: string;
    description?: string;
    branch?: string;
    isCustom?: boolean;
};

export type BatchCancellationController = {
    cancel: () => void;
    isCancelled: () => boolean;
};

export type ActiveBatchDeployment = {
    id: number;
    profile: string;
    region: string;
    cancel: () => void;
};

export type RefreshProfilesOptions = {
    interactiveFailurePrompt?: boolean;
};

export function createBatchCancellationController(): BatchCancellationController {
    let cancelled = false;

    return {
        cancel: () => {
            cancelled = true;
        },
        isCancelled: () => cancelled
    };
}

export function formatBranchForNotification(branch?: string): string {
    const normalizedBranch = branch?.trim();
    return normalizedBranch && normalizedBranch.length > 0 ? normalizedBranch : "default source version";
}

export function formatSanitizedScope(
    profile: string | null | undefined,
    region: string | null | undefined
): string {
    return `${sanitizeLogValue(profile ?? "unknown", "profile")}/${sanitizeLogValue(region ?? "unknown", "region")}`;
}

export function sanitizeBuildId(buildId: string): string {
    return sanitizeLogValue(buildId, "buildId");
}

export function validateTemporaryCredentialExpiration(value: string): string | undefined {
    const normalized = value.trim();
    if (!normalized) {
        return "Expiration is required";
    }

    const expirationMs = Date.parse(normalized);
    if (!Number.isFinite(expirationMs)) {
        return "Expiration must be a valid ISO 8601 timestamp (for example 2026-05-01T18:00:00Z)";
    }

    if (expirationMs <= Date.now()) {
        return "Expiration must be in the future";
    }

    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    if (expirationMs > Date.now() + ONE_YEAR_MS) {
        return "Expiration must be within 1 year from now";
    }

    return undefined;
}

export function notifyDeploymentTriggered(
    projectName: string,
    profile: string,
    region: string,
    branch?: string
): void {
    const branchLabel = formatBranchForNotification(branch);
    void notify("info", `Deployment triggered for ${formatProjectScope(projectName, profile, region)} using ${branchLabel}`);
}

export function showShortStatusMessage(message: string, timeoutMs: number = 3000): void {
    void notify("info", message, {
        target: "status",
        timeoutMs
    });
}

export function warnCompletionPopupsPaused(
    state: Readonly<ReturnType<AppStore["getState"]>>
): void {
    if (state.autoRefreshEnabled) {
        return;
    }

    void notify(
        "warning",
        `Auto-refresh is disabled in ${formatScope(state.currentProfile, state.currentRegion)}. Completion popups are paused until auto-refresh is enabled.`,
        {
            detail: "Builds can still be triggered, but queued Wait deployments will not auto-start while auto-refresh is off. Use Toggle Auto-Refresh from the CodeBuild view toolbar to resume monitoring and queued progression."
        }
    );
}

export function shortenId(id: string): string {
    if (!id) {
        return "unknown";
    }

    if (id.length <= 12) {
        return id;
    }

    return `${id.slice(0, 8)}\u2026${id.slice(-5)}`;
}

export function validateBranchInput(value: string): string | undefined {
    if (value.length > 0 && value.trim().length === 0) {
        return "Branch cannot be only whitespace";
    }

    const branch = value.trim();
    if (!branch) {
        return undefined;
    }

    if (branch.includes(" ")) {
        return "Branch cannot contain spaces";
    }

    if (branch.length > 255) {
        return "Branch name must be 255 characters or fewer";
    }

    if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".")) {
        return "Branch format is invalid";
    }

    if (
        branch.includes("..")
        || branch.includes("//")
        || branch.includes("@{")
        || /[~^:?*[\]\\]/.test(branch)
        || /\.lock(?:\/|$)/.test(branch)
    ) {
        return "Branch format is invalid";
    }

    return undefined;
}

export function resolveProjectNameFromArg(arg: unknown): string | undefined {
    if (typeof arg === "string") {
        const normalized = arg.trim();
        return normalized || undefined;
    }

    if (arg && typeof arg === "object" && "project" in arg) {
        const project = (arg as { project?: { name?: string } }).project;
        const name = project?.name?.trim();
        return name || undefined;
    }

    return undefined;
}

export function resolveBuildFromArg(arg: unknown): BuildArg | undefined {
    if (!arg || typeof arg !== "object") {
        return undefined;
    }

    const withBuild = arg as { build?: BuildArg };
    if (withBuild.build?.id && withBuild.build.projectName && withBuild.build.profile && withBuild.build.region) {
        return withBuild.build;
    }

    const build = arg as Partial<BuildArg>;
    if (build.id && build.projectName && build.profile && build.region) {
        return build as BuildArg;
    }

    return undefined;
}

export function setProjectStatus(
    projects: Project[],
    projectName: string,
    status: string
): Project[] {
    return projects.map((project) => {
        if (project.name !== projectName) {
            return project;
        }

        return {
            ...project,
            lastBuildStatus: status
        };
    });
}

export function getWorkspaceRootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getSelectedProjectNames(
    store: AppStore,
    profile: string,
    region: string
): string[] {
    const state = store.getState();
    const selected = new Set(store.getSelectedProjects(profile, region));

    return state.projects
        .map((project) => project.name)
        .filter((projectName) => selected.has(projectName));
}

export function hasProjectInScope(projects: Project[], projectName: string): boolean {
    return projects.some((project) => project.name === projectName);
}

export function filterProjectsBySearch(projects: Project[], filterText: string): Project[] {
    const normalizedFilter = filterText.trim().toLowerCase();
    return projects
        .filter((project) => !normalizedFilter || project.name.toLowerCase().includes(normalizedFilter))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getVisibleProjects(store: AppStore): Project[] {
    const state = store.getState();
    return filterProjectsBySearch(state.projects, state.projectFilter ?? "");
}

export function canSelectAllVisibleProjects(
    state: ReturnType<AppStore["getState"]>
): boolean {
    const visibleProjects = filterProjectsBySearch(state.projects, state.projectFilter ?? "");
    if (visibleProjects.length === 0) {
        return false;
    }

    if ((state.projectFilter ?? "").trim().length === 0) {
        return true;
    }

    return visibleProjects.length > 1;
}

export function formatDeploymentPreview(
    batchProjects: Array<{ projectName: string; branch?: string }>
): string {
    const lines = batchProjects.map(
        ({ projectName, branch }) => `${projectName} -> ${formatBranchForNotification(branch)}`
    );
    const maxLines = 20;

    if (lines.length <= maxLines) {
        return lines.join("\n");
    }

    const remainingCount = lines.length - maxLines;
    return `${lines.slice(0, maxLines).join("\n")}\n...and ${remainingCount} more project(s)`;
}

export async function promptForBranchSelection(options: {
    title: string;
    prompt: string;
    initialValue: string;
}): Promise<string | undefined> {
    const suggestions = await getRecentGitBranchSuggestions(getWorkspaceRootPath());
    const recentBranches = suggestions.branches;
    const currentBranch = suggestions.currentBranch;

    if (recentBranches.length === 0) {
        return vscode.window.showInputBox({
            title: options.title,
            prompt: options.prompt,
            value: options.initialValue,
            validateInput: validateBranchInput
        });
    }

    const picks: BranchPickItem[] = [
        ...recentBranches.map((branch) => ({
            label: branch,
            description: branch === currentBranch ? "current" : undefined,
            branch
        })),
        {
            label: "Enter custom branch",
            description: "Use manual branch input",
            isCustom: true
        }
    ];

    const selected = await vscode.window.showQuickPick(picks, {
        title: options.title,
        placeHolder: "Select a recent branch or enter a custom one"
    });

    if (!selected) {
        return undefined;
    }

    if (!selected.isCustom && selected.branch !== undefined) {
        return selected.branch;
    }

    return vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        value: options.initialValue,
        validateInput: validateBranchInput
    });
}
