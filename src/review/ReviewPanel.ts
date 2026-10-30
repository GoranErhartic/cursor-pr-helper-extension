import * as vscode from 'vscode';
import { marked } from 'marked';
import { escapeHtml } from '../util/vscodeHelpers';

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private static readonly THINKING_PREFIX = 'Thinking... ';
  private readonly panel: vscode.WebviewPanel;
  private accumulated = '';
  private readonly statuses: string[] = [];
  private latestStatus = 'Preparing review…';
  private isComplete = false;
  private statusTone: 'running' | 'complete' | 'failed' | 'canceled' = 'running';

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.render();
    this.panel.onDidDispose(() => {
      ReviewPanel.current = undefined;
    });
  }

  static show(_extensionUri: vscode.Uri, title: string): ReviewPanel {
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal();
      ReviewPanel.current.accumulated = '';
      ReviewPanel.current.statuses.length = 0;
      ReviewPanel.current.latestStatus = 'Preparing review…';
      ReviewPanel.current.isComplete = false;
      ReviewPanel.current.statusTone = 'running';
      ReviewPanel.current.panel.title = title;
      ReviewPanel.current.render();
      return ReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'prHelperReview',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    ReviewPanel.current = new ReviewPanel(panel);
    return ReviewPanel.current;
  }

  appendMarkdown(chunk: string): void {
    this.accumulated += chunk;
    this.render();
  }

  setStatus(status: string): void {
    const normalized = status.trim();
    const nextTone = this.detectStatusTone(normalized);
    if (nextTone) {
      this.statusTone = nextTone;
    }
    if (!normalized || normalized === this.latestStatus) {
      return;
    }
    const wasThinking = this.latestStatus.startsWith(ReviewPanel.THINKING_PREFIX);
    const isThinking = normalized.startsWith(ReviewPanel.THINKING_PREFIX);
    this.latestStatus = normalized;
    if (isThinking && wasThinking && this.statuses.length > 0) {
      // Keep a single rotating "Thinking..." line instead of spamming the log.
      this.statuses[this.statuses.length - 1] = normalized;
    } else {
      this.statuses.push(normalized);
    }
    this.render();
  }

  setComplete(): void {
    this.isComplete = true;
    this.statusTone = 'complete';
    this.setStatus('Review complete.');
    this.render();
  }

  private render(): void {
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const htmlBody = this.accumulated
      ? (marked.parse(this.accumulated, { async: false }) as string)
      : '';
    const statusLog = this.statuses
      .map((status) => `<li>${escapeHtml(status)}</li>`)
      .join('');
    const emptyState = this.isComplete
      ? `<p>${escapeHtml('Review completed with no output.')}</p>`
      : `<p>${escapeHtml('Waiting for review output…')}</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Review</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); line-height: 1.5; }
    .status-card {
      border: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
    }
    .status-card.status-card--complete {
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-testing-iconPassed) 12%);
    }
    .status-card.status-card--failed {
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-testing-iconFailed) 12%);
    }
    .status-card.status-card--canceled {
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-testing-iconQueued) 12%);
    }
    .status-header {
      font-weight: 600;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-terminal-ansiGreen);
    }
    .status-dot.status-dot--pulse {
      animation: pulse 1.4s ease-in-out infinite;
    }
    .status-dot.status-dot--complete {
      background: var(--vscode-testing-iconPassed);
    }
    .status-dot.status-dot--failed {
      background: var(--vscode-testing-iconFailed);
    }
    .status-dot.status-dot--canceled {
      background: var(--vscode-testing-iconQueued);
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .status-log {
      margin: 0;
      padding-left: 20px;
      color: var(--vscode-descriptionForeground);
    }
    .review-content {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 12px;
    }
    h1,h2,h3 { margin-top: 1.2em; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; }
    pre { overflow-x: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); }
  </style>
</head>
<body>
  <section class="status-card ${this.getStatusCardClass()}">
    <div class="status-header"><span class="status-dot ${this.getStatusDotClass()}"></span>Review progress</div>
    ${statusLog ? `<ol class="status-log">${statusLog}</ol>` : ''}
  </section>
  <section class="review-content">${htmlBody || emptyState}</section>
</body>
</html>`;
  }

  private detectStatusTone(status: string): 'running' | 'complete' | 'failed' | 'canceled' | undefined {
    const lower = status.toLowerCase();
    if (lower.startsWith('review complete')) {
      return 'complete';
    }
    if (lower.includes('failed')) {
      return 'failed';
    }
    if (lower.includes('canceled') || lower.includes('cancelled')) {
      return 'canceled';
    }
    if (this.statusTone !== 'complete' && this.statusTone !== 'failed' && this.statusTone !== 'canceled') {
      return 'running';
    }
    return undefined;
  }

  private getStatusCardClass(): string {
    if (this.statusTone === 'complete') {
      return 'status-card--complete';
    }
    if (this.statusTone === 'failed') {
      return 'status-card--failed';
    }
    if (this.statusTone === 'canceled') {
      return 'status-card--canceled';
    }
    return '';
  }

  private getStatusDotClass(): string {
    if (this.statusTone === 'running') {
      return 'status-dot--pulse';
    }
    if (this.statusTone === 'complete') {
      return 'status-dot--complete';
    }
    if (this.statusTone === 'failed') {
      return 'status-dot--failed';
    }
    return 'status-dot--canceled';
  }
}
