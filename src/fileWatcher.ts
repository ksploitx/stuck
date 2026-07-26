import * as vscode from 'vscode';
import { startSpan } from './otelEmitter';

const previousSizes = new Map<string, number>();

export function activateFileWatcher(context: vscode.ExtensionContext) {
    // Populate initial sizes when documents are opened
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            previousSizes.set(document.uri.fsPath, Buffer.byteLength(document.getText(), 'utf8'));
        })
    );

    // Also populate for already open documents on activation
    for (const doc of vscode.workspace.textDocuments) {
        previousSizes.set(doc.uri.fsPath, Buffer.byteLength(doc.getText(), 'utf8'));
    }

    const disposable = vscode.workspace.onDidSaveTextDocument((document) => {
        const currentSize = Buffer.byteLength(document.getText(), 'utf8');
        const previousSize = previousSizes.get(document.uri.fsPath) ?? currentSize;
        const byteDelta = currentSize - previousSize;
        
        previousSizes.set(document.uri.fsPath, currentSize);

        const span = startSpan('file_save', {
            'file.path': document.uri.fsPath,
            'file.byte_delta': byteDelta
        });
        
        if (span) {
            span.end();
        }
    });

    context.subscriptions.push(disposable);
    
    // Clean up when closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            previousSizes.delete(document.uri.fsPath);
        })
    );
}
