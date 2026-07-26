import * as vscode from 'vscode';
import { initOtel } from './otelEmitter';
import { activateFileWatcher } from './fileWatcher';
import { activateGitWatcher } from './gitWatcher';
import { activateTerminalWatcher } from './terminalWatcher';

export async function activate(context: vscode.ExtensionContext) {
    initOtel(context);
    
    activateFileWatcher(context);
    await activateGitWatcher(context);
    activateTerminalWatcher(context);
}

export function deactivate() {}
