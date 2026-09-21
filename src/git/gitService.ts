import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logInfo } from "../logging/outputChannelManager";

const execFileAsync = promisify(execFile);
const DEFAULT_BRANCH_LIMIT = 5;

export type GitBranchSuggestions = {
    branches: string[];
    currentBranch?: string;
};

function normalizeBranchLine(line: string): string {
    return line.replace(/^\*\s*/, "").trim();
}

function parseGitBranchOutput(stdout: string): { branches: string[]; currentBranch?: string } {
    const parsed: string[] = [];
    let currentBranch: string | undefined;

    for (const rawLine of stdout.split("\n")) {
        const trimmedRaw = rawLine.trim();
        if (!trimmedRaw) {
            continue;
        }

        const normalized = normalizeBranchLine(rawLine);
        if (!normalized || normalized.startsWith("(")) {
            continue;
        }

        if (trimmedRaw.startsWith("*")) {
            currentBranch = normalized;
        }

        parsed.push(normalized);
    }

    const uniqueBranches = Array.from(new Set(parsed));
    if (currentBranch && !uniqueBranches.includes(currentBranch)) {
        uniqueBranches.unshift(currentBranch);
    }

    return {
        branches: uniqueBranches,
        currentBranch
    };
}

export async function getRecentGitBranchSuggestions(
    cwd: string | undefined,
    limit: number = DEFAULT_BRANCH_LIMIT
): Promise<GitBranchSuggestions> {
    const effectiveCwd = cwd?.trim() || process.cwd();
    const normalizedLimit = Math.max(1, limit);

    try {
        const { stdout } = await execFileAsync("git", ["branch", "--sort=-committerdate"], {
            cwd: effectiveCwd,
            timeout: 5000,
            maxBuffer: 1024 * 1024
        });

        const parsed = parseGitBranchOutput(stdout);
        return {
            branches: parsed.branches.slice(0, normalizedLimit),
            currentBranch: parsed.currentBranch
        };
    } catch (error) {
        // If git is unavailable or cwd is not a git repository, return no suggestions.
        logInfo(`[GIT] Branch suggestions unavailable (cwd: ${effectiveCwd}): ${String(error)}`);
        return { branches: [] };
    }
}

export async function listRecentGitBranches(
    cwd: string | undefined,
    limit: number = DEFAULT_BRANCH_LIMIT
): Promise<string[]> {
    const suggestions = await getRecentGitBranchSuggestions(cwd, limit);
    return suggestions.branches;
}
