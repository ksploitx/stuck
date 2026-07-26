import * as vscode from 'vscode';
import { initOtel } from './otelEmitter.js';
import { activateFileWatcher } from './fileWatcher.js';
import { activateGitWatcher } from './gitWatcher.js';
import { activateTerminalWatcher } from './terminalWatcher.js';
import { activateCdpBridge } from './cdpBridge.js';
import { activatePostmortem } from './postmortem.js';

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
}

export function deactivate() {}

