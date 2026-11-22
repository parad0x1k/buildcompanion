import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type * as vscode from "vscode";
import type { AwsProfile } from "../state/store";
import { listTemporaryCredentialProfiles } from "./credentials";

type IniSections = Record<string, Record<string, string>>;

export type ListAwsProfilesOptions = {
    secretStorage?: vscode.SecretStorage;
};

function getAwsConfigPath(): string {
    return process.env.AWS_CONFIG_FILE ?? path.join(os.homedir(), ".aws", "config");
}

function getAwsCredentialsPath(): string {
    return process.env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".aws", "credentials");
}

async function readFileIfPresent(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return "";
    }
}

/**
 * Strips a single layer of matching surrounding quotes (`"..."` or `'...'`) from an INI value,
 * so e.g. `region = "us-west-2"` resolves to `us-west-2` rather than the literal quoted string.
 */
function stripMatchingQuotes(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }

    return value;
}

/**
 * INI parser for AWS config/credentials files, covering the common real-world format: section
 * headers, `key = value` pairs, `#`/`;` comment lines, quoted values, and indented continuation
 * lines (a value that wraps onto a following, indented line - e.g. a long `role_arn` chain).
 *
 * Known limitations (edge cases not handled, considered low-value for what this module actually
 * needs - listing profile names/type/region, not full credential resolution):
 *  - `%include` directives
 *  - Nested sub-section properties (e.g. a top-level `[sso-session NAME]` block's own keys; the
 *    simpler `sso_session = NAME` key on the profile itself, which this parser does read, is
 *    already sufficient to classify a profile as SSO)
 *
 * There is no current, stable, non-internal package to delegate this to instead:
 * `@aws-sdk/shared-ini-file-loader` is deprecated in favor of `@smithy/shared-ini-file-loader`,
 * which itself now just re-exports `@smithy/core/config` - and the relevant functions there
 * (`parseKnownFiles`, `loadSharedConfigFiles`) are explicitly marked `@internal` in that
 * package's own type declarations, i.e. not a supported public API to depend on. Keeping this
 * small, self-owned, fully-tested parser is the more maintainable choice today.
 */
export function parseIni(content: string): IniSections {
    const sections: IniSections = {};
    let currentSection: string | null = null;
    let lastKey: string | null = null;

    for (const rawLine of content.split(/\r?\n/)) {
        // Leading whitespace is the continuation signal and must be checked before trimming,
        // since trimming would make a continuation line indistinguishable from a normal one.
        const isIndented = /^[ \t]/.test(rawLine);
        const line = rawLine.trim();

        if (!line || line.startsWith("#") || line.startsWith(";")) {
            continue;
        }

        if (isIndented && currentSection && lastKey && !/^\[.+]$/.test(line)) {
            const existingValue = sections[currentSection][lastKey] ?? "";
            sections[currentSection][lastKey] = `${existingValue} ${stripMatchingQuotes(line)}`.trim();
            continue;
        }

        const sectionMatch = line.match(/^\[(.+)]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            sections[currentSection] = sections[currentSection] ?? {};
            lastKey = null;
            continue;
        }

        if (!currentSection) {
            continue;
        }

        const separatorIndex = line.indexOf("=");
        if (separatorIndex < 0) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = stripMatchingQuotes(line.slice(separatorIndex + 1).trim());
        sections[currentSection][key] = value;
        lastKey = key;
    }

    return sections;
}

function getConfigSectionName(profileName: string): string {
    return profileName === "default" ? "default" : `profile ${profileName}`;
}

function getProfileNameFromConfigSection(sectionName: string): string | null {
    if (sectionName === "default") {
        return "default";
    }

    if (sectionName.startsWith("profile ")) {
        return sectionName.slice("profile ".length).trim();
    }

    return null;
}

function hasEnvironmentCredentials(): boolean {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

    return Boolean(accessKey && secretKey);
}

function isSsoProfile(configSection: Record<string, string> | undefined): boolean {
    if (!configSection) {
        return false;
    }

    return Boolean(configSection.sso_start_url || configSection.sso_session);
}

function resolveRegion(configRegion?: string): string {
    return configRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

export async function listAwsProfiles(options?: ListAwsProfilesOptions): Promise<AwsProfile[]> {
    const [configContent, credentialsContent] = await Promise.all([
        readFileIfPresent(getAwsConfigPath()),
        readFileIfPresent(getAwsCredentialsPath())
    ]);

    let configSections: IniSections = {};
    let credentialsSections: IniSections = {};

    try {
        configSections = parseIni(configContent);
    } catch {
        configSections = {};
    }

    try {
        credentialsSections = parseIni(credentialsContent);
    } catch {
        credentialsSections = {};
    }

    const profileNames = new Set<string>();

    for (const sectionName of Object.keys(configSections)) {
        const profileName = getProfileNameFromConfigSection(sectionName);
        const normalizedName = profileName?.trim();
        if (normalizedName) {
            profileNames.add(normalizedName);
        }
    }

    for (const sectionName of Object.keys(credentialsSections)) {
        const normalizedName = sectionName.trim();
        if (normalizedName) {
            profileNames.add(normalizedName);
        }
    }

    const profiles: AwsProfile[] = Array.from(profileNames)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => {
            const configSection = configSections[getConfigSectionName(name)];

            return {
                name,
                type: isSsoProfile(configSection) ? "sso" : "local",
                region: resolveRegion(configSection?.region)
            };
        });

    if (hasEnvironmentCredentials() && !profiles.some((profile) => profile.name === "environment")) {
        profiles.push({
            name: "environment",
            type: "environment",
            region: resolveRegion()
        });
    }

    const temporaryProfiles = await listTemporaryCredentialProfiles(options?.secretStorage);
    for (const tempProfileName of temporaryProfiles) {
        if (profiles.some((profile) => profile.name === tempProfileName)) {
            continue;
        }

        profiles.push({
            name: tempProfileName,
            type: "temporary",
            region: resolveRegion()
        });
    }

    profiles.sort((a, b) => a.name.localeCompare(b.name));

    return profiles;
}
