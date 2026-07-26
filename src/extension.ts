import * as vscode from 'vscode';
import { initOtel } from './otelEmitter.js';
import { activateFileWatcher } from './fileWatcher.js';
import { activateGitWatcher } from './gitWatcher.js';
import { activateTerminalWatcher } from './terminalWatcher.js';
import { activateCdpBridge } from './cdpBridge.js';

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
}

export function deactivate() {}

