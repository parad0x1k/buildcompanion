import type { BuildTimeDisplayFormat } from "../state/store";

// Built from explicit fields rather than the `dateStyle`/`timeStyle` shorthand: some Intl
// implementations reject combining those style presets with `timeZoneName`, while explicit
// fields work consistently everywhere.
const BASE_DATE_TIME_FIELDS: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
};

// No explicit `timeZone` - Intl.DateTimeFormat defaults to the EXTENSION HOST's detected system
// timezone. This extension is `extensionKind: ["workspace"]`, so in a Dev Container/WSL/SSH
// remote that's the remote machine's timezone (commonly UTC in minimal container images), not
// the developer's physical machine - making "Local" and "UTC" render identically. The
// `codebuild.localTimeZone` setting (see `getLocalFormatter`) lets users override this.
const DEFAULT_LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, BASE_DATE_TIME_FIELDS);
const UTC_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { ...BASE_DATE_TIME_FIELDS, timeZone: "UTC" });

// Memoizes the override formatter so rendering many history rows doesn't reconstruct an
// Intl.DateTimeFormat per row.
let cachedOverrideZone: string | undefined;
let cachedOverrideFormatter: Intl.DateTimeFormat | undefined;

function getLocalFormatter(localTimeZoneOverride: string | undefined): Intl.DateTimeFormat {
    const zone = localTimeZoneOverride?.trim() || undefined;
    if (!zone) {
        return DEFAULT_LOCAL_TIME_FORMATTER;
    }

    if (zone !== cachedOverrideZone) {
        try {
            cachedOverrideFormatter = new Intl.DateTimeFormat(undefined, { ...BASE_DATE_TIME_FIELDS, timeZone: zone });
            cachedOverrideZone = zone;
        } catch {
            // Invalid IANA zone name (e.g. a typo in the setting) - fall back instead of throwing.
            return DEFAULT_LOCAL_TIME_FORMATTER;
        }
    }

    return cachedOverrideFormatter ?? DEFAULT_LOCAL_TIME_FORMATTER;
}

/**
 * Formats an ISO 8601 build timestamp for display, honoring the user's Local/UTC toggle.
 * Both modes include an explicit zone abbreviation/offset (e.g. "IST", "UTC") so it's always
 * clear which one is shown. Returns `undefined` for an empty/missing value, and falls back to
 * the raw string if it can't be parsed as a date.
 *
 * `localTimeZoneOverride` (the `codebuild.localTimeZone` setting) replaces system-timezone
 * auto-detection for "local" mode - see the comment above `DEFAULT_LOCAL_TIME_FORMATTER`.
 */
export function formatBuildTimestamp(
    value: string | undefined,
    format: BuildTimeDisplayFormat,
    localTimeZoneOverride?: string
): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }

    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) {
        return normalized;
    }

    return format === "utc" ? UTC_TIME_FORMATTER.format(date) : getLocalFormatter(localTimeZoneOverride).format(date);
}
