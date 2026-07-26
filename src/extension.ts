import * as vscode from 'vscode';
import { initOtel } from './otelEmitter.js';
import { activateFileWatcher } from './fileWatcher.js';
import { activateGitWatcher } from './gitWatcher.js';
import { activateTerminalWatcher } from './terminalWatcher.js';
import { activateCdpBridge } from './cdpBridge.js';
import { activatePostmortem } from './postmortem.js';
import { SessionListProvider } from './webview/sessionListProvider.js';
import { openPostmortemPanel } from './webview/postmortemPanel.js';

export async function activate(context: vscode.ExtensionContext) {
    initOtel(context);
    
    activateFileWatcher(context);
    await activateGitWatcher(context);
    activateTerminalWatcher(context);

    // CDP bridge is Antigravity-specific — must never block activation
    try {
        await activateCdpBridge(context);
    } catch (err) {
        console.warn('[Stuck] CDP bridge activation failed, continuing without it:', err);
    }

    // Postmortem engine — depends on otelEmitter + cdpBridge being wired up first
    try {
        activatePostmortem(context);
    } catch (err) {
        console.warn('[Stuck] Postmortem engine activation failed:', err);
    }

    // ── Webview: Session List Sidebar ──────────────────────────────
    const sessionListProvider = new SessionListProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SessionListProvider.viewType,
            sessionListProvider,
        ),
    );

    // ── Commands ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stuck.openPostmortem',
            (filePath: string, traceId?: string) => {
                openPostmortemPanel(context, filePath, traceId);
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'stuck.refreshSessions',
            () => {
                sessionListProvider.refresh();
            },
        ),
    );
}

export function deactivate() {}
