import * as vscode from "vscode";
import type { FailedBuildEntry } from "./store";

const FAILED_BUILDS_STATE_KEY = "codebuild.failedBuilds";

export function getPersistedFailedBuilds(context: vscode.ExtensionContext): FailedBuildEntry[] {
    const stored = context.globalState.get<FailedBuildEntry[]>(FAILED_BUILDS_STATE_KEY);
    return Array.isArray(stored) ? stored : [];
}

export async function persistFailedBuilds(
    context: vscode.ExtensionContext,
    failedBuilds: FailedBuildEntry[]
): Promise<void> {
    await context.globalState.update(FAILED_BUILDS_STATE_KEY, failedBuilds);
}
