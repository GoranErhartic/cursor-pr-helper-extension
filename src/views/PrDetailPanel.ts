import * as vscode from 'vscode';
import type { GitHubClient, PullRequestDetail, RepoRef } from '../github/GitHubClient';
import { escapeHtml } from '../util/vscodeHelpers';
import { pickPrimaryJiraKey, parseProjectKeys } from '../util/jiraKey';

export class PrDetailPanel {
  public static current: PrDetailPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly onRunPr: (prNumber: number) => void
  ) {
    panel.onDidDispose(() => {
      PrDetailPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: { type: string; prNumber?: number }) => {
      if (msg.type === 'runPr' && typeof msg.prNumber === 'number') {
        this.onRunPr(msg.prNumber);
      }
    });
  }

  static async show(
    extensionUri: vscode.Uri,
    github: GitHubClient,
    ref: RepoRef,
    prNumber: number,
    onRunPr: (prNumber: number) => void
  ): Promise<void> {
    const detail = await github.getPullRequestDetail(ref, prNumber);
    const config = vscode.workspace.getConfiguration('prHelper');
    const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
    const jiraKey = pickPrimaryJiraKey(detail.headRef, detail.title, projectKeys);

    if (PrDetailPanel.current) {
      PrDetailPanel.current.panel.reveal();
      PrDetailPanel.current.panel.title = `PR #${prNumber}`;
      PrDetailPanel.current.panel.webview.html = PrDetailPanel.current.renderHtml(detail, jiraKey);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'prHelperDetail',
      `PR #${prNumber}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const instance = new PrDetailPanel(panel, extensionUri, onRunPr);
    PrDetailPanel.current = instance;
    panel.webview.html = instance.renderHtml(detail, jiraKey);
  }

  private renderHtml(detail: PullRequestDetail, jiraKey?: string): string {
    const checksHtml = detail.checks.length
      ? detail.checks
          .map(
            (c) =>
              `<li><strong>${escapeHtml(c.name)}</strong>: ${escapeHtml(c.status)}/${escapeHtml(c.conclusion ?? 'n/a')}${
                c.htmlUrl ? ` <a href="${escapeHtml(c.htmlUrl)}">log</a>` : ''
              }</li>`
          )
          .join('')
      : `<li>No check runs</li>`;

    const issueComments = detail.issueComments
      .slice(0, 15)
      .map(
        (c) =>
          `<li><strong>@${escapeHtml(c.author)}</strong>: ${escapeHtml(c.body.slice(0, 400))}</li>`
      )
      .join('');

    const reviewComments = detail.reviewComments
      .slice(0, 15)
      .map(
        (c) =>
          `<li><strong>@${escapeHtml(c.author)}</strong>: ${escapeHtml(c.body.slice(0, 400))}</li>`
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-detail';">
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
    .meta { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
    section { margin-bottom: 20px; }
    button { padding: 8px 14px; cursor: pointer; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <h1>#${detail.number} ${escapeHtml(detail.title)}</h1>
  <p class="meta">@${escapeHtml(detail.author)} · ${escapeHtml(detail.headRef)} → ${escapeHtml(detail.baseRef)} · CI: ${escapeHtml(detail.ciState ?? 'unknown')}</p>
  <p class="meta">+${detail.additions} / -${detail.deletions} · ${detail.changedFiles} files · <a href="${escapeHtml(detail.htmlUrl)}">Open on GitHub</a></p>
  ${jiraKey ? `<p class="meta">Jira: ${escapeHtml(jiraKey)}</p>` : ''}
  <button id="run">Run PR (AI review)</button>
  <section><h2>Description</h2><pre>${escapeHtml(detail.body || '(empty)')}</pre></section>
  <section><h2>CI checks</h2><ul>${checksHtml}</ul></section>
  <section><h2>Issue comments</h2><ul>${issueComments || '<li>None</li>'}</ul></section>
  <section><h2>Review comments</h2><ul>${reviewComments || '<li>None</li>'}</ul></section>
  <section><h2>Reviews</h2><ul>${detail.reviews.map((r) => `<li>@${escapeHtml(r.author)} [${escapeHtml(r.state)}]</li>`).join('') || '<li>None</li>'}</ul></section>
  <script nonce="detail">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => {
      vscode.postMessage({ type: 'runPr', prNumber: ${detail.number} });
    });
  </script>
</body>
</html>`;
  }
}
