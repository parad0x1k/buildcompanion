import * as vscode from "vscode";
import { getUserFriendlyErrorMessage } from "../aws/errorHandling";

/**
 * Structured result shape returned by every BuildCompanion agent tool, serialized as JSON text
 * inside the LanguageModelToolResult. Every tool returns one of these rather than free-form
 * prose so a calling agent can reliably branch on `ok`/`errorType` instead of parsing text, and
 * so a human inspecting the chat transcript can see exactly what was targeted and what happened
 * even if the platform's own confirmation dialog was bypassed (e.g. via "Always Allow").
 */
export type AgentToolErrorType =
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "ALREADY_IN_PROGRESS"
    | "BLOCKED"
    | "PERMISSION_DENIED"
    | "UNEXPECTED_ERROR";

export type AgentToolError = {
    ok: false;
    errorType: AgentToolErrorType;
    message: string;
    profile?: string;
    region?: string;
    projectName?: string;
    requiredPermissions?: string[];
};

export type AgentToolSuccess<T extends object> = { ok: true } & T;

export type AgentToolResult<T extends object> = AgentToolSuccess<T> | AgentToolError;

export function toToolResult(result: AgentToolResult<object>): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
    ]);
}

export function validationError(message: string): AgentToolError {
    return { ok: false, errorType: "VALIDATION_ERROR", message };
}

/**
 * Builds a structured error result from a caught error, routed exclusively through
 * getUserFriendlyErrorMessage so a raw AWS SDK error (which commonly embeds ARNs/account IDs,
 * see errorHandling's redaction guarantees) never reaches tool output that can be relayed to a
 * remote chat model backend.
 */
export function buildErrorResult(
    error: unknown,
    context: {
        profile?: string;
        region?: string;
        projectName?: string;
        operation: string;
        requiredPermissions: string[];
    }
): AgentToolError {
    const message = getUserFriendlyErrorMessage(error, context);
    const isPermissionDenied = /missing (required )?aws permissions/i.test(message);

    return {
        ok: false,
        errorType: isPermissionDenied ? "PERMISSION_DENIED" : "UNEXPECTED_ERROR",
        message,
        profile: context.profile,
        region: context.region,
        projectName: context.projectName,
        requiredPermissions: isPermissionDenied ? context.requiredPermissions : undefined
    };
}
