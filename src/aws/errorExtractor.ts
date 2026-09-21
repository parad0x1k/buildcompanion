const DEFAULT_MAX_INPUT_LINES = 150;
const DEFAULT_MAX_SUMMARY_LINES = 5;

const ERROR_PATTERNS = [
    /\bERROR\b/i,
    /\bFAILED\b/i,
    /\bException\b/i,
    /\bexit status\b/i,
    /\bTraceback\b/i,
    /npm\s+ERR!/i,
    /\bfatal:/i,
    /\bcommand failed\b/i
];

const DEFAULT_FALLBACK_MESSAGE = "Build failed, but no clear error lines were detected in recent logs.";

export type ErrorExtractorOptions = {
    maxInputLines?: number;
    maxSummaryLines?: number;
};

function normalizeLine(line: string): string {
    return line
        .replace(/\t/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchesHeuristics(line: string): boolean {
    return ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

function dedupePreserveOrder(lines: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const line of lines) {
        if (seen.has(line)) {
            continue;
        }

        seen.add(line);
        unique.push(line);
    }

    return unique;
}

function findNearbyContextLine(lines: string[], targetLine: string): string | undefined {
    const index = lines.lastIndexOf(targetLine);
    if (index < 0) {
        return undefined;
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = lines[cursor];
        if (candidate && candidate !== targetLine) {
            return candidate;
        }
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor];
        if (candidate && candidate !== targetLine) {
            return candidate;
        }
    }

    return undefined;
}

export function extractErrorSummary(
    recentLogLines: string[],
    options?: ErrorExtractorOptions
): string[] {
    const maxInputLines = options?.maxInputLines ?? DEFAULT_MAX_INPUT_LINES;
    const maxSummaryLines = options?.maxSummaryLines ?? DEFAULT_MAX_SUMMARY_LINES;

    const scopedLines = recentLogLines
        .slice(-maxInputLines)
        .map(normalizeLine)
        .filter((line) => line.length > 0);

    const matchedLines = scopedLines.filter((line) => matchesHeuristics(line));
    if (matchedLines.length === 0) {
        return [DEFAULT_FALLBACK_MESSAGE];
    }

    const uniqueMatchedLines = dedupePreserveOrder(matchedLines);

    if (uniqueMatchedLines.length === 1) {
        const contextLine = findNearbyContextLine(scopedLines, uniqueMatchedLines[0]);
        if (contextLine) {
            uniqueMatchedLines.unshift(contextLine);
        }
    }

    // Keep the most recent matched lines for concise failure summary output.
    return uniqueMatchedLines.slice(-maxSummaryLines);
}
