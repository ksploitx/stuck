/**
 * Postmortem Report Panel — WebviewPanel
 *
 * Opens a full editor panel displaying a parsed postmortem report
 * with structured sections matching the postmortem-report.html mockup.
 */

import * as vscode from 'vscode';
import { parseReportFile, type ParsedReport } from '../postmortem.js';

// ─── State ────────────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Open (or re-use) a webview panel to display a postmortem report.
 */
export async function openPostmortemPanel(
    context: vscode.ExtensionContext,
    filePath: string,
    traceId?: string,
): Promise<void> {
    // Read the report file
    let content: string;
    try {
        const uri = vscode.Uri.file(filePath);
        const bytes = await vscode.workspace.fs.readFile(uri);
        content = new TextDecoder().decode(bytes);
    } catch (err) {
        vscode.window.showErrorMessage(`Stuck: Could not read report file — ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    // Parse the report
    const report = parseReportFile(content);

    // Override traceId if passed explicitly
    if (traceId && !report.traceId) {
        report.traceId = traceId;
    }

    // Create or reveal panel
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
    } else {
        currentPanel = vscode.window.createWebviewPanel(
            'stuck-postmortem',
            `Postmortem: ${report.title}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri],
            },
        );

        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        }, null, context.subscriptions);
    }

    currentPanel.title = `Postmortem: ${report.title}`;

    // Check SigNoz reachability
    const signozReachable = await checkSignozReachable();

    // Handle messages from the webview
    currentPanel.webview.onDidReceiveMessage(
        (message: { type: string; url?: string }) => {
            if (message.type === 'openSignoz' && message.url) {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
        },
        undefined,
        context.subscriptions,
    );

    currentPanel.webview.html = getReportHtml(report, signozReachable);
}

// ─── SigNoz Health Check ──────────────────────────────────────────────

async function checkSignozReachable(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('stuck');
    const endpoint = config.get<string>('signozQueryEndpoint', 'http://localhost:3301');

    try {
        const http = await import('http');
        return new Promise<boolean>((resolve) => {
            const req = http.get(`${endpoint}/api/v1/health`, { timeout: 3000 }, (res) => {
                resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    } catch {
        return false;
    }
}

// ─── HTML Rendering ───────────────────────────────────────────────────

function getReportHtml(report: ParsedReport, signozReachable: boolean): string {
    const nonce = getNonce();

    // Build SigNoz URL
    const config = vscode.workspace.getConfiguration('stuck');
    const signozEndpoint = config.get<string>('signozQueryEndpoint', 'http://localhost:3301');
    const signozUrl = report.traceId
        ? `${signozEndpoint.replace(/\/$/, '')}/trace/${report.traceId}`
        : '';

    // Status badge
    const statusLabel = report.status === 'success' ? '✓ Completed'
        : report.status === 'error' ? '✗ Failed'
        : '⟳ Warnings';
    const statusClass = report.status;

    // Time breakdown bar
    const totalPhaseMs = report.phases.planning + report.phases.editing + report.phases.commands + report.phases.waiting;
    const pct = (v: number) => totalPhaseMs > 0 ? Math.round((v / totalPhaseMs) * 100) : 0;
    const planPct = pct(report.phases.planning);
    const editPct = pct(report.phases.editing);
    const cmdPct = pct(report.phases.commands);
    const waitPct = 100 - planPct - editPct - cmdPct;

    // Attempted actions
    const actionsHtml = report.attemptedActions.length > 0
        ? `<ul class="action-list">${report.attemptedActions.map(a => {
            const tagged = a.replace(/`([^`]+)`/g, '<span class="action-tag">$1</span>');
            return `<li>${escapeHtml(a).replace(/`([^`]+)`/g, '<span class="action-tag">$1</span>')}</li>`;
        }).join('')}</ul>`
        : '<p>No specific actions captured.</p>';

    // Root cause card
    const rootCauseHtml = report.rootCause
        ? `<div class="root-cause-card">
            <h3>⚠ Root Cause Hypothesis</h3>
            <p>${escapeHtml(report.rootCause)}</p>
           </div>`
        : '';

    // Retries section
    const retriesHtml = report.retries.length > 0
        ? report.retries.map(r => `
            <div class="retry-item">
                <span class="target">${escapeHtml(r.target)}</span>
                <span class="count">⟳ ${r.count}×</span>
            </div>`).join('')
        : '<p>No retry loops detected.</p>';

    // SigNoz button
    const signozButtonHtml = signozUrl
        ? `<button class="signoz-button${signozReachable ? '' : ' disabled'}"
                   data-url="${escapeHtml(signozUrl)}"
                   ${signozReachable ? '' : 'title="SigNoz not reachable"'}>
               <span class="icon">↗</span>
               View Trace in SigNoz
           </button>`
        : '';

    // Formatted date
    const dateStr = report.generatedAt
        ? new Date(report.generatedAt).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
          }) + ' · ' + new Date(report.generatedAt).toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit',
          })
        : '';

    // Duration text
    const durationText = report.totalDurationMs > 0
        ? formatDuration(report.totalDurationMs)
        : '';

    // Recommendations
    const recsHtml = report.recommendations
        ? `<p>${escapeHtml(report.recommendations)}</p>`
        : '<p>No specific recommendations.</p>';

    // Summary
    const summaryHtml = report.summary
        ? `<p>${escapeHtml(report.summary)}</p>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
    <style nonce="${nonce}">
        :root {
            --bg-primary:      #1a1a2e;
            --bg-secondary:    #16213e;
            --bg-tertiary:     #0f3460;
            --bg-surface:      #1e1e3a;
            --text-primary:    #e0e0e0;
            --text-secondary:  #a0a0b8;
            --text-muted:      #6c6c8a;
            --text-inverse:    #1a1a2e;
            --status-success:  #4ade80;
            --status-warning:  #fbbf24;
            --status-error:    #f87171;
            --accent-primary:  #7c3aed;
            --accent-hover:    #6d28d9;
            --accent-link:     #818cf8;
            --phase-planning:  #818cf8;
            --phase-editing:   #4ade80;
            --phase-commands:  #fbbf24;
            --phase-waiting:   #6c6c8a;
            --border-subtle:   #2a2a4a;
            --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;
            --radius-s: 4px; --radius-m: 6px; --radius-l: 8px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            max-width: 700px;
            margin: 0 auto;
            padding: var(--sp-4);
        }

        /* ── Header ── */
        .report-header { margin-bottom: var(--sp-5); }
        .badge-row {
            display: flex; align-items: center;
            gap: var(--sp-2); margin-bottom: var(--sp-2);
        }
        .status-badge {
            display: inline-flex; align-items: center; gap: var(--sp-1);
            font-size: 11px; font-weight: 700;
            padding: 3px 10px; border-radius: var(--radius-s);
            text-transform: uppercase; letter-spacing: 0.3px;
        }
        .status-badge.success { background: rgba(74,222,128,0.15); color: var(--status-success); }
        .status-badge.error   { background: rgba(248,113,113,0.15); color: var(--status-error); }
        .status-badge.warning { background: rgba(251,191,36,0.15); color: var(--status-warning); }
        .report-title {
            font-size: 18px; font-weight: 600;
            color: var(--text-primary); line-height: 1.3;
            margin-bottom: var(--sp-1);
        }
        .report-meta {
            font-size: 11px; color: var(--text-muted);
        }
        .report-meta span + span::before { content: ' · '; }

        /* ── Sections ── */
        .section { margin-bottom: var(--sp-5); }
        .section h2 {
            font-size: 14px; font-weight: 600;
            color: var(--text-primary);
            margin-bottom: var(--sp-3);
            padding-bottom: var(--sp-1);
            border-bottom: 1px solid var(--border-subtle);
        }
        .section p {
            color: var(--text-secondary);
            line-height: 1.6; margin-bottom: var(--sp-2);
        }

        /* ── Actions List ── */
        .action-list { list-style: none; }
        .action-list li {
            display: flex; align-items: flex-start; gap: var(--sp-2);
            padding: var(--sp-1) 0; color: var(--text-secondary); font-size: 13px;
        }
        .action-list li::before {
            content: '→'; color: var(--text-muted);
            flex-shrink: 0; margin-top: 1px;
        }
        .action-tag {
            font-family: 'SF Mono','Cascadia Code','Fira Code',monospace;
            font-size: 12px; color: var(--accent-link);
            background: rgba(129,140,248,0.1);
            padding: 1px 5px; border-radius: 3px;
        }

        /* ── Time Bar ── */
        .time-bar-container { margin-bottom: var(--sp-3); }
        .time-bar {
            display: flex; height: 8px;
            border-radius: var(--radius-s);
            overflow: hidden; background: var(--bg-surface);
            margin-bottom: var(--sp-2);
        }
        .time-bar .segment { height: 100%; transition: width 0.3s ease; }
        .time-bar .segment.planning { background: var(--phase-planning); }
        .time-bar .segment.editing  { background: var(--phase-editing); }
        .time-bar .segment.commands { background: var(--phase-commands); }
        .time-bar .segment.waiting  { background: var(--phase-waiting); }
        .time-legend { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
        .time-legend-item {
            display: inline-flex; align-items: center;
            gap: var(--sp-1); font-size: 11px; color: var(--text-secondary);
        }
        .time-legend-item .dot {
            width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        }
        .time-legend-item .dot.planning { background: var(--phase-planning); }
        .time-legend-item .dot.editing  { background: var(--phase-editing); }
        .time-legend-item .dot.commands { background: var(--phase-commands); }
        .time-legend-item .dot.waiting  { background: var(--phase-waiting); }

        /* ── Root Cause Card ── */
        .root-cause-card {
            background: rgba(248,113,113,0.08);
            border-left: 3px solid var(--status-error);
            padding: var(--sp-3); border-radius: var(--radius-m);
            margin-bottom: var(--sp-5);
        }
        .root-cause-card h3 {
            font-size: 13px; font-weight: 600;
            color: var(--status-error); margin-bottom: var(--sp-2);
        }
        .root-cause-card p {
            color: var(--text-secondary); font-size: 13px; line-height: 1.6;
        }

        /* ── Retries ── */
        .retry-item {
            display: flex; align-items: center; justify-content: space-between;
            padding: var(--sp-2); background: var(--bg-secondary);
            border-radius: var(--radius-s); margin-bottom: var(--sp-1);
        }
        .retry-item .target {
            font-family: 'SF Mono','Cascadia Code','Fira Code',monospace;
            font-size: 12px; color: var(--text-primary);
        }
        .retry-item .count {
            font-size: 11px; font-weight: 700;
            color: var(--status-warning);
            background: rgba(251,191,36,0.15);
            padding: 2px 8px; border-radius: var(--radius-s);
        }

        /* ── Footer ── */
        .report-footer {
            margin-top: var(--sp-6); padding-top: var(--sp-4);
            border-top: 1px solid var(--border-subtle);
        }
        .signoz-button {
            display: inline-flex; align-items: center; justify-content: center;
            gap: var(--sp-2); width: 100%;
            padding: var(--sp-2) var(--sp-4);
            background: var(--accent-primary); color: #ffffff;
            font-size: 13px; font-weight: 500;
            border: none; border-radius: var(--radius-m);
            cursor: pointer; transition: background 0.15s ease;
            text-decoration: none;
        }
        .signoz-button:hover { background: var(--accent-hover); }
        .signoz-button.disabled {
            opacity: 0.5; cursor: not-allowed;
        }
        .signoz-button .icon { font-size: 14px; }

        /* ── Fallback / Error ── */
        .fallback-card {
            background: var(--bg-secondary);
            padding: var(--sp-4); border-radius: var(--radius-m);
            border: 1px solid var(--border-subtle);
        }
        .fallback-card pre {
            white-space: pre-wrap; word-break: break-word;
            font-family: 'SF Mono','Cascadia Code','Fira Code',monospace;
            font-size: 12px; color: var(--text-secondary);
        }
    </style>
</head>
<body>

    <!-- Header -->
    <div class="report-header">
        <div class="badge-row">
            <span class="status-badge ${statusClass}">${statusLabel}</span>
        </div>
        <h1 class="report-title">${escapeHtml(report.title)}</h1>
        <div class="report-meta">
            ${dateStr ? `<span>${dateStr}</span>` : ''}
            ${durationText ? `<span>${durationText}</span>` : ''}
        </div>
    </div>

    <!-- Summary -->
    ${summaryHtml ? `<div class="section"><h2>Summary</h2>${summaryHtml}</div>` : ''}

    <!-- Attempted -->
    <div class="section">
        <h2>What Was Attempted</h2>
        ${actionsHtml}
    </div>

    <!-- Time Breakdown -->
    ${totalPhaseMs > 0 ? `
    <div class="section">
        <h2>Time Breakdown</h2>
        <div class="time-bar-container">
            <div class="time-bar">
                <div class="segment planning" style="width: ${planPct}%"></div>
                <div class="segment editing" style="width: ${editPct}%"></div>
                <div class="segment commands" style="width: ${cmdPct}%"></div>
                <div class="segment waiting" style="width: ${waitPct}%"></div>
            </div>
            <div class="time-legend">
                <span class="time-legend-item"><span class="dot planning"></span> Planning ${planPct}%</span>
                <span class="time-legend-item"><span class="dot editing"></span> Editing ${editPct}%</span>
                <span class="time-legend-item"><span class="dot commands"></span> Commands ${cmdPct}%</span>
                <span class="time-legend-item"><span class="dot waiting"></span> Waiting ${waitPct}%</span>
            </div>
        </div>
    </div>` : ''}

    <!-- Root Cause (only for failures) -->
    ${rootCauseHtml}

    <!-- Retries -->
    <div class="section">
        <h2>Retries</h2>
        ${retriesHtml}
    </div>

    <!-- Recommendations -->
    ${report.recommendations ? `
    <div class="section">
        <h2>Recommendations</h2>
        ${recsHtml}
    </div>` : ''}

    <!-- Footer -->
    ${signozButtonHtml ? `
    <div class="report-footer">
        ${signozButtonHtml}
    </div>` : ''}

    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.addEventListener('click', function(e) {
                const btn = e.target.closest('.signoz-button');
                if (btn && !btn.classList.contains('disabled') && btn.dataset.url) {
                    vscode.postMessage({ type: 'openSignoz', url: btn.dataset.url });
                }
            });
        })();
    </script>
</body>
</html>`;
}

// ─── Utilities ────────────────────────────────────────────────────────

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDuration(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
