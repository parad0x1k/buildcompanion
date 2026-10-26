const STATUS_LABELS: Record<string, string> = {
    IN_PROGRESS: "In Progress",
    SUCCEEDED: "Succeeded",
    FAILED: "Failed",
    STOPPED: "Stopped",
    FAULT: "Fault",
    TIMED_OUT: "Timed Out"
};

function toTitleCase(value: string): string {
    return value
        .toLowerCase()
        .split(/[_\s]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/**
 * Renders a CodeBuild status code (e.g. `IN_PROGRESS`) as a short, human-readable label (e.g.
 * `In Progress`) for display in the tree view. Falls back to a generic title-case conversion for
 * any status not in the lookup table, so unexpected/future AWS status values still render
 * reasonably instead of as a raw SCREAMING_SNAKE_CASE code.
 */
export function formatBuildStatusLabel(status: string | undefined | null): string {
    const normalized = status?.trim();
    if (!normalized) {
        return "Unknown";
    }

    return STATUS_LABELS[normalized] ?? toTitleCase(normalized);
}
