/**
 * CDP Bridge for Antigravity agent panel instrumentation.
 *
 * Connects to Antigravity's Chrome DevTools Protocol endpoint to observe
 * agent activity (tool calls, task transitions) from the renderer process.
 *
 * Isolated behind a feature check: if CDP isn't reachable (Cursor, plain
 * VS Code, or Antigravity without --remote-debugging-port), the extension
 * continues working normally — no crash, just a warning log.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import { startSpan } from './otelEmitter.js';
import { recordTarget, resetLoopDetector, getTargetCount } from './loopDetector.js';

// chrome-remote-interface is a CommonJS module
import CDP from 'chrome-remote-interface';

/** Reconnect configuration */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2000;

/** Output channel for user-visible CDP bridge logs */
let outputChannel: vscode.OutputChannel | undefined;

/** Active CDP client, if connected */
let cdpClient: CDP.Client | undefined;

/** Whether we're intentionally shutting down (suppress reconnect) */
let isShuttingDown = false;

/** Current reconnect attempt count */
let reconnectAttempts = 0;

/** Reconnect timer handle */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** External callback fired when a task-end signal is detected via CDP */
let taskEndCallback: ((message: string) => void) | undefined;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Register a callback that fires when CDP detects a task-end signal.
 * Used by the postmortem engine to trigger report generation.
 */
export function onTaskEnd(callback: (message: string) => void): void {
    taskEndCallback = callback;
}

/**
 * Attempt to connect to Antigravity's CDP endpoint. Fails gracefully
 * if CDP isn't available.
 */
export async function activateCdpBridge(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('stuck');
    const enabled = config.get<boolean>('cdpEnabled', true);

    if (!enabled) {
        log('CDP bridge disabled via stuck.cdpEnabled setting');
        return;
    }

    outputChannel = vscode.window.createOutputChannel('Stuck CDP Bridge');
    context.subscriptions.push(outputChannel);

    context.subscriptions.push({
        dispose: () => {
            deactivateCdpBridge();
        }
    });

    await attemptConnection();
}

/**
 * Cleanly shut down the CDP connection.
 */
export function deactivateCdpBridge(): void {
    isShuttingDown = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }

    if (cdpClient) {
        cdpClient.close().catch(() => {
            // Swallow close errors during shutdown
        });
        cdpClient = undefined;
    }
}

// ─── Connection Logic ─────────────────────────────────────────────────

async function attemptConnection(): Promise<void> {
    const config = vscode.workspace.getConfiguration('stuck');
    const port = config.get<number>('cdpPort', 9000);

    log(`Attempting CDP connection on localhost:${port}...`);

    // Step 1: Discover targets via /json endpoint
    let targets: CDPTarget[];
    try {
        targets = await discoverTargets(port);
    } catch (err) {
        log(`CDP bridge: endpoint not reachable on port ${port}, skipping (${errorMessage(err)})`);
        log('This is expected on Cursor or VS Code without Antigravity.');
        return; // No reconnect — endpoint doesn't exist
    }

    if (targets.length === 0) {
        log('CDP bridge: no debuggable targets found, skipping');
        return;
    }

    // Step 2: Find the agent panel target
    const agentTarget = findAgentPanelTarget(targets);
    if (!agentTarget) {
        log('CDP bridge: no agent panel target found among debuggable targets');
        log(`  Available targets: ${targets.map(t => `"${t.title}" (${t.type})`).join(', ')}`);
        return;
    }

    log(`CDP bridge: found agent panel target "${agentTarget.title}" (${agentTarget.type})`);

    // Step 3: Connect via WebSocket
    try {
        await connectToTarget(agentTarget, port);
        reconnectAttempts = 0; // Reset on successful connection
        log('CDP bridge: connected and listening for agent activity');
    } catch (err) {
        log(`CDP bridge: failed to connect to target (${errorMessage(err)})`);
        scheduleReconnect();
    }
}

/** CDP /json target entry shape */
interface CDPTarget {
    id: string;
    title: string;
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
    description?: string;
}

/**
 * HTTP GET localhost:<port>/json to discover debuggable targets.
 */
function discoverTargets(port: number): Promise<CDPTarget[]> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/json`, { timeout: 3000 }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data) as CDPTarget[];
                    resolve(parsed);
                } catch {
                    reject(new Error(`Invalid JSON from /json endpoint: ${data.slice(0, 200)}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Connection timed out'));
        });
    });
}

/**
 * Heuristic: find the target that looks like Antigravity's agent panel.
 * Matches on title/URL keywords.
 */
function findAgentPanelTarget(targets: CDPTarget[]): CDPTarget | undefined {
    const agentKeywords = ['agent', 'chat', 'panel', 'antigravity', 'assistant', 'copilot'];

    // First pass: look for a target whose title or URL matches agent keywords
    for (const target of targets) {
        const haystack = `${target.title} ${target.url} ${target.description ?? ''}`.toLowerCase();
        if (agentKeywords.some(kw => haystack.includes(kw))) {
            return target;
        }
    }

    // Second pass: prefer "page" type targets over "other" — they're more likely
    // to be webviews with useful DOM/Network
    const pageTargets = targets.filter(t => t.type === 'page');
    if (pageTargets.length > 0) {
        return pageTargets[0];
    }

    // Last resort: return the first target with a webSocketDebuggerUrl
    return targets.find(t => t.webSocketDebuggerUrl);
}

/**
 * Connect to a specific target via chrome-remote-interface and set up
 * Network + Runtime event listeners.
 */
async function connectToTarget(target: CDPTarget, port: number): Promise<void> {
    const client = await CDP({
        host: 'localhost',
        port,
        target: target.id,
    });

    cdpClient = client;

    // Set up disconnect handler
    client.on('disconnect', () => {
        log('CDP bridge: disconnected from target');
        cdpClient = undefined;
        if (!isShuttingDown) {
            scheduleReconnect();
        }
    });

    // Enable Network domain — captures HTTP requests the agent makes
    try {
        await client.Network.enable({});
        setupNetworkListeners(client);
        log('CDP bridge: Network domain enabled');
    } catch (err) {
        log(`CDP bridge: Network domain not available (${errorMessage(err)})`);
    }

    // Enable Runtime domain — captures console output from agent panel
    try {
        await client.Runtime.enable();
        setupRuntimeListeners(client);
        log('CDP bridge: Runtime domain enabled');
    } catch (err) {
        log(`CDP bridge: Runtime domain not available (${errorMessage(err)})`);
    }

    // Enable Page domain — captures navigation/lifecycle events
    try {
        await client.Page.enable();
        setupPageListeners(client);
        log('CDP bridge: Page domain enabled');
    } catch (err) {
        log(`CDP bridge: Page domain not available (${errorMessage(err)})`);
    }
}

// ─── Event Listeners ──────────────────────────────────────────────────

/**
 * Listen for network requests to infer tool calls and API interactions.
 */
function setupNetworkListeners(client: CDP.Client): void {
    // Track in-flight requests for duration measurement
    const pendingRequests = new Map<string, { url: string; startTime: number; method: string; postData?: string }>();

    client.Network.requestWillBeSent((params: any) => {
        const { requestId, request } = params;
        const url: string = request.url;
        const method: string = request.method;
        const postData: string | undefined = request.postData;

        pendingRequests.set(requestId, {
            url,
            startTime: Date.now(),
            method,
            postData,
        });

        // Try to parse tool call info from the request
        const toolInfo = inferToolCall(url, method, postData);
        if (toolInfo) {
            const isLoop = recordTarget(toolInfo.target);
            const retryCount = getTargetCount(toolInfo.target);

            // ── Retry-loop in-editor alert ──
            if (isLoop) {
                vscode.window.showWarningMessage(
                    `Stuck: Retry loop detected — "${toolInfo.target}" has been attempted ${retryCount} times`,
                    'Dismiss',
                );
            }

            const span = startSpan('cdp_tool_call', {
                'cdp.event_type': 'tool_call',
                'cdp.tool_name': toolInfo.toolName,
                'cdp.target_file': toolInfo.target,
                'cdp.request_url': url,
                'cdp.request_method': method,
                'cdp.retry_loop': isLoop,
                'cdp.retry_count': retryCount,
                'cdp.inference_quality': toolInfo.confidence,
            });
            if (span) {
                span.end();
            }
        }
    });

    client.Network.responseReceived((params: any) => {
        const { requestId, response } = params;
        const pending = pendingRequests.get(requestId);

        if (pending) {
            const duration = Date.now() - pending.startTime;
            const status: number = response.status;

            const span = startSpan('cdp_network_response', {
                'cdp.event_type': 'network_response',
                'cdp.request_url': pending.url,
                'cdp.request_method': pending.method,
                'cdp.response_status': status,
                'cdp.duration_ms': duration,
            });
            if (span) {
                span.end();
            }

            pendingRequests.delete(requestId);
        }
    });
}

/**
 * Listen for console API calls from the agent panel — Antigravity may
 * log structured agent events here.
 */
function setupRuntimeListeners(client: CDP.Client): void {
    client.Runtime.consoleAPICalled((params: any) => {
        const type: string = params.type; // 'log', 'warn', 'error', etc.
        const args: any[] = params.args || [];

        // Extract the first string argument as the message
        const message = args
            .filter((a: any) => a.type === 'string')
            .map((a: any) => a.value as string)
            .join(' ');

        if (!message) {
            return;
        }

        // Check for task lifecycle signals in console output
        const taskSignal = inferTaskSignal(message);
        if (taskSignal) {
            if (taskSignal === 'task_end') {
                resetLoopDetector();
                // Notify the postmortem engine
                if (taskEndCallback) {
                    taskEndCallback(message);
                }
            }

            const span = startSpan('cdp_task_signal', {
                'cdp.event_type': taskSignal,
                'cdp.console_type': type,
                'cdp.message': message.slice(0, 500), // Truncate long messages
            });
            if (span) {
                span.end();
            }
            return;
        }

        // Only emit spans for warn/error console messages to avoid noise
        if (type === 'error' || type === 'warn') {
            const span = startSpan('cdp_console', {
                'cdp.event_type': 'console_log',
                'cdp.console_type': type,
                'cdp.message': message.slice(0, 500),
            });
            if (span) {
                span.end();
            }
        }
    });
}

/**
 * Listen for page lifecycle events — potential task start/end signals.
 */
function setupPageListeners(client: CDP.Client): void {
    client.Page.loadEventFired(() => {
        const span = startSpan('cdp_page_load', {
            'cdp.event_type': 'page_load',
        });
        if (span) {
            span.end();
        }
    });

    client.Page.navigatedWithinDocument((params: any) => {
        const url: string = params.url || '';
        const span = startSpan('cdp_navigation', {
            'cdp.event_type': 'navigation',
            'cdp.request_url': url,
        });
        if (span) {
            span.end();
        }
    });
}

// ─── Inference Helpers ────────────────────────────────────────────────

interface ToolCallInfo {
    toolName: string;
    target: string;
    confidence: 'high' | 'medium' | 'low';
}

/**
 * Attempt to infer a tool call from a network request.
 * This is heuristic-based since there's no official agent API.
 */
function inferToolCall(url: string, method: string, postData?: string): ToolCallInfo | null {
    // Skip non-POST requests and static assets — tool calls are almost always POSTs
    if (method !== 'POST') {
        return null;
    }

    // Skip obviously non-agent URLs
    const skipPatterns = [
        /\/telemetry/i,
        /\/analytics/i,
        /\.js$/,
        /\.css$/,
        /\.png$/,
        /\.svg$/,
        /\.woff/,
        /\/fonts\//,
    ];
    if (skipPatterns.some(p => p.test(url))) {
        return null;
    }

    // Try to parse the POST body for tool call structure
    if (postData) {
        try {
            const body = JSON.parse(postData);
            return parseToolCallBody(body, url);
        } catch {
            // Not JSON — skip
        }
    }

    // Heuristic: URL path segments that suggest tool invocation
    const toolUrlPatterns: Array<{ pattern: RegExp; toolName: string }> = [
        { pattern: /\/completions/i, toolName: 'llm_completion' },
        { pattern: /\/chat/i, toolName: 'chat_request' },
        { pattern: /\/tools?\//i, toolName: 'tool_invocation' },
        { pattern: /\/execute/i, toolName: 'execution' },
        { pattern: /\/apply/i, toolName: 'code_apply' },
        { pattern: /\/edit/i, toolName: 'code_edit' },
        { pattern: /\/search/i, toolName: 'search' },
        { pattern: /\/run/i, toolName: 'command_run' },
    ];

    for (const { pattern, toolName } of toolUrlPatterns) {
        if (pattern.test(url)) {
            return {
                toolName,
                target: extractPathFromUrl(url),
                confidence: 'low',
            };
        }
    }

    return null;
}

/**
 * Parse a JSON request body for structured tool call information.
 * Adapts to common patterns seen in agent APIs.
 */
function parseToolCallBody(body: any, url: string): ToolCallInfo | null {
    // Pattern: { tool: "name", ... } or { tool_name: "name", ... }
    const toolName = body.tool ?? body.tool_name ?? body.function ?? body.action ?? body.type;
    if (typeof toolName === 'string' && toolName) {
        // Look for a target file or command in the body
        const target = body.file ?? body.path ?? body.command ?? body.target ?? body.input?.file ?? url;

        return {
            toolName: String(toolName),
            target: String(target),
            confidence: 'high',
        };
    }

    // Pattern: { messages: [...], tools: [...] } — LLM call with tool definitions
    if (Array.isArray(body.messages) && Array.isArray(body.tools)) {
        return {
            toolName: 'llm_tool_call',
            target: extractPathFromUrl(url),
            confidence: 'medium',
        };
    }

    // Pattern: { tool_calls: [...] } — response-style with tool invocations
    if (Array.isArray(body.tool_calls) && body.tool_calls.length > 0) {
        const firstCall = body.tool_calls[0];
        const name = firstCall.function?.name ?? firstCall.name ?? 'unknown';
        const args = firstCall.function?.arguments ?? firstCall.arguments ?? '';

        let target = url;
        try {
            const parsed = typeof args === 'string' ? JSON.parse(args) : args;
            target = parsed.file ?? parsed.path ?? parsed.command ?? url;
        } catch {
            // args not parseable
        }

        return {
            toolName: String(name),
            target: String(target),
            confidence: 'high',
        };
    }

    return null;
}

/**
 * Infer task start/end signals from console messages.
 */
function inferTaskSignal(message: string): 'task_start' | 'task_end' | null {
    const lower = message.toLowerCase();

    const startPatterns = [
        'task started',
        'starting task',
        'begin task',
        'agent started',
        'execution started',
        'processing request',
    ];

    const endPatterns = [
        'task completed',
        'task finished',
        'task ended',
        'task failed',
        'agent stopped',
        'execution complete',
        'execution finished',
        'request complete',
    ];

    if (startPatterns.some(p => lower.includes(p))) {
        return 'task_start';
    }
    if (endPatterns.some(p => lower.includes(p))) {
        return 'task_end';
    }

    return null;
}

// ─── Reconnect Logic ─────────────────────────────────────────────────

function scheduleReconnect(): void {
    if (isShuttingDown || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            log(`CDP bridge: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
        }
        return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
    log(`CDP bridge: scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        attemptConnection().catch((err) => {
            log(`CDP bridge: reconnect failed (${errorMessage(err)})`);
        });
    }, delay);
}

// ─── Utilities ────────────────────────────────────────────────────────

function extractPathFromUrl(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

function log(message: string): void {
    const line = `[Stuck] ${message}`;
    console.log(line);
    outputChannel?.appendLine(line);
}
