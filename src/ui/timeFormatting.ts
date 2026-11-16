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
 * Formats an elapsed time as a compact "1h 2m 3s" style string, omitting zero-valued trailing
 * units ("5m", "1h 5s"). Returns `undefined` for a missing or non-finite value so callers can
 * decide their own placeholder text.
 */
export function formatElapsed(totalSeconds: number | undefined): string | undefined {
    if (totalSeconds === undefined || !Number.isFinite(totalSeconds)) {
        return undefined;
    }

    const whole = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const seconds = whole % 60;

    const parts: string[] = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }
    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds}s`);
    }

    return parts.join(" ");
}

/**
 * How long a build ran, in seconds. Prefers the precomputed `durationSeconds` and otherwise
 * derives it from the start/end timestamps; `undefined` when neither is usable.
 */
export function resolveBuildDurationSeconds(build: {
    durationSeconds?: number;
    startedAt?: string;
    endedAt?: string;
}): number | undefined {
    if (build.durationSeconds !== undefined && Number.isFinite(build.durationSeconds) && build.durationSeconds >= 0) {
        return build.durationSeconds;
    }

    if (!build.startedAt || !build.endedAt) {
        return undefined;
    }

    const startedAtMs = new Date(build.startedAt).getTime();
    const endedAtMs = new Date(build.endedAt).getTime();
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
        return undefined;
    }

    return Math.round((endedAtMs - startedAtMs) / 1000);
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
