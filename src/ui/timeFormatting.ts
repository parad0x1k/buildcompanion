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

// No explicit `timeZone` - Intl.DateTimeFormat defaults to the host's detected local timezone.
const LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, BASE_DATE_TIME_FIELDS);
const UTC_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { ...BASE_DATE_TIME_FIELDS, timeZone: "UTC" });

/**
 * Formats an ISO 8601 build timestamp for display, honoring the user's Local/UTC toggle.
 * Both modes include an explicit zone abbreviation/offset (e.g. "IST", "UTC") so it's always
 * clear which one is shown. Returns `undefined` for an empty/missing value, and falls back to
 * the raw string if it can't be parsed as a date.
 */
export function formatBuildTimestamp(
    value: string | undefined,
    format: BuildTimeDisplayFormat
): string | undefined {
    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }

    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) {
        return normalized;
    }

    return (format === "utc" ? UTC_TIME_FORMATTER : LOCAL_TIME_FORMATTER).format(date);
}
