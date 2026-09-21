import * as vscode from "vscode";
import type { AppStore } from "../state/store";

const REGION_STATE_KEY = "codebuild.currentRegion";

const MVP_REGIONS = [
    // US
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    // Canada
    "ca-central-1",
    "ca-west-1",
    // Europe
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    // Asia Pacific
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-east-1",
    // South America
    "sa-east-1",
    // Middle East & Africa
    "me-south-1",
    "me-central-1",
    "af-south-1",
    "il-central-1",
    // AWS GovCloud (US)
    "us-gov-east-1",
    "us-gov-west-1"
];

type ResolveDefaultRegionInput = {
    persistedRegion?: string;
    profileRegion?: string;
    environmentRegion?: string;
};

function normalizeRegion(region?: string): string | undefined {
    const normalized = region?.trim();
    if (!normalized) {
        return undefined;
    }

    return normalized;
}

export function getSupportedRegions(): string[] {
    return [...MVP_REGIONS];
}

export function getEnvironmentRegion(): string | undefined {
    return normalizeRegion(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION);
}

export function getPersistedRegion(context: vscode.ExtensionContext): string | undefined {
    return normalizeRegion(context.globalState.get<string>(REGION_STATE_KEY));
}

export async function persistRegion(context: vscode.ExtensionContext, region: string): Promise<void> {
    await context.globalState.update(REGION_STATE_KEY, region);
}

export function resolveDefaultRegion(input: ResolveDefaultRegionInput): string {
    return normalizeRegion(input.persistedRegion)
        ?? normalizeRegion(input.profileRegion)
        ?? normalizeRegion(input.environmentRegion)
        ?? "us-east-1";
}

const CUSTOM_REGION_PLACEHOLDER = "$(edit) Enter custom region…";

export async function switchRegion(context: vscode.ExtensionContext, store: AppStore): Promise<void> {
    const state = store.getState();
    const regions = state.regions.length > 0 ? state.regions : getSupportedRegions();
    const picks = [...regions, CUSTOM_REGION_PLACEHOLDER];

    const selected = await vscode.window.showQuickPick(picks, {
        title: "Select AWS Region",
        placeHolder: `Current: ${state.currentRegion}`
    });

    if (!selected) {
        return;
    }

    let targetRegion: string;

    if (selected === CUSTOM_REGION_PLACEHOLDER) {
        const custom = await vscode.window.showInputBox({
            title: "Enter AWS Region",
            prompt: "Enter a valid AWS region identifier (e.g. us-gov-west-1)",
            value: state.currentRegion,
            validateInput: (value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return "Region is required";
                }
                if (!/^[a-z]{2,}(?:-[a-z]+)+-\d+$/.test(trimmed)) {
                    return "Enter a valid AWS region format (e.g. us-east-1, eu-central-2)";
                }
                return undefined;
            }
        });

        if (!custom?.trim()) {
            return;
        }

        targetRegion = custom.trim();
    } else {
        targetRegion = selected;
    }

    if (targetRegion === state.currentRegion) {
        return;
    }

    store.setCurrentRegion(targetRegion);
    await persistRegion(context, targetRegion);
}
