import * as vscode from 'vscode';
import type { JiraIssueContext } from './JiraMcpClient';

export interface JiraClient {
  isConnected(): Promise<boolean>;
  getIssue(issueKey: string): Promise<JiraIssueContext | undefined>;
  signIn(): Promise<void>;
  connectInteractive(context: vscode.ExtensionContext): Promise<void>;
}
