/**
 * Postmortem Engine (Phase 3)
 *
 * Generates AI-powered incident reports when an agent session ends.
 *
 * Triggers:
 *   1. CDP bridge detects a task-end signal (immediate)
 *   2. Idle timeout — no spans emitted for stuck.idleTimeoutMinutes (default 5)
 *
 * Flow:
 *   session-end detected → query SigNoz for trace tree → build structured
 *   summary → send to LLM → save markdown report + push log to SigNoz
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import {
    getSessionTraceId,
    resetSessionTraceId,
    getOtlpEndpoint,
    onSpanEmitted,
} from './otelEmitter.js';
import { onTaskEnd } from './cdpBridge.js';

// ─── Types ────────────────────────────────────────────────────────────

interface TraceSpan {
    traceId: string;
    spanId: string;
    operationName: string;
    startTime: number;   // unix nano or ms depending on SigNoz version
    duration: number;     // nanoseconds
    tags: Record<string, string | number | boolean>;
    references?: Array<{ refType: string; traceID: string; spanID: string }>;
}

interface PhaseTiming {
    planning: number;
    editing: number;
    commands: number;
    waiting: number;
}

interface RetryInfo {
    target: string;
    count: number;
}

interface StructuredSummary {
    sessionTraceId: string;
    totalDurationMs: number;
    spanCount: number;
    phases: PhaseTiming;
    attemptedActions: string[];
    retries: RetryInfo[];
    totalRetryCount: number;
    errors: string[];
    taskEndSignal: string | null;
}

type LlmProvider = 'anthropic' | 'openai' | 'ollama';

// ─── State ────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let isGenerating = false;
let hasReceivedSpans = false;

/** External callback fired when a postmortem report is generated */
let postmortemGeneratedCallback: ((reportPath: string, traceId: string) => void) | undefined;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Activate the postmortem engine. Call after all watchers are initialised.
 */
export function activatePostmortem(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel('Stuck Postmortem');
    context.subscriptions.push(outputChannel);

    // Register for CDP task-end signals
    onTaskEnd((message: string) => {
        log(`Task-end signal received: ${message}`);
        triggerPostmortem('cdp_signal', message);
    });

    // Register for span-emitted events to manage idle timeout
    onSpanEmitted(() => {
        hasReceivedSpans = true;
        resetIdleTimer();
    });

    // Start the initial idle timer
    resetIdleTimer();

    context.subscriptions.push({
        dispose: () => {
            clearIdleTimer();
        }
    });

    log('Postmortem engine activated');
}

/**
 * Whether a postmortem is currently being generated.
 * Used by the sidebar webview to show a loading state.
 */
export function isPostmortemGenerating(): boolean {
    return isGenerating;
}

/**
 * Register a callback that fires when a postmortem report is generated.
 * Receives the relative path to the report file and the trace ID.
 */
export function onPostmortemGenerated(callback: (reportPath: string, traceId: string) => void): void {
    postmortemGeneratedCallback = callback;
}

/**
 * Parsed postmortem report structure for the webview panel.
 */
export interface ParsedReport {
    traceId: string;
    generatedAt: string;
    title: string;
    status: 'success' | 'error' | 'warning';
    summary: string;
    attemptedActions: string[];
    phases: { planning: number; editing: number; commands: number; waiting: number };
    totalDurationMs: number;
    rootCause: string | null;
    retries: Array<{ target: string; count: number }>;
    recommendations: string;
    rawMarkdown: string;
}

/**
 * Parse a postmortem .md file into a structured object for the webview.
 */
export function parseReportFile(content: string): ParsedReport {
    // Extract YAML frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    let traceId = '';
    let generatedAt = '';
    if (fmMatch) {
        const fm = fmMatch[1];
        const traceMatch = fm.match(/trace_id:\s*(.+)/);
        const dateMatch = fm.match(/generated_at:\s*(.+)/);
        if (traceMatch) { traceId = traceMatch[1].trim(); }
        if (dateMatch) { generatedAt = dateMatch[1].trim(); }
    }

    const body = fmMatch ? content.slice(fmMatch[0].length) : content;

    // Determine status from content heuristics
    const lowerBody = body.toLowerCase();
    let status: 'success' | 'error' | 'warning' = 'success';
    if (lowerBody.includes('failed') || lowerBody.includes('error') || lowerBody.includes('root cause')) {
        status = 'error';
    } else if (lowerBody.includes('retry') || lowerBody.includes('warning')) {
        status = 'warning';
    }

    // Extract title (first H1 or first significant line)
    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Agent Session Postmortem';

    // Extract sections by heading
    const sections = extractSections(body);

    // Parse attempted actions
    const attemptedActions = extractListItems(sections['what was attempted'] ?? sections['actions attempted'] ?? '');

    // Parse time breakdown
    const phases = parsePhases(sections['time breakdown'] ?? sections['time analysis'] ?? '');

    // Parse total duration from summary or metadata
    const durationMatch = body.match(/(\d+)m\s*(\d+)s/);
    const totalDurationMs = durationMatch
        ? (parseInt(durationMatch[1]) * 60 + parseInt(durationMatch[2])) * 1000
        : 0;

    // Parse root cause
    const rootCauseSection = sections['root cause hypothesis'] ?? sections['root cause'] ?? null;
    const rootCause = rootCauseSection ? rootCauseSection.replace(/^#+.*$/gm, '').trim() : null;

    // Parse retries
    const retries = parseRetries(sections['retry analysis'] ?? sections['retry loops'] ?? sections['retries'] ?? '');

    // Recommendations
    const recommendations = (sections['recommendations'] ?? '').replace(/^#+.*$/gm, '').trim();

    // Summary
    const summary = (sections['summary'] ?? '').replace(/^#+.*$/gm, '').trim();

    return {
        traceId,
        generatedAt,
        title,
        status,
        summary,
        attemptedActions,
        phases,
        totalDurationMs,
        rootCause: (rootCause && rootCause.length > 0) ? rootCause : null,
        retries,
        recommendations,
        rawMarkdown: body,
    };
}

function extractSections(markdown: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const regex = /^##\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    const headings: Array<{ title: string; start: number }> = [];

    while ((match = regex.exec(markdown)) !== null) {
        headings.push({ title: match[1].trim().toLowerCase(), start: match.index + match[0].length });
    }

    for (let i = 0; i < headings.length; i++) {
        const end = i + 1 < headings.length
            ? markdown.lastIndexOf('\n##', headings[i + 1].start - 3)
            : markdown.length;
        sections[headings[i].title] = markdown.slice(headings[i].start, end).trim();
    }

    return sections;
}

function extractListItems(section: string): string[] {
    const items: string[] = [];
    const lines = section.split('\n');
    for (const line of lines) {
        const match = line.match(/^\s*[-*]\s+(.+)/);
        if (match) {
            items.push(match[1].trim());
        }
    }
    return items;
}

function parsePhases(section: string): { planning: number; editing: number; commands: number; waiting: number } {
    const phases = { planning: 0, editing: 0, commands: 0, waiting: 0 };

    const planMatch = section.match(/planning[^|]*?\|\s*([\d.]+(?:ms|s|m))/i)
        ?? section.match(/planning[^:]*:\s*([\d.]+(?:ms|s|m\s*\d+s)?)/i);
    const editMatch = section.match(/editing[^|]*?\|\s*([\d.]+(?:ms|s|m))/i)
        ?? section.match(/editing[^:]*:\s*([\d.]+(?:ms|s|m\s*\d+s)?)/i);
    const cmdMatch = section.match(/commands?[^|]*?\|\s*([\d.]+(?:ms|s|m))/i)
        ?? section.match(/commands?[^:]*:\s*([\d.]+(?:ms|s|m\s*\d+s)?)/i);
    const waitMatch = section.match(/waiting[^|]*?\|\s*([\d.]+(?:ms|s|m))/i)
        ?? section.match(/waiting[^:]*:\s*([\d.]+(?:ms|s|m\s*\d+s)?)/i);

    if (planMatch) { phases.planning = parseDurationString(planMatch[1]); }
    if (editMatch) { phases.editing = parseDurationString(editMatch[1]); }
    if (cmdMatch) { phases.commands = parseDurationString(cmdMatch[1]); }
    if (waitMatch) { phases.waiting = parseDurationString(waitMatch[1]); }

    return phases;
}

function parseDurationString(str: string): number {
    const mMatch = str.match(/(\d+)m/);
    const sMatch = str.match(/(\d+(?:\.\d+)?)s/);
    const msMatch = str.match(/(\d+)ms/);
    let ms = 0;
    if (msMatch) { ms += parseInt(msMatch[1]); }
    else {
        if (mMatch) { ms += parseInt(mMatch[1]) * 60000; }
        if (sMatch) { ms += parseFloat(sMatch[1]) * 1000; }
    }
    return ms;
}

function parseRetries(section: string): Array<{ target: string; count: number }> {
    const retries: Array<{ target: string; count: number }> = [];
    const lines = section.split('\n');
    for (const line of lines) {
        // Matches: `- target — 5 occurrences` or `- target (5 times)`
        const match = line.match(/[-*]\s+`?([^`—(]+)`?\s*[—(]\s*(\d+)/)
            ?? line.match(/[-*]\s+(.+?)\s*:\s*(\d+)/);
        if (match) {
            retries.push({ target: match[1].trim(), count: parseInt(match[2]) });
        }
    }
    return retries;
}

// ─── Session-End Detection ────────────────────────────────────────────

function getIdleTimeoutMs(): number {
    const config = vscode.workspace.getConfiguration('stuck');
    const minutes = config.get<number>('idleTimeoutMinutes', 5);
    return minutes * 60 * 1000;
}

function resetIdleTimer(): void {
    clearIdleTimer();
    const timeoutMs = getIdleTimeoutMs();
    idleTimer = setTimeout(() => {
        // Only fire if we actually received spans during this session
        if (hasReceivedSpans) {
            log(`Idle timeout (${timeoutMs / 1000}s) elapsed, triggering postmortem`);
            triggerPostmortem('idle_timeout', null);
        }
    }, timeoutMs);
}

function clearIdleTimer(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
    }
}

// ─── Postmortem Trigger ───────────────────────────────────────────────

async function triggerPostmortem(
    trigger: 'cdp_signal' | 'idle_timeout',
    taskEndMessage: string | null,
): Promise<void> {
    if (isGenerating) {
        log('Postmortem generation already in progress, skipping');
        return;
    }

    isGenerating = true;
    clearIdleTimer();

    const traceId = getSessionTraceId();
    log(`Generating postmortem for session trace ${traceId} (trigger: ${trigger})`);

    try {
        // Step 1: Query SigNoz for the trace tree
        const spans = await queryTraceFromSignoz(traceId);

        if (spans.length === 0) {
            log('No spans found for this session, skipping postmortem');
            isGenerating = false;
            resetSessionAndRestart();
            return;
        }

        // Step 2: Build structured summary
        const summary = buildStructuredSummary(spans, traceId, taskEndMessage);

        // Step 3: Generate LLM report
        const report = await generateLlmReport(summary);

        // Step 4: Save report to workspace
        const reportPath = await saveReport(report, traceId);

        // Step 5: Push log to SigNoz
        await pushLogToSignoz(traceId, report);

        log(`Postmortem report saved to ${reportPath}`);
        vscode.window.showInformationMessage(
            `Stuck: Postmortem report generated → .agent-reports/`,
        );

        // Notify webview sidebar to refresh
        if (postmortemGeneratedCallback) {
            postmortemGeneratedCallback(reportPath, traceId);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Error generating postmortem: ${msg}`);
        vscode.window.showWarningMessage(`Stuck: Failed to generate postmortem — ${msg}`);
    } finally {
        isGenerating = false;
        resetSessionAndRestart();
    }
}

function resetSessionAndRestart(): void {
    hasReceivedSpans = false;
    resetSessionTraceId();
    resetIdleTimer();
}

// ─── SigNoz Trace Query ──────────────────────────────────────────────

async function queryTraceFromSignoz(traceId: string): Promise<TraceSpan[]> {
    const config = vscode.workspace.getConfiguration('stuck');
    const queryEndpoint = config.get<string>(
        'signozQueryEndpoint',
        'http://localhost:3301',
    );

    const url = `${queryEndpoint.replace(/\/$/, '')}/api/v1/traces/${traceId}`;
    log(`Querying SigNoz trace: ${url}`);

    try {
        const raw = await httpGet(url);
        const data = JSON.parse(raw);

        // SigNoz API v1 returns { data: { spans: [...] } } or similar
        // Handle both v1 and v3 response shapes
        const spans: TraceSpan[] = extractSpansFromResponse(data);
        log(`Retrieved ${spans.length} spans from SigNoz`);
        return spans;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`SigNoz query failed: ${msg}`);
        log('Falling back to empty trace — report will note data was unavailable');
        return [];
    }
}

/**
 * Extract spans from SigNoz API response, handling different response shapes.
 */
function extractSpansFromResponse(data: any): TraceSpan[] {
    // Shape 1: { data: [{ spans: [...] }] }
    if (data?.data && Array.isArray(data.data)) {
        const allSpans: TraceSpan[] = [];
        for (const item of data.data) {
            if (item.spans && Array.isArray(item.spans)) {
                allSpans.push(...normalizeSpans(item.spans));
            } else if (item.events && Array.isArray(item.events)) {
                allSpans.push(...normalizeSpans(item.events));
            }
        }
        if (allSpans.length > 0) {
            return allSpans;
        }
    }

    // Shape 2: { data: { result: [...] } }  (v3 query)
    if (data?.data?.result && Array.isArray(data.data.result)) {
        return normalizeSpans(data.data.result);
    }

    // Shape 3: direct array
    if (Array.isArray(data)) {
        return normalizeSpans(data);
    }

    // Shape 4: { traces: [...] } or { spans: [...] }
    if (data?.traces && Array.isArray(data.traces)) {
        return normalizeSpans(data.traces);
    }
    if (data?.spans && Array.isArray(data.spans)) {
        return normalizeSpans(data.spans);
    }

    return [];
}

function normalizeSpans(raw: any[]): TraceSpan[] {
    return raw.map((s: any) => ({
        traceId: s.traceID ?? s.traceId ?? s.trace_id ?? '',
        spanId: s.spanID ?? s.spanId ?? s.span_id ?? '',
        operationName: s.operationName ?? s.name ?? s.operation_name ?? 'unknown',
        startTime: Number(s.startTime ?? s.start_time ?? s.timestamp ?? 0),
        duration: Number(s.duration ?? s.durationNano ?? 0),
        tags: flattenTags(s.tags ?? s.attributes ?? s.process?.tags ?? {}),
        references: s.references ?? [],
    }));
}

function flattenTags(tags: any): Record<string, string | number | boolean> {
    if (Array.isArray(tags)) {
        // Jaeger-style: [{ key, value, type }]
        const result: Record<string, string | number | boolean> = {};
        for (const tag of tags) {
            result[tag.key] = tag.value;
        }
        return result;
    }
    if (typeof tags === 'object' && tags !== null) {
        return tags as Record<string, string | number | boolean>;
    }
    return {};
}

// ─── Structured Summary Builder ──────────────────────────────────────

function buildStructuredSummary(
    spans: TraceSpan[],
    traceId: string,
    taskEndMessage: string | null,
): StructuredSummary {
    const sortedSpans = [...spans].sort((a, b) => a.startTime - b.startTime);

    // Calculate total duration
    const firstStart = sortedSpans[0]?.startTime ?? 0;
    const lastEnd = sortedSpans.reduce((max, s) => {
        const end = s.startTime + s.duration;
        return end > max ? end : max;
    }, 0);
    // Duration might be in nanoseconds — convert to ms
    const totalDurationMs = (lastEnd - firstStart) > 1e12
        ? (lastEnd - firstStart) / 1e6
        : lastEnd - firstStart;

    // Classify spans into phases
    const phases: PhaseTiming = { planning: 0, editing: 0, commands: 0, waiting: 0 };
    const attemptedActions: string[] = [];
    const retryMap = new Map<string, number>();
    const errors: string[] = [];

    for (const span of sortedSpans) {
        const name = span.operationName;
        const durationMs = span.duration > 1e12 ? span.duration / 1e6 : span.duration;

        // Classify by phase
        const phase = classifySpanPhase(name, span.tags);
        phases[phase] += durationMs;

        // Collect attempted actions
        const action = describeAction(name, span.tags);
        if (action && !attemptedActions.includes(action)) {
            attemptedActions.push(action);
        }

        // Collect retry info
        if (span.tags['cdp.retry_loop'] === true || span.tags['cdp.retry_loop'] === 'true') {
            const target = String(span.tags['cdp.target_file'] ?? span.tags['cdp.tool_name'] ?? name);
            const count = Number(span.tags['cdp.retry_count'] ?? 1);
            const existing = retryMap.get(target) ?? 0;
            if (count > existing) {
                retryMap.set(target, count);
            }
        }

        // Collect errors
        if (span.tags['error'] === true || span.tags['error'] === 'true') {
            const errMsg = String(span.tags['error.message'] ?? span.tags['cdp.message'] ?? name);
            errors.push(errMsg);
        }
        if (name === 'cdp_console' && span.tags['cdp.console_type'] === 'error') {
            errors.push(String(span.tags['cdp.message'] ?? 'console error'));
        }
    }

    // Convert retry map to array
    const retries: RetryInfo[] = [];
    let totalRetryCount = 0;
    for (const [target, count] of retryMap.entries()) {
        retries.push({ target, count });
        totalRetryCount += count;
    }

    return {
        sessionTraceId: traceId,
        totalDurationMs: Math.round(totalDurationMs),
        spanCount: spans.length,
        phases: {
            planning: Math.round(phases.planning),
            editing: Math.round(phases.editing),
            commands: Math.round(phases.commands),
            waiting: Math.round(phases.waiting),
        },
        attemptedActions,
        retries,
        totalRetryCount,
        errors,
        taskEndSignal: taskEndMessage,
    };
}

function classifySpanPhase(
    name: string,
    tags: Record<string, string | number | boolean>,
): keyof PhaseTiming {
    const toolName = String(tags['cdp.tool_name'] ?? '');

    // Planning: LLM calls, chat requests
    if (
        name.includes('llm') || name.includes('completion') ||
        name.includes('chat') || toolName.includes('llm') ||
        toolName === 'chat_request'
    ) {
        return 'planning';
    }

    // Editing: file saves, code edits/applies
    if (
        name === 'file_save' || name.includes('edit') ||
        name.includes('apply') || toolName.includes('edit') ||
        toolName === 'code_apply'
    ) {
        return 'editing';
    }

    // Commands: terminal commands, execution, search
    if (
        name === 'terminal_command' || name.includes('run') ||
        name.includes('execute') || name.includes('search') ||
        toolName === 'command_run' || toolName === 'execution'
    ) {
        return 'commands';
    }

    // Everything else is waiting/overhead
    return 'waiting';
}

function describeAction(
    name: string,
    tags: Record<string, string | number | boolean>,
): string | null {
    const toolName = tags['cdp.tool_name'];
    const target = tags['cdp.target_file'];

    if (name === 'file_save' && target) {
        return `Saved file: ${target}`;
    }
    if (name === 'terminal_command') {
        return `Ran terminal command`;
    }
    if (name === 'git_commit') {
        return `Made git commit`;
    }
    if (name === 'cdp_tool_call' && toolName) {
        const targetStr = target ? ` on ${target}` : '';
        return `Tool call: ${toolName}${targetStr}`;
    }
    if (name === 'cdp_task_signal') {
        return `Task signal: ${tags['cdp.event_type'] ?? name}`;
    }

    return null;
}

// ─── LLM Report Generation ──────────────────────────────────────────

async function generateLlmReport(summary: StructuredSummary): Promise<string> {
    const config = vscode.workspace.getConfiguration('stuck');
    const provider = detectLlmProvider(config);

    log(`Using LLM provider: ${provider}`);

    const prompt = buildPrompt(summary);

    try {
        switch (provider) {
            case 'anthropic':
                return await callAnthropic(config, prompt);
            case 'openai':
                return await callOpenAi(config, prompt);
            case 'ollama':
                return await callOllama(config, prompt);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`LLM call failed (${provider}): ${msg}`);
        // Fallback: produce a structured-but-unnarrated report
        return buildFallbackReport(summary);
    }
}

function detectLlmProvider(config: vscode.WorkspaceConfiguration): LlmProvider {
    // Explicit setting takes priority
    const explicit = config.get<string>('llmProvider', '');
    if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'ollama') {
        return explicit;
    }

    // Auto-detect from which key is set
    if (config.get<string>('anthropicApiKey', '')) {
        return 'anthropic';
    }
    if (config.get<string>('openaiApiKey', '')) {
        return 'openai';
    }

    // Default to Ollama (no key needed)
    return 'ollama';
}

function buildPrompt(summary: StructuredSummary): string {
    const phasesText = [
        `  - Planning (LLM calls): ${formatDuration(summary.phases.planning)}`,
        `  - Editing (file changes): ${formatDuration(summary.phases.editing)}`,
        `  - Commands (terminal): ${formatDuration(summary.phases.commands)}`,
        `  - Waiting/overhead: ${formatDuration(summary.phases.waiting)}`,
    ].join('\n');

    const actionsText = summary.attemptedActions.length > 0
        ? summary.attemptedActions.map(a => `  - ${a}`).join('\n')
        : '  - No specific actions captured';

    const retriesText = summary.retries.length > 0
        ? summary.retries.map(r => `  - ${r.target} (${r.count} times)`).join('\n')
        : '  - None';

    const errorsText = summary.errors.length > 0
        ? summary.errors.map(e => `  - ${e}`).join('\n')
        : '  - None';

    const taskEndText = summary.taskEndSignal
        ? `The session ended with a task signal: "${summary.taskEndSignal}"`
        : 'The session ended due to idle timeout (no agent activity detected).';

    return `You are analyzing an AI coding agent session. Generate a postmortem report in markdown format.

## Session Data

- **Session Trace ID:** ${summary.sessionTraceId}
- **Total Duration:** ${formatDuration(summary.totalDurationMs)}
- **Total Spans:** ${summary.spanCount}
- **Total Retries:** ${summary.totalRetryCount}

### Time Breakdown by Phase
${phasesText}

### Actions Attempted
${actionsText}

### Retry Loops (file/command repeated 3+ times)
${retriesText}

### Errors Detected
${errorsText}

### Session End
${taskEndText}

## Instructions

Generate a postmortem report with these sections:

1. **Summary** — 2-3 sentence overview of what happened in this session.
2. **What Was Attempted** — List the key actions the agent took, in chronological order.
3. **Time Analysis** — How time was distributed across phases. Call out if any phase seems disproportionate (e.g. 80% planning with little editing might mean the agent was stuck in a loop).
4. **Retry Analysis** — If there were retries, explain which targets were retried and hypothesize why. If no retries, note that the session was clean.
5. **Root Cause Hypothesis** — If there were errors or the session ended abnormally, provide a hypothesis about what went wrong. If the session was successful, note that.
6. **Recommendations** — Brief suggestions for the human developer (e.g. "consider breaking the file into smaller modules if edits keep conflicting").

Use a professional but concise tone. Write in markdown with proper headings. Do not include raw trace IDs or span IDs in the report body — keep it human-readable.`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

// ─── LLM Provider Implementations ────────────────────────────────────

async function callAnthropic(
    config: vscode.WorkspaceConfiguration,
    prompt: string,
): Promise<string> {
    const apiKey = config.get<string>('anthropicApiKey', '');
    if (!apiKey) {
        throw new Error('stuck.anthropicApiKey is not set');
    }

    const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [
            { role: 'user', content: prompt },
        ],
    });

    const response = await httpRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body,
        useHttps: true,
    });

    const data = JSON.parse(response);
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    if (!textBlock?.text) {
        throw new Error('Anthropic returned no text content');
    }
    return textBlock.text;
}

async function callOpenAi(
    config: vscode.WorkspaceConfiguration,
    prompt: string,
): Promise<string> {
    const apiKey = config.get<string>('openaiApiKey', '');
    if (!apiKey) {
        throw new Error('stuck.openaiApiKey is not set');
    }

    const body = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: 'You are a technical postmortem report generator for AI coding agent sessions.' },
            { role: 'user', content: prompt },
        ],
        max_tokens: 2048,
    });

    const response = await httpRequest({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body,
        useHttps: true,
    });

    const data = JSON.parse(response);
    const message = data.choices?.[0]?.message?.content;
    if (!message) {
        throw new Error('OpenAI returned no message content');
    }
    return message;
}

async function callOllama(
    config: vscode.WorkspaceConfiguration,
    prompt: string,
): Promise<string> {
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
    const model = config.get<string>('ollamaModel', 'llama3');

    const parsed = new URL(endpoint);
    const body = JSON.stringify({
        model,
        prompt,
        stream: false,
    });

    const response = await httpRequest({
        hostname: parsed.hostname,
        port: Number(parsed.port) || 11434,
        path: '/api/generate',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body,
        useHttps: parsed.protocol === 'https:',
    });

    const data = JSON.parse(response);
    if (!data.response) {
        throw new Error('Ollama returned no response content');
    }
    return data.response;
}

/**
 * Fallback report when no LLM is available — pure structured data, no narrative.
 */
function buildFallbackReport(summary: StructuredSummary): string {
    const lines: string[] = [
        '# Agent Session Postmortem',
        '',
        '> ⚠️ This report was generated without an LLM. Configure `stuck.llmProvider` and the relevant API key/endpoint for richer analysis.',
        '',
        '## Summary',
        '',
        `Session lasted **${formatDuration(summary.totalDurationMs)}** with **${summary.spanCount}** spans recorded.`,
        '',
        '## Time Breakdown',
        '',
        `| Phase | Duration |`,
        `|-------|----------|`,
        `| Planning | ${formatDuration(summary.phases.planning)} |`,
        `| Editing | ${formatDuration(summary.phases.editing)} |`,
        `| Commands | ${formatDuration(summary.phases.commands)} |`,
        `| Waiting | ${formatDuration(summary.phases.waiting)} |`,
        '',
        '## Actions Attempted',
        '',
    ];

    if (summary.attemptedActions.length > 0) {
        for (const action of summary.attemptedActions) {
            lines.push(`- ${action}`);
        }
    } else {
        lines.push('- No specific actions captured');
    }

    lines.push('', '## Retry Loops', '');
    if (summary.retries.length > 0) {
        lines.push(`Total retry count: **${summary.totalRetryCount}**`, '');
        for (const r of summary.retries) {
            lines.push(`- \`${r.target}\` — ${r.count} occurrences`);
        }
    } else {
        lines.push('No retry loops detected.');
    }

    lines.push('', '## Errors', '');
    if (summary.errors.length > 0) {
        for (const e of summary.errors) {
            lines.push(`- ${e}`);
        }
    } else {
        lines.push('No errors detected.');
    }

    lines.push('', '## Session End', '');
    lines.push(summary.taskEndSignal
        ? `Task ended with signal: "${summary.taskEndSignal}"`
        : 'Session ended due to idle timeout.');

    return lines.join('\n');
}

// ─── Report Output ───────────────────────────────────────────────────

async function saveReport(report: string, traceId: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const reportsDir = vscode.Uri.joinPath(workspaceRoot, '.agent-reports');

    // Ensure the directory exists
    try {
        await vscode.workspace.fs.createDirectory(reportsDir);
    } catch {
        // Directory may already exist — that's fine
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const shortTraceId = traceId.slice(0, 8);
    const filename = `postmortem-${timestamp}-${shortTraceId}.md`;
    const filePath = vscode.Uri.joinPath(reportsDir, filename);

    // Prepend metadata header
    const fullReport = [
        '---',
        `trace_id: ${traceId}`,
        `generated_at: ${new Date().toISOString()}`,
        `generator: stuck-postmortem-engine`,
        '---',
        '',
        report,
    ].join('\n');

    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(filePath, encoder.encode(fullReport));

    log(`Report saved: ${filePath.fsPath}`);
    return path.relative(workspaceRoot.fsPath, filePath.fsPath);
}

async function pushLogToSignoz(traceId: string, report: string): Promise<void> {
    const endpoint = getOtlpEndpoint();
    const logsUrl = `${endpoint}/v1/logs`;

    const logBody = JSON.stringify({
        resourceLogs: [{
            resource: {
                attributes: [{
                    key: 'service.name',
                    value: { stringValue: 'stuck-extension' },
                }],
            },
            scopeLogs: [{
                scope: { name: 'stuck-postmortem' },
                logRecords: [{
                    timeUnixNano: String(Date.now() * 1_000_000),
                    severityText: 'INFO',
                    body: {
                        stringValue: report.slice(0, 32_000), // OTLP has limits
                    },
                    attributes: [
                        {
                            key: 'stuck.report_type',
                            value: { stringValue: 'postmortem' },
                        },
                        {
                            key: 'stuck.trace_id',
                            value: { stringValue: traceId },
                        },
                    ],
                    traceId: hexToBase64(traceId),
                }],
            }],
        }],
    });

    try {
        const parsed = new URL(logsUrl);
        await httpRequest({
            hostname: parsed.hostname,
            port: Number(parsed.port) || undefined,
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: logBody,
            useHttps: parsed.protocol === 'https:',
        });
        log('Postmortem log event pushed to SigNoz');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to push log to SigNoz: ${msg} (non-fatal)`);
        // Non-fatal: report is still saved to disk
    }
}

/**
 * Convert a hex string trace ID to base64 for OTLP log records.
 */
function hexToBase64(hex: string): string {
    const bytes = Buffer.from(hex, 'hex');
    return bytes.toString('base64');
}

// ─── HTTP Helpers ────────────────────────────────────────────────────

interface HttpRequestOptions {
    hostname: string;
    port?: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    useHttps: boolean;
}

function httpGet(url: string): Promise<string> {
    const parsed = new URL(url);
    return httpRequest({
        hostname: parsed.hostname,
        port: Number(parsed.port) || undefined,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {},
        useHttps: parsed.protocol === 'https:',
    });
}

function httpRequest(options: HttpRequestOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const transport = options.useHttps ? https : http;

        const req = transport.request(
            {
                hostname: options.hostname,
                port: options.port,
                path: options.path,
                method: options.method,
                headers: options.headers,
                timeout: 30_000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    const status = res.statusCode ?? 0;
                    if (status >= 200 && status < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`HTTP ${status}: ${data.slice(0, 500)}`));
                    }
                });
            },
        );

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// ─── Utilities ───────────────────────────────────────────────────────

function log(message: string): void {
    const line = `[Stuck Postmortem] ${message}`;
    console.log(line);
    outputChannel?.appendLine(line);
}
