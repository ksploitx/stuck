/**
 * Session List Sidebar — WebviewViewProvider
 *
 * Renders the sidebar panel showing past and current agent sessions.
 * Reads `.agent-reports/*.md` files and live session state.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getSessionTraceId } from '../otelEmitter.js';
import { isPostmortemGenerating, onPostmortemGenerated, parseReportFile } from '../postmortem.js';

// ─── Types ────────────────────────────────────────────────────────────

interface SessionEntry {
    id: string;
    title: string;
    traceId: string;
    generatedAt: string;
    status: 'success' | 'error' | 'warning' | 'active';
    durationText: string;
    retryCount: number;
    filePath: string;      // absolute path to the .md file (empty for live session)
    spanCount: number;
    timeLabel: string;     // e.g. "12:34 PM"
}

interface GroupedSessions {
    label: string;
    sessions: SessionEntry[];
}

// ─── Provider ─────────────────────────────────────────────────────────

export class SessionListProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'stuck-sessions';

    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._extensionUri = _context.extensionUri;

        // Auto-refresh when a postmortem is generated
        onPostmortemGenerated(() => {
            this.refresh();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _resolveContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            (message: { type: string; traceId?: string; filePath?: string }) => {
                switch (message.type) {
                    case 'openSession':
                        if (message.filePath) {
                            vscode.commands.executeCommand('stuck.openPostmortem', message.filePath, message.traceId);
                        }
                        break;
                    case 'refresh':
                        this.refresh();
                        break;
                }
            },
            undefined,
            this._context.subscriptions,
        );

        this.refresh();
    }

    /**
     * Reload session data and update the webview HTML.
     */
    public async refresh(): Promise<void> {
        if (!this._view) {
            return;
        }

        const generating = isPostmortemGenerating();
        const sessions = await this._loadSessions();
        const grouped = this._groupSessions(sessions);

        this._view.webview.html = this._getHtml(grouped, generating);
    }

    // ─── Session Loading ──────────────────────────────────────────────

    private async _loadSessions(): Promise<SessionEntry[]> {
        const sessions: SessionEntry[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return sessions;
        }

        const workspaceRoot = workspaceFolders[0].uri;
        const reportsDir = vscode.Uri.joinPath(workspaceRoot, '.agent-reports');

        // Add live session entry
        const liveTraceId = getSessionTraceId();
        sessions.push({
            id: `live-${liveTraceId}`,
            title: 'Current Session',
            traceId: liveTraceId,
            generatedAt: new Date().toISOString(),
            status: 'active',
            durationText: 'Running…',
            retryCount: 0,
            filePath: '',
            spanCount: 0,
            timeLabel: 'Now',
        });

        // Read past session reports
        try {
            const entries = await vscode.workspace.fs.readDirectory(reportsDir);
            const mdFiles = entries
                .filter(([name, type]) => name.endsWith('.md') && type === vscode.FileType.File)
                .map(([name]) => name)
                .sort()
                .reverse(); // newest first

            for (const filename of mdFiles) {
                const filePath = vscode.Uri.joinPath(reportsDir, filename);
                try {
                    const bytes = await vscode.workspace.fs.readFile(filePath);
                    const content = new TextDecoder().decode(bytes);
                    const parsed = parseReportFile(content);

                    // Extract duration text
                    let durationText = 'Unknown';
                    if (parsed.totalDurationMs > 0) {
                        durationText = formatDurationShort(parsed.totalDurationMs);
                    } else {
                        const durMatch = content.match(/(\d+)m\s*(\d+)s/);
                        if (durMatch) {
                            durationText = `${durMatch[1]}m ${durMatch[2]}s`;
                        }
                    }

                    // Extract span count from content
                    const spanMatch = content.match(/(\d+)\s*spans/);
                    const spanCount = spanMatch ? parseInt(spanMatch[1]) : 0;

                    // Compute retry count
                    const retryCount = parsed.retries.reduce((sum, r) => sum + r.count, 0);

                    // Time label
                    const timeLabel = parsed.generatedAt
                        ? formatTimeLabel(new Date(parsed.generatedAt))
                        : '';

                    sessions.push({
                        id: `report-${parsed.traceId || filename}`,
                        title: parsed.title,
                        traceId: parsed.traceId,
                        generatedAt: parsed.generatedAt,
                        status: parsed.status,
                        durationText,
                        retryCount,
                        filePath: filePath.fsPath,
                        spanCount,
                        timeLabel,
                    });
                } catch {
                    // Skip malformed files
                }
            }
        } catch {
            // .agent-reports/ doesn't exist yet — that's fine
        }

        return sessions;
    }

    // ─── Grouping ─────────────────────────────────────────────────────

    private _groupSessions(sessions: SessionEntry[]): GroupedSessions[] {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart.getTime() - 86400000);

        const active: SessionEntry[] = [];
        const today: SessionEntry[] = [];
        const yesterday: SessionEntry[] = [];
        const earlier: SessionEntry[] = [];

        for (const s of sessions) {
            if (s.status === 'active') {
                active.push(s);
                continue;
            }
            const date = new Date(s.generatedAt);
            if (date >= todayStart) {
                today.push(s);
            } else if (date >= yesterdayStart) {
                yesterday.push(s);
            } else {
                earlier.push(s);
            }
        }

        const groups: GroupedSessions[] = [];
        if (active.length > 0) { groups.push({ label: 'Active', sessions: active }); }
        if (today.length > 0) { groups.push({ label: 'Recent Sessions', sessions: today }); }
        if (yesterday.length > 0) { groups.push({ label: 'Yesterday', sessions: yesterday }); }
        if (earlier.length > 0) { groups.push({ label: 'Earlier', sessions: earlier }); }

        return groups;
    }

    // ─── HTML Rendering ───────────────────────────────────────────────

    private _getHtml(groups: GroupedSessions[], isLoading: boolean): string {
        const nonce = getNonce();

        let bodyContent: string;

        if (isLoading) {
            bodyContent = `
                <div class="loading-state">
                    <div class="spinner"></div>
                    <div class="loading-text">Generating postmortem…</div>
                </div>`;
        } else if (groups.length === 0 || (groups.length === 1 && groups[0].sessions.length === 1 && groups[0].sessions[0].status === 'active')) {
            // Only live session exists, no reports yet
            bodyContent = `
                <div class="empty-state">
                    <div class="icon">ℹ</div>
                    <div class="title">No sessions yet</div>
                    <div class="subtitle">Sessions will appear here after agent activity</div>
                </div>`;
        } else {
            bodyContent = groups.map(group => `
                <div class="group-header">${escapeHtml(group.label)}</div>
                ${group.sessions.map(s => this._renderSessionItem(s)).join('')}
            `).join('');
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
    <style nonce="${nonce}">
        :root {
            --bg-primary:     #1a1a2e;
            --bg-secondary:   #16213e;
            --bg-tertiary:    #0f3460;
            --bg-surface:     #1e1e3a;
            --text-primary:   #e0e0e0;
            --text-secondary: #a0a0b8;
            --text-muted:     #6c6c8a;
            --status-success: #4ade80;
            --status-warning: #fbbf24;
            --status-error:   #f87171;
            --status-active:  #60a5fa;
            --border-subtle:  #2a2a4a;
            --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px;
            --radius-s: 4px;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            line-height: 1.4;
        }
        .group-header {
            text-transform: uppercase;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            letter-spacing: 0.5px;
            padding: var(--sp-2) var(--sp-3);
            margin-top: var(--sp-4);
        }
        .group-header:first-child { margin-top: var(--sp-2); }
        .session-item {
            display: flex;
            align-items: center;
            gap: var(--sp-2);
            padding: var(--sp-2) var(--sp-3);
            border-bottom: 1px solid var(--border-subtle);
            cursor: pointer;
            transition: background 0.15s ease;
        }
        .session-item:hover { background: var(--bg-tertiary); }
        .session-item.active-session { cursor: default; }
        .status-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .status-dot.success { background: var(--status-success); }
        .status-dot.warning { background: var(--status-warning); }
        .status-dot.error   { background: var(--status-error); }
        .status-dot.active  {
            background: var(--status-active);
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(96,165,250,0.5); }
            50%      { opacity: 0.7; box-shadow: 0 0 0 4px rgba(96,165,250,0); }
        }
        .session-info { flex: 1; min-width: 0; }
        .session-title {
            font-size: 13px; font-weight: 500;
            color: var(--text-primary);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .session-meta {
            font-size: 11px; color: var(--text-muted); line-height: 1.3;
        }
        .session-end {
            display: flex; flex-direction: column;
            align-items: flex-end; gap: 2px; flex-shrink: 0;
        }
        .session-duration {
            font-size: 11px; color: var(--text-secondary);
            font-variant-numeric: tabular-nums;
        }
        .retry-badge {
            font-size: 10px; font-weight: 700;
            color: var(--status-warning);
            background: rgba(251, 191, 36, 0.15);
            padding: 2px 6px; border-radius: var(--radius-s);
            white-space: nowrap;
        }
        .empty-state {
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            padding: var(--sp-6) var(--sp-4);
            text-align: center; min-height: 200px;
        }
        .empty-state .icon {
            font-size: 32px; color: var(--text-muted); margin-bottom: var(--sp-3);
        }
        .empty-state .title {
            font-size: 13px; color: var(--text-secondary); margin-bottom: var(--sp-1);
        }
        .empty-state .subtitle {
            font-size: 11px; color: var(--text-muted);
        }
        .loading-state {
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            padding: var(--sp-6) var(--sp-4); gap: var(--sp-3);
        }
        .spinner {
            width: 24px; height: 24px;
            border: 2px solid var(--border-subtle);
            border-top-color: var(--status-active);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-text {
            font-size: 13px; color: var(--text-secondary);
            animation: fade-pulse 1.5s ease-in-out infinite;
        }
        @keyframes fade-pulse {
            0%, 100% { opacity: 1; }
            50%      { opacity: 0.5; }
        }
    </style>
</head>
<body>
    <div id="session-list">${bodyContent}</div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.getElementById('session-list').addEventListener('click', function(e) {
                const item = e.target.closest('.session-item[data-file-path]');
                if (item && item.dataset.filePath) {
                    vscode.postMessage({
                        type: 'openSession',
                        filePath: item.dataset.filePath,
                        traceId: item.dataset.traceId || ''
                    });
                }
            });
        })();
    </script>
</body>
</html>`;
    }

    private _renderSessionItem(session: SessionEntry): string {
        const isActive = session.status === 'active';
        const dataAttrs = isActive
            ? ''
            : `data-file-path="${escapeHtml(session.filePath)}" data-trace-id="${escapeHtml(session.traceId)}"`;
        const activeClass = isActive ? ' active-session' : '';

        const retryBadge = session.retryCount > 0
            ? `<span class="retry-badge">⟳ ${session.retryCount} retries</span>`
            : '';

        const metaText = isActive
            ? 'Running now…'
            : `${escapeHtml(session.timeLabel)}${session.spanCount > 0 ? ` · ${session.spanCount} spans` : ''}`;

        return `
            <div class="session-item${activeClass}" ${dataAttrs}>
                <span class="status-dot ${session.status}"></span>
                <div class="session-info">
                    <div class="session-title">${escapeHtml(session.title)}</div>
                    <div class="session-meta">${metaText}</div>
                </div>
                <div class="session-end">
                    <span class="session-duration">${escapeHtml(session.durationText)}</span>
                    ${retryBadge}
                </div>
            </div>`;
    }
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

function formatDurationShort(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(0)}s`; }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatTimeLabel(date: Date): string {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h = hours % 12 || 12;
    const m = minutes.toString().padStart(2, '0');
    return `${h}:${m} ${ampm}`;
}
