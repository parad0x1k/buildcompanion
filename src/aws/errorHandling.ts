import { logError } from "../logging/outputChannelManager";

type ErrorContext = {
    profile?: string | null;
    region?: string | null;
    operation?: string;
    /** IAM actions the caller needed for this operation, surfaced when AWS reports an access-denied error. */
    requiredPermissions?: string[];
};

function getErrorName(error: unknown): string {
    if (!error || typeof error !== "object") {
        return "";
    }

    const named = error as { name?: unknown; code?: unknown; Code?: unknown };
    const value = named.name ?? named.code ?? named.Code;
    return typeof value === "string" ? value : "";
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    return "";
}

function includesAny(value: string, candidates: string[]): boolean {
    return candidates.some((candidate) => value.includes(candidate));
}

function isInvalidCredentialError(errorNameLower: string, errorMessageLower: string): boolean {
    return includesAny(errorNameLower, [
        "unrecognizedclientexception",
        "invalidclienttokenid",
        "signaturedoesnotmatch",
        "invalidsignatureexception",
        "incompletesignature"
    ]) || includesAny(errorMessageLower, [
        "security token included in the request is invalid",
        "invalidclienttokenid",
        "the security token included in the request is invalid",
        "signature does not match",
        "invalid signature"
    ]);
}

function isPermissionDeniedError(errorNameLower: string, errorMessageLower: string): boolean {
    return includesAny(errorNameLower, [
        "accessdenied",
        "accessdeniedexception",
        "unauthorizedoperation",
        "notauthorized",
        "operationnotpermitted"
    ]) || includesAny(errorMessageLower, [
        "access denied",
        "not authorized",
        "is not authorized",
        "missing required permissions",
        // Matches this module's own previously-generated permission message so that callers
        // which wrap an already-friendly error a second time (service layer, then command
        // layer) still preserve the permission-denied classification instead of falling
        // back to a generic message and losing the required-IAM-permission detail.
        "aws permissions",
        "user is not authorized"
    ]);
}

function isSsoExpiredError(errorNameLower: string, errorMessageLower: string): boolean {
    return includesAny(errorNameLower, [
        "unauthorizedssotokenerror",
        "ssotokenprovidererror",
        "tokenretrievalerror"
    ]) || includesAny(errorMessageLower, [
        "sso session",
        "sso token",
        "token has expired",
        "session has expired",
        "run aws sso login"
    ]);
}

function isInvalidRegionError(errorNameLower: string, errorMessageLower: string): boolean {
    return includesAny(errorNameLower, [
        "unknownendpoint",
        "invalidendpoint",
        "endpointerror"
    ]) || includesAny(errorMessageLower, [
        "invalid region",
        "region is missing",
        "could not resolve endpoint",
        "invalid endpoint"
    ]);
}

export function getNoProfilesMessage(): string {
    return "No AWS profiles found. Run 'aws configure' or 'aws sso login'";
}

export function getUserFriendlyErrorMessage(error: unknown, context?: ErrorContext): string {
    const errorNameLower = getErrorName(error).toLowerCase();
    const errorMessageLower = getErrorMessage(error).toLowerCase();
    const profile = context?.profile?.trim() || "selected profile";

    if (isSsoExpiredError(errorNameLower, errorMessageLower)) {
        return `SSO session expired for profile ${profile}. Run 'aws sso login'`;
    }

    if (isInvalidCredentialError(errorNameLower, errorMessageLower)) {
        return `Invalid AWS credentials for profile ${profile}`;
    }

    if (isPermissionDeniedError(errorNameLower, errorMessageLower)) {
        const base = context?.operation
            ? `${context.operation} failed due to missing AWS permissions for profile ${profile}`
            : `Missing required AWS permissions for profile ${profile}`;
        const requiredPermissions = context?.requiredPermissions?.filter((permission) => permission.trim().length > 0);

        if (requiredPermissions && requiredPermissions.length > 0) {
            return `${base}. Required IAM permission(s): ${requiredPermissions.join(", ")}`;
        }

        return base;
    }

    if (isInvalidRegionError(errorNameLower, errorMessageLower)) {
        return "Invalid AWS region selected";
    }

    // Log unmatched error names at ERROR severity so operators searching the output channel
    // for `[ERROR]` to triage a failure can correlate the user-visible generic message back
    // to the underlying SDK error name and surface gaps in the recognised-error mapping.
    const rawErrorName = getErrorName(error);
    if (rawErrorName) {
        logError(`Unrecognized AWS error pattern: ${rawErrorName} (operation: ${context?.operation ?? "unknown"})`);
    }

    if (context?.operation) {
        return `${context.operation} failed. Please check AWS configuration and try again.`;
    }

    return "AWS operation failed. Please check AWS configuration and try again.";
}
