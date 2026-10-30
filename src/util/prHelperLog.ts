import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getPrHelperOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('PR Helper');
  }
  return channel;
}

export function logPrHelper(message: string): void {
  getPrHelperOutputChannel().appendLine(message);
}
