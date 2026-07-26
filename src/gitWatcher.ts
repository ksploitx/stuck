import * as vscode from 'vscode';
import { startSpan } from './otelEmitter';
import * as cp from 'child_process';

export async function activateGitWatcher(context: vscode.ExtensionContext) {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
        return;
    }

    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = git.getAPI(1);

    if (api.repositories.length === 0) {
        api.onDidOpenRepository((repo: any) => {
            setupRepoWatcher(repo, context);
        });
    } else {
        api.repositories.forEach((repo: any) => setupRepoWatcher(repo, context));
    }
}

function setupRepoWatcher(repository: any, context: vscode.ExtensionContext) {
    let lastCommit = repository.state.HEAD?.commit;

    context.subscriptions.push(
        repository.state.onDidChange(() => {
            const currentCommit = repository.state.HEAD?.commit;
            if (currentCommit && currentCommit !== lastCommit && lastCommit !== undefined) {
                lastCommit = currentCommit;
                
                getCommitStats(repository.rootUri.fsPath, currentCommit).then(stats => {
                    const span = startSpan('git_commit', {
                        'git.commit': currentCommit,
                        'git.files_changed': stats.filesChanged,
                        'git.line_delta': stats.lineDelta
                    });
                    if (span) span.end();
                });
            } else if (currentCommit && lastCommit === undefined) {
                lastCommit = currentCommit;
            }
        })
    );
}

async function getCommitStats(repoPath: string, commitHash: string): Promise<{filesChanged: number, lineDelta: number}> {
    return new Promise((resolve) => {
        cp.exec(`git show --numstat --format="" ${commitHash}`, { cwd: repoPath }, (err, stdout) => {
            if (err) {
                resolve({ filesChanged: 0, lineDelta: 0 });
                return;
            }
            let filesChanged = 0;
            let lineDelta = 0;
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                if (!line) continue;
                const [added, deleted] = line.split('\t');
                const addCount = parseInt(added, 10) || 0;
                const delCount = parseInt(deleted, 10) || 0;
                filesChanged++;
                lineDelta += (addCount - delCount);
            }
            resolve({ filesChanged, lineDelta });
        });
    });
}
