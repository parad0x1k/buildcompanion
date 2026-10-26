import * as vscode from "vscode";
import type { ComputeType, EnvironmentType, ImagePullCredentialsType } from "@aws-sdk/client-codebuild";
import type {
    BuildOverrides,
    CuratedEnvironmentPlatform,
    ProjectConfigurationFields,
    ProjectEnvironmentVariable
} from "../aws/codebuildService";
import { notify } from "../notifications/notifier";
import { promptForVariableDetails } from "./projectEnvironmentVariables";
import { promptForBranchSelection } from "./shared";

/**
 * "override" = this build only (StartBuild overrides, nothing persisted).
 * "permanent" = writes through to the live project (UpdateProject).
 * Every picker/title in this module is worded differently per mode so a user can never lose
 * track of which one they're in partway through the wizard.
 */
export type ConfigurationMode = "override" | "permanent";

export type ConfigurationDraft = ProjectConfigurationFields;

export type ConfigurationWizardResult = {
    confirmed: boolean;
    draft: ConfigurationDraft;
    /** Only meaningful when `includeBranch` was set; the chosen source version/branch. */
    branch?: string;
};

const ENVIRONMENT_TYPE_LABELS: Record<string, string> = {
    LINUX_CONTAINER: "Linux",
    ARM_CONTAINER: "Linux (ARM/Graviton)",
    LINUX_GPU_CONTAINER: "Linux (GPU)",
    LINUX_LAMBDA_CONTAINER: "Linux (Lambda compute)",
    ARM_LAMBDA_CONTAINER: "Linux ARM (Lambda compute)",
    WINDOWS_CONTAINER: "Windows",
    WINDOWS_SERVER_2019_CONTAINER: "Windows Server 2019",
    WINDOWS_SERVER_2022_CONTAINER: "Windows Server 2022",
    LINUX_EC2: "Linux (EC2 fleet)",
    ARM_EC2: "Linux ARM (EC2 fleet)",
    WINDOWS_EC2: "Windows (EC2 fleet)",
    MAC_ARM: "macOS (Arm)"
};

const ENVIRONMENT_TYPE_ORDER: EnvironmentType[] = [
    "LINUX_CONTAINER",
    "ARM_CONTAINER",
    "LINUX_GPU_CONTAINER",
    "LINUX_LAMBDA_CONTAINER",
    "ARM_LAMBDA_CONTAINER",
    "WINDOWS_SERVER_2022_CONTAINER",
    "WINDOWS_SERVER_2019_CONTAINER",
    "WINDOWS_CONTAINER",
    "LINUX_EC2",
    "ARM_EC2",
    "WINDOWS_EC2",
    "MAC_ARM"
];

const LAMBDA_COMPUTE_TYPES: ComputeType[] = [
    "BUILD_LAMBDA_1GB",
    "BUILD_LAMBDA_2GB",
    "BUILD_LAMBDA_4GB",
    "BUILD_LAMBDA_8GB",
    "BUILD_LAMBDA_10GB"
];

const STANDARD_COMPUTE_TYPES: ComputeType[] = [
    "BUILD_GENERAL1_SMALL",
    "BUILD_GENERAL1_MEDIUM",
    "BUILD_GENERAL1_LARGE",
    "BUILD_GENERAL1_XLARGE",
    "BUILD_GENERAL1_2XLARGE"
];

const COMPUTE_TYPE_LABELS: Record<string, string> = {
    BUILD_GENERAL1_SMALL: "Small",
    BUILD_GENERAL1_MEDIUM: "Medium",
    BUILD_GENERAL1_LARGE: "Large",
    BUILD_GENERAL1_XLARGE: "X-Large",
    BUILD_GENERAL1_2XLARGE: "2X-Large",
    BUILD_LAMBDA_1GB: "Lambda - 1 GB memory",
    BUILD_LAMBDA_2GB: "Lambda - 2 GB memory",
    BUILD_LAMBDA_4GB: "Lambda - 4 GB memory",
    BUILD_LAMBDA_8GB: "Lambda - 8 GB memory",
    BUILD_LAMBDA_10GB: "Lambda - 10 GB memory",
    ATTRIBUTE_BASED_COMPUTE: "Attribute-based compute (advanced - manage in AWS Console)",
    CUSTOM_INSTANCE_TYPE: "Custom instance type (advanced - manage in AWS Console)"
};

const IMAGE_PULL_CREDENTIALS_LABELS: Record<string, string> = {
    CODEBUILD: "CodeBuild's own credentials",
    SERVICE_ROLE: "The project's service role"
};

const PLATFORM_LABELS: Record<string, string> = {
    AMAZON_LINUX: "Amazon Linux",
    DEBIAN: "Debian",
    UBUNTU: "Ubuntu",
    WINDOWS_SERVER: "Windows Server"
};

const LANGUAGE_LABELS: Record<string, string> = {
    ANDROID: "Android",
    BASE: "Base",
    DOCKER: "Docker",
    DOTNET: ".NET",
    GOLANG: "Go",
    JAVA: "Java",
    NODE_JS: "Node.js",
    PHP: "PHP",
    PYTHON: "Python",
    RUBY: "Ruby"
};

function humanize(value: string, labels: Record<string, string>): string {
    return labels[value] ?? value;
}

export function describeEnvironmentType(value: EnvironmentType | string): string {
    return humanize(value, ENVIRONMENT_TYPE_LABELS);
}

export function describeComputeType(value: ComputeType | string): string {
    return humanize(value, COMPUTE_TYPE_LABELS);
}

/**
 * Curated compute type choices for a given environment type, so the dropdown never offers a
 * combination CodeBuild would reject (e.g. a Lambda compute size for a non-Lambda environment).
 * The project's current value is always included even if it's an advanced type
 * (`ATTRIBUTE_BASED_COMPUTE`/`CUSTOM_INSTANCE_TYPE`) that this editor doesn't let you newly
 * select, so switching away and back never silently drops it from view.
 */
export function getComputeTypeChoices(environmentType: EnvironmentType, currentValue: ComputeType): ComputeType[] {
    const isLambda = environmentType === "LINUX_LAMBDA_CONTAINER" || environmentType === "ARM_LAMBDA_CONTAINER";
    const base = isLambda ? LAMBDA_COMPUTE_TYPES : STANDARD_COMPUTE_TYPES;
    return base.includes(currentValue) ? base : [...base, currentValue];
}

function formatEnvVarSummary(variables: ProjectEnvironmentVariable[]): string {
    return variables.length === 1 ? "1 variable" : `${variables.length} variables`;
}

function formatBuildspecSummary(buildspec: string, mode: ConfigurationMode): string {
    if (!buildspec.trim()) {
        return mode === "override" ? "Project's current buildspec" : "buildspec.yml in repo root";
    }

    if (buildspec.includes("\n")) {
        return "Inline buildspec content";
    }

    return buildspec;
}

function formatTimeoutsSummary(draft: ConfigurationDraft): string {
    return `Build: ${draft.timeoutInMinutes}m \u00b7 Queue: ${draft.queuedTimeoutInMinutes}m`;
}

type ConfigurationFieldKey =
    | "environmentType"
    | "computeType"
    | "image"
    | "privilegedMode"
    | "imagePullCredentialsType"
    | "buildspec"
    | "timeoutInMinutes"
    | "queuedTimeoutInMinutes"
    | "environmentVariables";

function sortedVariablesJson(variables: ProjectEnvironmentVariable[]): string {
    return JSON.stringify(variables.slice().sort((a, b) => a.name.localeCompare(b.name)));
}

/**
 * Single source of truth for "what changed" between two drafts. The diff renderer and both
 * draft-to-payload converters all derive from this set instead of re-deriving their own
 * per-field equality checks, so they can never drift out of sync with each other.
 */
function getChangedFields(baseline: ConfigurationDraft, draft: ConfigurationDraft): Set<ConfigurationFieldKey> {
    const changed = new Set<ConfigurationFieldKey>();

    if (baseline.environmentType !== draft.environmentType) {
        changed.add("environmentType");
    }
    if (baseline.computeType !== draft.computeType) {
        changed.add("computeType");
    }
    if (baseline.image !== draft.image) {
        changed.add("image");
    }
    if (baseline.privilegedMode !== draft.privilegedMode) {
        changed.add("privilegedMode");
    }
    if (baseline.imagePullCredentialsType !== draft.imagePullCredentialsType) {
        changed.add("imagePullCredentialsType");
    }
    if (baseline.buildspec !== draft.buildspec) {
        changed.add("buildspec");
    }
    if (baseline.timeoutInMinutes !== draft.timeoutInMinutes) {
        changed.add("timeoutInMinutes");
    }
    if (baseline.queuedTimeoutInMinutes !== draft.queuedTimeoutInMinutes) {
        changed.add("queuedTimeoutInMinutes");
    }
    if (sortedVariablesJson(baseline.environmentVariables) !== sortedVariablesJson(draft.environmentVariables)) {
        changed.add("environmentVariables");
    }

    return changed;
}

/** Renders a human-readable, bullet-point diff between two configuration drafts for review/confirm screens. */
export function buildConfigurationDiffLines(params: {
    baseline: ConfigurationDraft;
    draft: ConfigurationDraft;
    includeBranch: boolean;
    baselineBranch?: string;
    draftBranch?: string;
}): string[] {
    const { baseline, draft } = params;
    const changed = getChangedFields(baseline, draft);
    const lines: string[] = [];

    if (params.includeBranch) {
        const before = params.baselineBranch?.trim() || "project default";
        const after = params.draftBranch?.trim() || "project default";
        if (before !== after) {
            lines.push(`Branch / source version: ${before} \u2192 ${after}`);
        }
    }

    if (changed.has("environmentType")) {
        lines.push(`Environment type: ${describeEnvironmentType(baseline.environmentType)} \u2192 ${describeEnvironmentType(draft.environmentType)}`);
    }

    if (changed.has("computeType")) {
        lines.push(`Compute type: ${describeComputeType(baseline.computeType)} \u2192 ${describeComputeType(draft.computeType)}`);
    }

    if (changed.has("image")) {
        lines.push(`Image: ${baseline.image || "(none)"} \u2192 ${draft.image || "(none)"}`);
    }

    if (changed.has("privilegedMode")) {
        lines.push(`Privileged mode: ${baseline.privilegedMode ? "On" : "Off"} \u2192 ${draft.privilegedMode ? "On" : "Off"}`);
    }

    if (changed.has("imagePullCredentialsType")) {
        lines.push(`Image pull credentials: ${baseline.imagePullCredentialsType} \u2192 ${draft.imagePullCredentialsType}`);
    }

    if (changed.has("buildspec")) {
        lines.push(`Buildspec: ${formatBuildspecSummary(baseline.buildspec, "permanent")} \u2192 ${formatBuildspecSummary(draft.buildspec, "permanent")}`);
    }

    if (changed.has("timeoutInMinutes")) {
        lines.push(`Build timeout: ${baseline.timeoutInMinutes}m \u2192 ${draft.timeoutInMinutes}m`);
    }

    if (changed.has("queuedTimeoutInMinutes")) {
        lines.push(`Queued timeout: ${baseline.queuedTimeoutInMinutes}m \u2192 ${draft.queuedTimeoutInMinutes}m`);
    }

    if (changed.has("environmentVariables")) {
        const before = new Map(baseline.environmentVariables.map((v) => [v.name, v]));
        const after = new Map(draft.environmentVariables.map((v) => [v.name, v]));
        const added = [...after.keys()].filter((name) => !before.has(name)).length;
        const removed = [...before.keys()].filter((name) => !after.has(name)).length;
        const changedCount = [...after.keys()].filter((name) => {
            const prev = before.get(name);
            return prev && (prev.value !== after.get(name)?.value || prev.type !== after.get(name)?.type);
        }).length;

        const parts: string[] = [];
        if (added > 0) {
            parts.push(`${added} added`);
        }
        if (changedCount > 0) {
            parts.push(`${changedCount} changed`);
        }
        if (removed > 0) {
            parts.push(`${removed} removed`);
        }
        lines.push(`Environment variables: ${parts.join(", ") || "updated"}`);
    }

    return lines;
}

/**
 * Converts a draft back into the minimal `BuildOverrides` payload for `StartBuild` - only
 * fields that actually differ from the project's baseline are included, so every omitted field
 * tells CodeBuild to fall back to the project's current saved configuration for this one build.
 */
export function buildOverridesFromDraft(
    baseline: ConfigurationDraft,
    draft: ConfigurationDraft,
    branch?: string
): BuildOverrides {
    const changed = getChangedFields(baseline, draft);
    const overrides: BuildOverrides = {};

    if (branch) {
        overrides.sourceVersion = branch;
    }
    if (changed.has("environmentType")) {
        overrides.environmentTypeOverride = draft.environmentType;
    }
    if (changed.has("computeType")) {
        overrides.computeTypeOverride = draft.computeType;
    }
    if (changed.has("image")) {
        overrides.imageOverride = draft.image;
    }
    if (changed.has("privilegedMode")) {
        overrides.privilegedModeOverride = draft.privilegedMode;
    }
    if (changed.has("imagePullCredentialsType")) {
        overrides.imagePullCredentialsTypeOverride = draft.imagePullCredentialsType;
    }
    if (changed.has("buildspec")) {
        overrides.buildspecOverride = draft.buildspec;
    }
    if (changed.has("timeoutInMinutes")) {
        overrides.timeoutInMinutesOverride = draft.timeoutInMinutes;
    }
    if (changed.has("queuedTimeoutInMinutes")) {
        overrides.queuedTimeoutInMinutesOverride = draft.queuedTimeoutInMinutes;
    }
    if (changed.has("environmentVariables")) {
        overrides.environmentVariablesOverride = draft.environmentVariables;
    }

    return overrides;
}

/**
 * Converts a draft back into the minimal `Partial<ProjectConfigurationFields>` payload for
 * `updateProjectConfiguration` - only fields that actually differ from baseline are included, so
 * project settings this editor doesn't touch are never accidentally rewritten.
 */
export function buildConfigurationChanges(
    baseline: ConfigurationDraft,
    draft: ConfigurationDraft
): Partial<ConfigurationDraft> {
    const changed = getChangedFields(baseline, draft);
    const changes: Partial<ConfigurationDraft> = {};

    if (changed.has("environmentType")) {
        changes.environmentType = draft.environmentType;
    }
    if (changed.has("computeType")) {
        changes.computeType = draft.computeType;
    }
    if (changed.has("image")) {
        changes.image = draft.image;
    }
    if (changed.has("privilegedMode")) {
        changes.privilegedMode = draft.privilegedMode;
    }
    if (changed.has("imagePullCredentialsType")) {
        changes.imagePullCredentialsType = draft.imagePullCredentialsType;
    }
    if (changed.has("buildspec")) {
        changes.buildspec = draft.buildspec;
    }
    if (changed.has("timeoutInMinutes")) {
        changes.timeoutInMinutes = draft.timeoutInMinutes;
    }
    if (changed.has("queuedTimeoutInMinutes")) {
        changes.queuedTimeoutInMinutes = draft.queuedTimeoutInMinutes;
    }
    if (changed.has("environmentVariables")) {
        changes.environmentVariables = draft.environmentVariables;
    }

    return changes;
}

async function pickEnvironmentType(current: EnvironmentType): Promise<EnvironmentType | undefined> {
    const items = ENVIRONMENT_TYPE_ORDER.map((value) => ({
        label: value === current ? `$(check) ${describeEnvironmentType(value)}` : describeEnvironmentType(value),
        description: value,
        value
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: "Environment type",
        placeHolder: "Select the build environment's operating system/container type",
        ignoreFocusOut: true
    });

    return picked?.value;
}

async function pickComputeType(current: ComputeType, environmentType: EnvironmentType): Promise<ComputeType | undefined> {
    const choices = getComputeTypeChoices(environmentType, current);
    const items = choices.map((value) => ({
        label: value === current ? `$(check) ${describeComputeType(value)}` : describeComputeType(value),
        description: value,
        value
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: "Compute type",
        placeHolder: `Select the compute size to use for ${describeEnvironmentType(environmentType)}`,
        ignoreFocusOut: true
    });

    return picked?.value;
}

async function pickImage(
    current: string,
    loadCuratedImages: () => Promise<CuratedEnvironmentPlatform[]>
): Promise<string | undefined> {
    const topChoice = await vscode.window.showQuickPick(
        [
            { label: "$(list-tree) Browse AWS managed images", description: "Pick from CodeBuild's curated runtime catalog", source: "browse" as const },
            { label: "$(edit) Enter a custom image", description: `Current: ${current || "(none)"}`, source: "custom" as const }
        ],
        { title: "Image", placeHolder: "Where should this build's Docker image come from?", ignoreFocusOut: true }
    );

    if (!topChoice) {
        return undefined;
    }

    if (topChoice.source === "custom") {
        return vscode.window.showInputBox({
            title: "Custom image",
            value: current,
            prompt: "ECR/Docker Hub image URI, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-image:tag",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim().length === 0 ? "Image is required" : undefined)
        });
    }

    const platforms = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Loading AWS managed images..." },
        loadCuratedImages
    );

    if (platforms.length === 0) {
        void notify("warning", "No AWS managed images were returned. Enter a custom image instead.", { target: "status" });
        return vscode.window.showInputBox({
            title: "Custom image",
            value: current,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim().length === 0 ? "Image is required" : undefined)
        });
    }

    const platformPick = await vscode.window.showQuickPick(
        platforms.map((platform) => ({ label: humanize(platform.platform, PLATFORM_LABELS), platform })),
        { title: "Image: Operating system", ignoreFocusOut: true }
    );
    if (!platformPick) {
        return undefined;
    }

    const languagePick = await vscode.window.showQuickPick(
        platformPick.platform.languages.map((language) => ({ label: humanize(language.language, LANGUAGE_LABELS), language })),
        { title: "Image: Runtime", ignoreFocusOut: true }
    );
    if (!languagePick) {
        return undefined;
    }

    const imagePick = await vscode.window.showQuickPick(
        languagePick.language.images.map((image) => ({ label: image.name, description: image.description, image })),
        { title: "Image: Repository", ignoreFocusOut: true }
    );
    if (!imagePick) {
        return undefined;
    }

    if (imagePick.image.versions.length === 0) {
        return imagePick.image.name;
    }

    const versionPick = await vscode.window.showQuickPick(
        imagePick.image.versions.map((version) => ({ label: version, image: `${imagePick.image.name}:${version}` })),
        { title: "Image: Version", ignoreFocusOut: true }
    );

    return versionPick?.image;
}

async function pickBuildspec(current: string, mode: ConfigurationMode): Promise<string | undefined> {
    const defaultLabel = mode === "override"
        ? "$(discard) Use the project's current buildspec (no override)"
        : "$(file-code) Use buildspec.yml in the repository root";

    const choice = await vscode.window.showQuickPick(
        [
            { label: defaultLabel, option: "default" as const },
            { label: "$(symbol-file) Specify a path in the repository", description: "e.g. build/buildspec-release.yml", option: "path" as const },
            { label: "$(folder-opened) Browse a local file and inline its contents", option: "browse" as const }
        ],
        {
            title: "Buildspec",
            placeHolder: `Current: ${formatBuildspecSummary(current, mode)}`,
            ignoreFocusOut: true
        }
    );

    if (!choice) {
        return undefined;
    }

    if (choice.option === "default") {
        return "";
    }

    if (choice.option === "path") {
        return vscode.window.showInputBox({
            title: "Buildspec path",
            value: current.includes("\n") ? "" : current,
            prompt: "Path to the buildspec file, relative to the source root",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim().length === 0 ? "Enter a path, or go back and choose the default option" : undefined)
        });
    }

    const files = await vscode.window.showOpenDialog({
        title: "Select a buildspec file",
        canSelectMany: false,
        filters: { "YAML/YML": ["yml", "yaml"], "All files": ["*"] }
    });

    const file = files?.[0];
    if (!file) {
        return undefined;
    }

    const bytes = await vscode.workspace.fs.readFile(file);
    return new TextDecoder("utf-8").decode(bytes);
}

async function pickPrivilegedMode(current: boolean): Promise<boolean | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: current ? "$(check) On" : "On", description: "Required for builds that build/run Docker images (Docker-in-Docker)", value: true },
            { label: !current ? "$(check) Off" : "Off", description: "Default - use unless the build needs Docker daemon access", value: false }
        ],
        { title: "Privileged mode", ignoreFocusOut: true }
    );

    return choice?.value;
}

async function pickImagePullCredentials(current: ImagePullCredentialsType): Promise<ImagePullCredentialsType | undefined> {
    const items: Array<{ label: string; description: string; value: ImagePullCredentialsType }> = [
        { label: "CODEBUILD", description: IMAGE_PULL_CREDENTIALS_LABELS.CODEBUILD, value: "CODEBUILD" },
        { label: "SERVICE_ROLE", description: IMAGE_PULL_CREDENTIALS_LABELS.SERVICE_ROLE, value: "SERVICE_ROLE" }
    ];

    const choice = await vscode.window.showQuickPick(
        items.map((item) => (item.value === current ? { ...item, label: `$(check) ${item.label}` } : item)),
        { title: "Image pull credentials", placeHolder: "Which credentials should CodeBuild use to pull the image?", ignoreFocusOut: true }
    );

    return choice?.value;
}

async function pickNumberInput(options: { title: string; prompt: string; value: number; min: number; max: number }): Promise<number | undefined> {
    const input = await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        value: String(options.value),
        ignoreFocusOut: true,
        validateInput: (value) => {
            const parsed = Number(value.trim());
            if (!Number.isInteger(parsed)) {
                return "Enter a whole number";
            }
            if (parsed < options.min || parsed > options.max) {
                return `Enter a value between ${options.min} and ${options.max}`;
            }
            return undefined;
        }
    });

    return input === undefined ? undefined : Number(input.trim());
}

async function editEnvironmentVariablesList(
    variables: ProjectEnvironmentVariable[],
    projectName: string
): Promise<ProjectEnvironmentVariable[]> {
    let current = variables;

    while (true) {
        const items: Array<vscode.QuickPickItem & { action: "add" | "back" | "edit"; variable?: ProjectEnvironmentVariable }> = current
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((variable) => ({
                label: `$(symbol-variable) ${variable.name}`,
                description: variable.type,
                detail: variable.type === "PLAINTEXT" ? variable.value : `\u2192 ${variable.value}`,
                action: "edit",
                variable
            }));

        items.push({ label: "$(add) Add environment variable", action: "add" });
        items.push({ label: "$(arrow-left) Back to categories", action: "back" });

        const picked = await vscode.window.showQuickPick(items, {
            title: `Environment Variables: ${projectName}`,
            placeHolder: "Select a variable to edit or remove, or go back",
            ignoreFocusOut: true
        });

        if (!picked || picked.action === "back") {
            return current;
        }

        if (picked.action === "add") {
            const created = await promptForVariableDetails(current);
            if (created) {
                current = [...current, created];
            }
            continue;
        }

        const target = picked.variable;
        if (!target) {
            continue;
        }

        const otherVariables = current.filter((variable) => variable.name !== target.name);
        const choice = await vscode.window.showQuickPick(
            [
                { label: "$(edit) Edit name, type, or value", action: "edit" as const },
                { label: "$(trash) Remove variable", action: "remove" as const }
            ],
            { title: target.name, ignoreFocusOut: true }
        );

        if (!choice) {
            continue;
        }

        if (choice.action === "remove") {
            current = otherVariables;
            continue;
        }

        const updated = await promptForVariableDetails(otherVariables, target);
        if (updated) {
            current = [...otherVariables, updated];
        }
    }
}

type HubAction = "branch" | "envvars" | "compute" | "buildspec" | "privileged" | "timeouts" | "review";
type HubItem = vscode.QuickPickItem & { action?: HubAction };

/**
 * The shared "category hub" used by both Start Build with Overrides and Edit Project
 * Configuration. Presents a flat, always-visible list of setting categories (instead of one
 * long form) so the picker never shows more than a handful of rows at once, and loops back to
 * itself after every sub-editor so the user can change as many or as few settings as they want
 * before reviewing and confirming.
 */
export async function runProjectConfigurationWizard(params: {
    mode: ConfigurationMode;
    projectName: string;
    baseline: ConfigurationDraft;
    includeBranch: boolean;
    initialBranch?: string;
    loadCuratedImages: () => Promise<CuratedEnvironmentPlatform[]>;
}): Promise<ConfigurationWizardResult> {
    let draft: ConfigurationDraft = { ...params.baseline, environmentVariables: [...params.baseline.environmentVariables] };
    let branch = params.initialBranch;

    const modeLabel = params.mode === "override"
        ? "Start Build with Overrides (one-time)"
        : "\u26a0 Edit Project Configuration (permanent)";
    const reviewLabel = params.mode === "override" ? "Review & Start Build" : "Review & Update Project";
    const reviewIcon = params.mode === "override" ? "$(play-circle)" : "$(wrench)";

    while (true) {
        const diff = buildConfigurationDiffLines({
            baseline: params.baseline,
            draft,
            includeBranch: params.includeBranch,
            baselineBranch: params.initialBranch,
            draftBranch: branch
        });

        const items: HubItem[] = [];

        if (params.includeBranch) {
            items.push({
                label: "$(git-branch) Branch / source version",
                description: branch || "Project default",
                action: "branch"
            });
        }

        items.push(
            {
                label: "$(symbol-variable) Environment variables",
                description: formatEnvVarSummary(draft.environmentVariables),
                action: "envvars"
            },
            {
                label: "$(gear) Compute & image",
                description: `${describeEnvironmentType(draft.environmentType)} \u00b7 ${describeComputeType(draft.computeType)} \u00b7 ${draft.image}`,
                action: "compute"
            },
            {
                label: "$(file-code) Buildspec",
                description: formatBuildspecSummary(draft.buildspec, params.mode),
                action: "buildspec"
            },
            {
                label: "$(shield) Privileged mode & image pull credentials",
                description: `${draft.privilegedMode ? "On" : "Off"} \u00b7 ${draft.imagePullCredentialsType}`,
                action: "privileged"
            },
            {
                label: "$(clock) Timeouts",
                description: formatTimeoutsSummary(draft),
                action: "timeouts"
            },
            { label: "", kind: vscode.QuickPickItemKind.Separator },
            {
                label: `${reviewIcon} ${reviewLabel}`,
                description: diff.length > 0 ? `${diff.length} change(s)` : "No changes yet",
                action: "review"
            }
        );

        const picked = await vscode.window.showQuickPick(items, {
            title: `${modeLabel}: ${params.projectName}`,
            placeHolder: "Select a setting to change, or review & proceed",
            ignoreFocusOut: true
        });

        if (!picked || !picked.action) {
            if (diff.length > 0) {
                const discardLabel = params.mode === "override" ? "Discard Overrides" : "Discard Changes";
                const decision = await notify(
                    "warning",
                    params.mode === "override" ? "Discard these build overrides?" : "Discard unsaved project configuration changes?",
                    { modal: true, actions: [discardLabel] }
                );

                if (decision !== discardLabel) {
                    continue;
                }
            }

            return { confirmed: false, draft, branch };
        }

        switch (picked.action) {
            case "branch": {
                const newBranch = await promptForBranchSelection({
                    title: `Branch for ${params.projectName} (this build only)`,
                    prompt: "Leave empty to use the project's default source version",
                    initialValue: branch ?? ""
                });
                if (newBranch !== undefined) {
                    branch = newBranch.trim() || undefined;
                }
                break;
            }
            case "envvars": {
                const updated = await editEnvironmentVariablesList(draft.environmentVariables, params.projectName);
                draft = { ...draft, environmentVariables: updated };
                break;
            }
            case "compute": {
                const environmentType = await pickEnvironmentType(draft.environmentType);
                if (environmentType === undefined) {
                    break;
                }
                let next = { ...draft, environmentType };

                const computeType = await pickComputeType(draft.computeType, environmentType);
                if (computeType === undefined) {
                    draft = next;
                    break;
                }
                next = { ...next, computeType };

                const image = await pickImage(draft.image, params.loadCuratedImages);
                if (image === undefined) {
                    draft = next;
                    break;
                }
                draft = { ...next, image };
                break;
            }
            case "buildspec": {
                const buildspec = await pickBuildspec(draft.buildspec, params.mode);
                if (buildspec !== undefined) {
                    draft = { ...draft, buildspec };
                }
                break;
            }
            case "privileged": {
                const privilegedMode = await pickPrivilegedMode(draft.privilegedMode);
                if (privilegedMode === undefined) {
                    break;
                }
                let next = { ...draft, privilegedMode };

                const imagePullCredentialsType = await pickImagePullCredentials(draft.imagePullCredentialsType);
                if (imagePullCredentialsType !== undefined) {
                    next = { ...next, imagePullCredentialsType };
                }
                draft = next;
                break;
            }
            case "timeouts": {
                const timeoutInMinutes = await pickNumberInput({
                    title: "Build timeout (minutes)",
                    prompt: "How long a build is allowed to run before CodeBuild stops it",
                    value: draft.timeoutInMinutes,
                    min: 5,
                    max: 2160
                });
                if (timeoutInMinutes === undefined) {
                    break;
                }
                let next = { ...draft, timeoutInMinutes };

                const queuedTimeoutInMinutes = await pickNumberInput({
                    title: "Queued timeout (minutes)",
                    prompt: "How long a build is allowed to wait in the queue before timing out",
                    value: draft.queuedTimeoutInMinutes,
                    min: 5,
                    max: 2160
                });
                if (queuedTimeoutInMinutes !== undefined) {
                    next = { ...next, queuedTimeoutInMinutes };
                }
                draft = next;
                break;
            }
            case "review": {
                if (diff.length === 0) {
                    void notify("info", params.mode === "override"
                        ? "No overrides set yet - this will start a build using the project's current configuration."
                        : "No configuration changes to save.", { target: "status" });
                    if (params.mode === "permanent") {
                        continue;
                    }
                }
                return { confirmed: true, draft, branch };
            }
        }
    }
}
