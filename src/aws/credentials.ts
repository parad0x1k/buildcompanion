import type * as vscode from "vscode";
import {
    fromIni,
    fromNodeProviderChain
} from "@aws-sdk/credential-providers";
import type {
    AwsCredentialIdentity,
    AwsCredentialIdentityProvider
} from "@aws-sdk/types";
import { logInfo, sanitizeLogValue } from "../logging/outputChannelManager";

const TEMP_CREDENTIALS_PREFIX = "codebuild.tempCredentials.";
const TEMP_CREDENTIALS_PROFILES_KEY = "codebuild.tempCredentials.profiles";

type SerializedTemporaryCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiration: string;
};

export type ResolveCredentialsOptions = {
    secretStorage?: vscode.SecretStorage;
};

export function getTemporaryCredentialsKey(profile: string): string {
    return `${TEMP_CREDENTIALS_PREFIX}${profile}`;
}

export async function listTemporaryCredentialProfiles(secretStorage?: vscode.SecretStorage): Promise<string[]> {
    if (!secretStorage) {
        return [];
    }

    const raw = await secretStorage.get(TEMP_CREDENTIALS_PROFILES_KEY);
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw) as string[];
        if (!Array.isArray(parsed)) {
            return [];
        }

        return Array.from(new Set(
            parsed
                .map((name) => (typeof name === "string" ? name.trim() : ""))
                .filter((name) => name.length > 0)
        )).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

export async function rememberTemporaryCredentialProfile(
    profile: string,
    secretStorage?: vscode.SecretStorage
): Promise<void> {
    const normalizedProfile = profile.trim();
    if (!secretStorage || !normalizedProfile) {
        return;
    }

    const existingProfiles = await listTemporaryCredentialProfiles(secretStorage);
    if (existingProfiles.includes(normalizedProfile)) {
        return;
    }

    const nextProfiles = [...existingProfiles, normalizedProfile].sort((a, b) => a.localeCompare(b));
    await secretStorage.store(TEMP_CREDENTIALS_PROFILES_KEY, JSON.stringify(nextProfiles));
}

export async function forgetTemporaryCredentialProfile(
    profile: string,
    secretStorage?: vscode.SecretStorage
): Promise<void> {
    const normalizedProfile = profile.trim();
    if (!secretStorage || !normalizedProfile) {
        return;
    }

    const existingProfiles = await listTemporaryCredentialProfiles(secretStorage);
    if (!existingProfiles.includes(normalizedProfile)) {
        return;
    }

    const nextProfiles = existingProfiles.filter((existingProfile) => existingProfile !== normalizedProfile);
    await secretStorage.store(TEMP_CREDENTIALS_PROFILES_KEY, JSON.stringify(nextProfiles));
}

async function purgeTemporaryCredentials(profile: string, secretStorage?: vscode.SecretStorage): Promise<void> {
    const normalizedProfile = profile.trim();
    if (!secretStorage || !normalizedProfile) {
        return;
    }

    await secretStorage.delete(getTemporaryCredentialsKey(normalizedProfile));
    await forgetTemporaryCredentialProfile(normalizedProfile, secretStorage);
}

function resolveExpirationTimeMs(expiration?: string): number | undefined {
    if (!expiration) {
        return undefined;
    }

    const parsed = Date.parse(expiration);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toStaticCredentialProvider(credentials: AwsCredentialIdentity): AwsCredentialIdentityProvider {
    return async () => credentials;
}

async function tryGetTemporaryCredentials(
    profile: string,
    secretStorage?: vscode.SecretStorage
): Promise<AwsCredentialIdentityProvider | undefined> {
    const normalizedProfile = profile.trim();
    if (!secretStorage || normalizedProfile === "environment") {
        return undefined;
    }

    const raw = await secretStorage.get(getTemporaryCredentialsKey(normalizedProfile));
    if (!raw) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        // Explicit type guards — JSON.parse returns `unknown` at runtime and `as SerializedTemporaryCredentials`
        // is only a compile-time assertion. Validate that the stored object has the expected shape and types
        // before using any fields, so malformed or tampered storage can't cause unexpected downstream failures.
        if (
            !parsed
            || typeof parsed !== "object"
            || typeof (parsed as Record<string, unknown>).accessKeyId !== "string"
            || typeof (parsed as Record<string, unknown>).secretAccessKey !== "string"
        ) {
            logInfo(
                `[CREDENTIALS] Temporary AWS credentials are malformed or missing required fields for profile '${sanitizeLogValue(normalizedProfile, "profile")}'. Removing temporary record and falling back to standard provider resolution.`
            );
            await purgeTemporaryCredentials(normalizedProfile, secretStorage);
            return undefined;
        }

        const typedParsed = parsed as SerializedTemporaryCredentials;
        const expirationTimeMs = resolveExpirationTimeMs(typedParsed.expiration);
        if (expirationTimeMs === undefined) {
            logInfo(
                `[CREDENTIALS] Temporary AWS credentials missing or invalid expiration metadata for profile '${sanitizeLogValue(normalizedProfile, "profile")}'. Removing temporary record and falling back to standard provider resolution.`
            );
            await purgeTemporaryCredentials(normalizedProfile, secretStorage);
            return undefined;
        }

        if (expirationTimeMs <= Date.now()) {
            logInfo(
                `[CREDENTIALS] Temporary AWS credentials are expired for profile '${sanitizeLogValue(normalizedProfile, "profile")}'. Removing temporary record and falling back to standard provider resolution.`
            );
            await purgeTemporaryCredentials(normalizedProfile, secretStorage);
            return undefined;
        }

        if (!typedParsed.accessKeyId || !typedParsed.secretAccessKey) {
            logInfo(
                `[CREDENTIALS] Temporary AWS credentials are missing required key material for profile '${sanitizeLogValue(normalizedProfile, "profile")}'. Removing temporary record and falling back to standard provider resolution.`
            );
            await purgeTemporaryCredentials(normalizedProfile, secretStorage);
            return undefined;
        }

        return toStaticCredentialProvider({
            accessKeyId: typedParsed.accessKeyId,
            secretAccessKey: typedParsed.secretAccessKey,
            sessionToken: typedParsed.sessionToken,
            expiration: new Date(expirationTimeMs)
        });
    } catch {
        logInfo(
            `[CREDENTIALS] Temporary AWS credentials are malformed for profile '${sanitizeLogValue(normalizedProfile, "profile")}'. Removing temporary record and falling back to standard provider resolution.`
        );
        await purgeTemporaryCredentials(normalizedProfile, secretStorage);
        return undefined;
    }
}

export async function resolveAwsCredentials(
    profile: string,
    options?: ResolveCredentialsOptions
): Promise<AwsCredentialIdentityProvider> {
    const normalizedProfile = profile.trim();
    const temporaryProvider = await tryGetTemporaryCredentials(normalizedProfile, options?.secretStorage);
    if (temporaryProvider) {
        return temporaryProvider;
    }

    if (normalizedProfile === "environment") {
        return fromNodeProviderChain();
    }

    if (normalizedProfile) {
        return fromIni({ profile: normalizedProfile });
    }

    return fromNodeProviderChain();
}
