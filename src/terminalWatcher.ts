import * as vscode from 'vscode';
import { startSpan } from './otelEmitter';

export function activateTerminalWatcher(context: vscode.ExtensionContext) {
    if (vscode.window.onDidEndTerminalShellExecution) {
        const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
            const command = event.execution.commandLine.value;
            const exitCode = event.exitCode;
            
            const span = startSpan('terminal_command', {
                'terminal.command': command,
                'terminal.exit_code': exitCode ?? -1
            });
            
            if (span) {
                span.end();
            }
        });
        context.subscriptions.push(disposable);
    }
}
