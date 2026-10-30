import * as vscode from 'vscode';
import { marked } from 'marked';
import { escapeHtml } from '../util/vscodeHelpers';
import { LOADING_LINES, LOADING_LINE_HOLD_MS, LOADING_TYPE_INTERVAL_MS } from './loadingLines';

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private static readonly RENDER_COALESCE_MS = 100;
  private readonly panel: vscode.WebviewPanel;
  private accumulated = '';
  private readonly statuses: string[] = [];
  private latestStatus = 'Preparing review…';
  private isComplete = false;
  private lingoActive = false;
  private statusTone: 'running' | 'complete' | 'failed' | 'canceled' = 'running';
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.renderNow();
    this.panel.onDidDispose(() => {
      this.clearRenderTimer();
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
      ReviewPanel.current.lingoActive = false;
      ReviewPanel.current.statusTone = 'running';
      ReviewPanel.current.panel.title = title;
      ReviewPanel.current.renderNow();
      return ReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'prHelperReview',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ReviewPanel.current = new ReviewPanel(panel);
    return ReviewPanel.current;
  }

  appendMarkdown(chunk: string): void {
    this.accumulated += chunk;
    this.lingoActive = false;
    this.scheduleRender();
  }

  setStatus(status: string): void {
    const normalized = status.trim();
    // Tool-call noise (e.g. "Running tool: glob…") is not shown.
    if (/^running tool/i.test(normalized)) {
      return;
    }
    const nextTone = this.detectStatusTone(normalized);
    if (nextTone) {
      this.statusTone = nextTone;
      if (nextTone !== 'running') {
        this.lingoActive = false;
      }
    }
    if (!normalized || normalized === this.latestStatus) {
      if (nextTone === 'failed' || nextTone === 'canceled') {
        this.renderNow();
      }
      return;
    }
    this.latestStatus = normalized;
    // While waiting on the LLM, raw "Thinking…" fragments are replaced by PR-lingo lines.
    // Any other status (e.g. streaming started) ends the lingo and becomes the next step.
    if (/^thinking/i.test(normalized) || /^waiting for agent/i.test(normalized)) {
      if (!/^thinking/i.test(normalized)) {
        this.statuses.push(normalized);
      }
      this.lingoActive = this.statusTone === 'running';
    } else {
      this.lingoActive = false;
      this.statuses.push(normalized);
    }
    this.scheduleRender();
  }

  setComplete(): void {
    this.isComplete = true;
    this.lingoActive = false;
    this.statusTone = 'complete';
    this.setStatus('Review complete.');
    this.renderNow();
  }

  private clearRenderTimer(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
  }

  private scheduleRender(): void {
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.postUpdate();
    }, ReviewPanel.RENDER_COALESCE_MS);
  }

  private postUpdate(): void {
    this.clearRenderTimer();
    void this.panel.webview.postMessage({
      type: 'update',
      cardClass: this.getStatusCardClass(),
      dotClass: this.getStatusDotClass(),
      lingo: this.lingoActive,
      logHtml: this.getStatusLogHtml(),
      bodyHtml: this.getBodyHtml(),
    });
  }

  private getStatusLogHtml(): string {
    const items = this.statuses.map((status) => `<li>${escapeHtml(status)}</li>`).join('');
    return items ? `<ol class="status-log">${items}</ol>` : '';
  }

  private getBodyHtml(): string {
    if (this.accumulated) {
      return marked.parse(this.accumulated, { async: false }) as string;
    }
    return this.isComplete
      ? `<p>${escapeHtml('Review completed with no output.')}</p>`
      : `<p>${escapeHtml('Waiting for review output…')}</p>`;
  }

  private renderNow(): void {
    this.clearRenderTimer();
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const nonce = getNonce();
    const statusLog = this.getStatusLogHtml();
    const bodyHtml = this.getBodyHtml();
    const lingo = this.lingoActive;
    const lines = JSON.stringify(LOADING_LINES);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    table { border-collapse: collapse; margin: 8px 0; }
    th, td { border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #555)); padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: var(--vscode-textCodeBlock-background); font-weight: 600; }
  </style>
</head>
<body>
  <section id="status-card" class="status-card ${this.getStatusCardClass()}">
    <div class="status-header"><span id="status-dot" class="status-dot ${this.getStatusDotClass()}"></span><span>Review progress</span></div>
    <div id="status-log">${statusLog}</div>
  </section>
  <section id="review-content" class="review-content">${bodyHtml}</section>
  <script nonce="${nonce}">
    const lines = ${lines};
    const holdMs = ${LOADING_LINE_HOLD_MS};
    const typeMs = ${LOADING_TYPE_INTERVAL_MS};
    const card = document.getElementById('status-card');
    const dot = document.getElementById('status-dot');
    const logEl = document.getElementById('status-log');
    const bodyEl = document.getElementById('review-content');
    // Persistent list item that hosts the typed PR-lingo line.
    const lingoLi = document.createElement('li');
    let index = -1;
    let typeTimer;
    let holdTimer;
    let lingoOn = false;

    function showNext() {
      let next = index;
      while (lines.length > 1 && next === index) {
        next = Math.floor(Math.random() * lines.length);
      }
      index = next;
      const text = lines[index];
      let i = 0;
      lingoLi.textContent = '';
      const step = () => {
        i += 1;
        lingoLi.textContent = text.slice(0, i);
        if (i < text.length) {
          typeTimer = setTimeout(step, typeMs);
        }
      };
      typeTimer = setTimeout(step, typeMs);
      // The next line starts holdMs after this one starts typing.
      holdTimer = setTimeout(showNext, holdMs);
    }

    function startLingo() {
      if (!lingoOn) {
        lingoOn = true;
        showNext();
      }
    }

    function stopLingo() {
      lingoOn = false;
      clearTimeout(typeTimer);
      clearTimeout(holdTimer);
      lingoLi.remove();
    }

    function applyLingo(on) {
      if (on) {
        startLingo();
        let list = logEl.querySelector('ol');
        if (!list) {
          list = document.createElement('ol');
          list.className = 'status-log';
          logEl.appendChild(list);
        }
        list.appendChild(lingoLi);
      } else if (lingoOn) {
        stopLingo();
      }
    }

    applyLingo(${lingo ? 'true' : 'false'});

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (!m || m.type !== 'update') {
        return;
      }
      card.className = 'status-card ' + m.cardClass;
      dot.className = 'status-dot ' + m.dotClass;
      lingoLi.remove();
      logEl.innerHTML = m.logHtml;
      bodyEl.innerHTML = m.bodyHtml;
      applyLingo(m.lingo);
    });
  </script>
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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
