import * as vscode from 'vscode';
import { parseGitHubRemote } from './githubRemote';

export function getWorkspaceRepo(): { owner: string; repo: string } | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }
  const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
  if (!gitExt) {
    return undefined;
  }
  const api = gitExt.getAPI(1);
  const repo = api.repositories.find(
    (r: { rootUri: { fsPath: string } }) => r.rootUri.fsPath === folders[0].uri.fsPath
  );
  if (!repo) {
    return undefined;
  }
  const remote = repo.state.remotes.find((r: { name: string }) => r.name === 'origin') ?? repo.state.remotes[0];
  if (!remote?.fetchUrl && !remote?.pushUrl) {
    return undefined;
  }
  const url = remote.fetchUrl ?? remote.pushUrl ?? '';
  return parseGitHubRemote(url);
}

export function ciStatusIcon(state: string | undefined): string {
  switch (state) {
    case 'success':
      return '$(check)';
    case 'failure':
      return '$(error)';
    case 'pending':
      return '$(sync~spin)';
    default:
      return '$(circle-outline)';
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export { parseGitHubRemote };
