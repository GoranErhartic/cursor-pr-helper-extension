import * as vscode from 'vscode';
import type { GitHubClient, PullRequestDetail, RepoRef } from '../github/GitHubClient';
import { randomBytes } from 'node:crypto';
import { renderMarkdown } from '../util/markdown';
import { escapeHtml } from '../util/vscodeHelpers';
import { pickPrimaryJiraKey, parseProjectKeys } from '../util/jiraKey';

export class PrDetailPanel {
  private static readonly panels = new Map<number, PrDetailPanel>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly prNumber: number,
    private readonly onRunPr: (prNumber: number) => void
  ) {
    panel.onDidDispose(() => {
      PrDetailPanel.panels.delete(prNumber);
    });
    panel.webview.onDidReceiveMessage((msg: { type: string; prNumber?: number }) => {
      if (msg.type === 'runPr' && typeof msg.prNumber === 'number') {
        this.onRunPr(msg.prNumber);
      }
    });
  }

  /** Opens a dedicated tab per PR immediately, shows a loader, then fills in the details. */
  static async show(
    _extensionUri: vscode.Uri,
    github: GitHubClient,
    ref: RepoRef,
    prNumber: number,
    onRunPr: (prNumber: number) => void
  ): Promise<void> {
    const existing = PrDetailPanel.panels.get(prNumber);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'prHelperDetail',
      `PR #${prNumber}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const instance = new PrDetailPanel(panel, prNumber, onRunPr);
    PrDetailPanel.panels.set(prNumber, instance);
    panel.webview.html = PrDetailPanel.renderLoading(prNumber);

    try {
      const detail = await github.getPullRequestDetail(ref, prNumber);
      const config = vscode.workspace.getConfiguration('prHelper');
      const projectKeys = parseProjectKeys(config.get<string>('jiraProjectKeys') ?? '');
      const jiraKey = pickPrimaryJiraKey(detail.headRef, detail.title, projectKeys);
      // Panel may have been closed while loading.
      if (PrDetailPanel.panels.get(prNumber) !== instance) {
        return;
      }
      panel.title = `PR #${prNumber}`;
      panel.webview.html = instance.renderHtml(detail, jiraKey);
    } catch (err) {
      if (PrDetailPanel.panels.get(prNumber) !== instance) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      panel.webview.html = PrDetailPanel.renderError(prNumber, msg);
    }
  }

  private static renderLoading(prNumber: number): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; gap: 16px; }
    .spinner { width: 36px; height: 36px; border: 4px solid var(--vscode-editorWidget-border, #888); border-top-color: var(--vscode-progressBar-background, #0e70c0); border-radius: 50%; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner" role="progressbar" aria-label="Loading"></div>
  <div>Loading PR #${prNumber} (GitHub details, checks, comments)…</div>
</body>
</html>`;
  }

  private static renderError(prNumber: number, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-errorForeground); }</style>
</head>
<body>
  <h2>Failed to load PR #${prNumber}</h2>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
  }

  private renderHtml(detail: PullRequestDetail, jiraKey?: string): string {
    const nonce = randomBytes(16).toString('base64');
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

    const commentCards = (comments: { author: string; body: string }[]): string =>
      comments
        .slice(0, 15)
        .map(
          (c) =>
            `<div class="card"><div class="author">@${escapeHtml(c.author)}</div><div class="md">${renderMarkdown(c.body)}</div></div>`
        )
        .join('') || '<p class="meta">None</p>';

    const description = renderMarkdown(detail.body) || '<p class="meta">(empty)</p>';
    const reviews =
      detail.reviews.map((r) => `<li>@${escapeHtml(r.author)} [${escapeHtml(r.state)}]</li>`).join('') ||
      '<li>None</li>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:; script-src 'nonce-${nonce}';">
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px 24px; color: var(--vscode-foreground); line-height: 1.5; max-width: 980px; }
    .meta { color: var(--vscode-descriptionForeground); margin: 4px 0; }
    section { margin-bottom: 24px; }
    h2 { border-bottom: 1px solid var(--vscode-editorWidget-border, #555); padding-bottom: 4px; }
    button { padding: 8px 14px; cursor: pointer; margin: 8px 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    ul { padding-left: 20px; }
    a { color: var(--vscode-textLink-foreground); }
    .card { border: 1px solid var(--vscode-editorWidget-border, #555); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; }
    .author { font-weight: bold; margin-bottom: 4px; }
    .md img { max-width: 100%; }
    .md > :first-child { margin-top: 0; }
    .md > :last-child { margin-bottom: 0; }
    .md code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); }
    .md pre { overflow-x: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
    .md pre code { padding: 0; background: none; }
    .md blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--vscode-editorWidget-border, #555); color: var(--vscode-descriptionForeground); }
    .md table { border-collapse: collapse; }
    .md th, .md td { border: 1px solid var(--vscode-editorWidget-border, #555); padding: 4px 8px; }
  </style>
</head>
<body>
  <h1>#${detail.number} ${escapeHtml(detail.title)}</h1>
  <p class="meta">@${escapeHtml(detail.author)} · ${escapeHtml(detail.headRef)} → ${escapeHtml(detail.baseRef)} · CI: ${escapeHtml(detail.ciState ?? 'unknown')}</p>
  <p class="meta">+${detail.additions} / -${detail.deletions} · ${detail.changedFiles} files · <a href="${escapeHtml(detail.htmlUrl)}">Open on GitHub</a></p>
  ${jiraKey ? `<p class="meta">Jira: ${escapeHtml(jiraKey)}</p>` : ''}
  <button id="run">Run PR (AI review)</button>
  <section><h2>Description</h2><div class="md">${description}</div></section>
  <section><h2>CI checks</h2><ul>${checksHtml}</ul></section>
  <section><h2>Issue comments</h2>${commentCards(detail.issueComments)}</section>
  <section><h2>Review comments</h2>${commentCards(detail.reviewComments)}</section>
  <section><h2>Reviews</h2><ul>${reviews}</ul></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => {
      vscode.postMessage({ type: 'runPr', prNumber: ${detail.number} });
    });
  </script>
</body>
</html>`;
  }
}
