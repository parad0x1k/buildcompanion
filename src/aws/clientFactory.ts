import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import * as vscode from "vscode";
import { resolveAwsCredentials } from "./credentials";

const MAX_CLIENT_CACHE_SIZE = 16;
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

type ClientCacheEntry<TClient> = {
    client: TClient;
    createdAtMs: number;
};

const codeBuildClientCache = new Map<string, ClientCacheEntry<CodeBuildClient>>();
const cloudWatchLogsClientCache = new Map<string, ClientCacheEntry<CloudWatchLogsClient>>();

export type CreateCodeBuildClientOptions = {
    secretStorage?: vscode.SecretStorage;
};

function buildClientCacheKey(profile: string, region: string, useFips: boolean): string {
    // JSON tuple encoding avoids delimiter-collision issues in profile/region values.
    return JSON.stringify([profile.trim(), region.trim(), useFips]);
}

function parseBooleanEnv(value: string | undefined): boolean {
    if (!value) {
        return false;
    }
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
}

function shouldUseFipsEndpoint(): boolean {
    const settingValue = vscode.workspace
        .getConfiguration("codebuild")
        .get<boolean>("useFipsEndpoint", false);
    if (settingValue) {
        return true;
    }
    return parseBooleanEnv(process.env.AWS_USE_FIPS_ENDPOINT);
}

function getCachedClient<TClient>(
    cache: Map<string, ClientCacheEntry<TClient>>,
    key: string
): TClient | undefined {
    const cached = cache.get(key);
    if (!cached) {
        return undefined;
    }

    if (Date.now() - cached.createdAtMs > CLIENT_CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }

    // Refresh insertion order to approximate LRU behavior.
    cache.delete(key);
    cache.set(key, cached);
    return cached.client;
}

function destroyClientIfPossible<TClient>(client: TClient): void {
    // AWS SDK v3 clients expose an optional destroy() method to close keep-alive connections.
    // Calling it on eviction prevents connection accumulation across profile/region switches.
    if (client && typeof (client as unknown as { destroy?: () => void }).destroy === "function") {
        (client as unknown as { destroy: () => void }).destroy();
    }
}

function setCachedClient<TClient>(
    cache: Map<string, ClientCacheEntry<TClient>>,
    key: string,
    client: TClient
): void {
    cache.set(key, {
        client,
        createdAtMs: Date.now()
    });

    // Iterate insertion-ordered keys directly so we never rely on `keys().next().value`
    // (which can be `undefined` for an empty map and would silently leave the cache over-cap).
    for (const oldestKey of cache.keys()) {
        if (cache.size <= MAX_CLIENT_CACHE_SIZE) {
            break;
        }

        const evicted = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (evicted) {
            destroyClientIfPossible(evicted.client);
        }
    }
}

export function clearAwsClientCache(): void {
    for (const entry of codeBuildClientCache.values()) {
        destroyClientIfPossible(entry.client);
    }
    codeBuildClientCache.clear();

    for (const entry of cloudWatchLogsClientCache.values()) {
        destroyClientIfPossible(entry.client);
    }
    cloudWatchLogsClientCache.clear();
}

export async function createCodeBuildClient(
    profile: string,
    region: string,
    options?: CreateCodeBuildClientOptions
): Promise<CodeBuildClient> {
    if (!profile?.trim()) {
        throw new Error("AWS profile is required to create CodeBuild client");
    }

    if (!region?.trim()) {
        throw new Error("AWS region is required to create CodeBuild client");
    }

    const useFips = shouldUseFipsEndpoint();
    const cacheKey = buildClientCacheKey(profile, region, useFips);
    const cachedClient = getCachedClient(codeBuildClientCache, cacheKey);
    if (cachedClient) {
        return cachedClient;
    }

    const credentials = await resolveAwsCredentials(profile, {
        secretStorage: options?.secretStorage
    });

    const client = new CodeBuildClient({
        region,
        credentials,
        useFipsEndpoint: useFips,
        requestHandler: new NodeHttpHandler({ requestTimeout: REQUEST_TIMEOUT_MS })
    });

    setCachedClient(codeBuildClientCache, cacheKey, client);
    return client;
}

export async function createCloudWatchLogsClient(
    profile: string,
    region: string,
    options?: CreateCodeBuildClientOptions
): Promise<CloudWatchLogsClient> {
    if (!profile?.trim()) {
        throw new Error("AWS profile is required to create CloudWatch Logs client");
    }

    if (!region?.trim()) {
        throw new Error("AWS region is required to create CloudWatch Logs client");
    }

    const useFips = shouldUseFipsEndpoint();
    const cacheKey = buildClientCacheKey(profile, region, useFips);
    const cachedClient = getCachedClient(cloudWatchLogsClientCache, cacheKey);
    if (cachedClient) {
        return cachedClient;
    }

    const credentials = await resolveAwsCredentials(profile, {
        secretStorage: options?.secretStorage
    });

    const client = new CloudWatchLogsClient({
        region,
        credentials,
        useFipsEndpoint: useFips,
        requestHandler: new NodeHttpHandler({ requestTimeout: REQUEST_TIMEOUT_MS })
    });

    setCachedClient(cloudWatchLogsClientCache, cacheKey, client);
    return client;
}
