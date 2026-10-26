import * as vscode from "vscode";
import type { BuildTimeDisplayFormat } from "./store";

const TIME_DISPLAY_FORMAT_STATE_KEY = "codebuild.buildTimeDisplayFormat";

/** Reads the user's persisted Local/UTC build-timestamp preference, defaulting to "local". */
export function getPersistedBuildTimeDisplayFormat(context: vscode.ExtensionContext): BuildTimeDisplayFormat {
    return context.globalState.get<string>(TIME_DISPLAY_FORMAT_STATE_KEY) === "utc" ? "utc" : "local";
}

export async function persistBuildTimeDisplayFormat(
    context: vscode.ExtensionContext,
    format: BuildTimeDisplayFormat
): Promise<void> {
    await context.globalState.update(TIME_DISPLAY_FORMAT_STATE_KEY, format);
}
