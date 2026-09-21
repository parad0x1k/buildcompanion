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
 * Minimal INI parser for AWS config/credentials files.
 *
 * Known limitations (edge cases not handled):
 *  - Multi-line values via line-continuation backslash (`\`)
 *  - Quoted string values
 *  - `%include` directives
 *  - Nested sub-section properties (e.g. `sso_session` blocks with child keys)
 *
 * These are uncommon in practice and the standard `aws configure` tooling does not
 * generate them. If broader compatibility is needed, replace this parser with
 * `@aws-sdk/shared-ini-file-loader` which is already a transitive dependency.
 */
function parseIni(content: string): IniSections {
    const sections: IniSections = {};
    let currentSection: string | null = null;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#") || line.startsWith(";")) {
            continue;
        }

        const sectionMatch = line.match(/^\[(.+)]$/);
        if (sectionMatch) {
            currentSection = sectionMatch[1].trim();
            sections[currentSection] = sections[currentSection] ?? {};
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
        const value = line.slice(separatorIndex + 1).trim();
        sections[currentSection][key] = value;
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
