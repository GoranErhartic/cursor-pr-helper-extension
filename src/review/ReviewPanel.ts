import * as vscode from 'vscode';
import { marked } from 'marked';
import { escapeHtml } from '../util/vscodeHelpers';

export class ReviewPanel {
  public static current: ReviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private accumulated = '';

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml('', extensionUri);
    this.panel.onDidDispose(() => {
      ReviewPanel.current = undefined;
    });
  }

  static show(extensionUri: vscode.Uri, title: string): ReviewPanel {
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal();
      ReviewPanel.current.accumulated = '';
      ReviewPanel.current.panel.title = title;
      ReviewPanel.current.render('');
      return ReviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'prHelperReview',
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    ReviewPanel.current = new ReviewPanel(panel, extensionUri);
    return ReviewPanel.current;
  }

  appendMarkdown(chunk: string): void {
    this.accumulated += chunk;
    this.render(this.accumulated);
  }

  setComplete(): void {
    this.render(this.accumulated);
  }

  private render(markdown: string): void {
    const htmlBody = marked.parse(markdown, { async: false }) as string;
    this.panel.webview.html = this.getHtml(htmlBody, vscode.Uri.file(''));
  }

  private getHtml(bodyHtml: string, _extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PR Review</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); line-height: 1.5; }
    h1,h2,h3 { margin-top: 1.2em; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; }
    pre { overflow-x: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); }
  </style>
</head>
<body>${bodyHtml || `<p>${escapeHtml('Waiting for review…')}</p>`}</body>
</html>`;
  }
}
