/**
 * Loop detection helper for CDP bridge.
 *
 * Tracks how many times a given target (file path, command, etc.) appears
 * within a session. If the same target appears 3+ times, it's flagged as
 * a retry loop so the span can be tagged for SigNoz queries.
 */

const LOOP_THRESHOLD = 3;

/** target key → occurrence count */
const counts = new Map<string, number>();

/**
 * Normalize a target identifier to a canonical key.
 * - File paths → basename (e.g. "/foo/bar/baz.ts" → "baz.ts")
 * - Commands  → first whitespace-delimited token (e.g. "npm run build" → "npm")
 * - Anything else → returned as-is, lowercased and trimmed
 */
function normalizeTarget(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
        return trimmed;
    }

    // Looks like a file path (contains path separators)
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        const segments = trimmed.replace(/\\/g, '/').split('/');
        return segments[segments.length - 1].toLowerCase();
    }

    // Treat as a command — take the first token
    const firstToken = trimmed.split(/\s+/)[0];
    return firstToken.toLowerCase();
}

/**
 * Record an occurrence of a target. Returns `true` if the target
 * has now been seen `LOOP_THRESHOLD` or more times (i.e. it's a retry loop).
 */
export function recordTarget(target: string): boolean {
    const key = normalizeTarget(target);
    if (!key) {
        return false;
    }

    const prev = counts.get(key) ?? 0;
    const next = prev + 1;
    counts.set(key, next);

    return next >= LOOP_THRESHOLD;
}

/**
 * Get the current count for a target (after normalization).
 */
export function getTargetCount(target: string): number {
    const key = normalizeTarget(target);
    return counts.get(key) ?? 0;
}

/**
 * Reset all counts. Call this on task-end signals to start fresh
 * for the next agent task.
 */
export function resetLoopDetector(): void {
    counts.clear();
}
