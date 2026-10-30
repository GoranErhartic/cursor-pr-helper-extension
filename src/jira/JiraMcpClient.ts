import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ACCESS_TOKEN_KEY = 'prHelper.jira.accessToken';
const REFRESH_TOKEN_KEY = 'prHelper.jira.refreshToken';

export interface JiraIssueContext {
  key: string;
  summary?: string;
  description?: string;
  status?: string;
  rawText: string;
}

export class JiraMcpClient {
  private client: Client | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async isConnected(): Promise<boolean> {
    const token = await this.secrets.get(ACCESS_TOKEN_KEY);
    return Boolean(token);
  }

  async disconnect(): Promise<void> {
    await this.secrets.delete(ACCESS_TOKEN_KEY);
    await this.secrets.delete(REFRESH_TOKEN_KEY);
    this.client = undefined;
  }

  /**
   * Stores a bearer token for the Atlassian MCP server (from OAuth or admin-provided token).
   * Full OAuth browser flow depends on Atlassian app registration; this validates connectivity.
   */
  async connectWithAccessToken(token: string): Promise<void> {
    await this.secrets.store(ACCESS_TOKEN_KEY, token.trim());
    this.client = undefined;
    await this.ensureClient();
    vscode.window.showInformationMessage('PR Helper: connected to Jira MCP.');
  }

  async connectInteractive(context: vscode.ExtensionContext): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'Jira MCP access token',
      password: true,
      placeHolder: 'Paste OAuth access token from Atlassian MCP authorization',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Token is required'),
    });
    if (!token) {
      return;
    }
    try {
      await this.connectWithAccessToken(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Jira MCP connection failed: ${msg}`);
    }
    void context;
  }

  private async getAccessToken(): Promise<string | undefined> {
    return this.secrets.get(ACCESS_TOKEN_KEY);
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error('Not connected to Jira. Run "PR Helper: Connect Jira".');
    }
    const config = vscode.workspace.getConfiguration('prHelper');
    const url = config.get<string>('jiraMcpUrl') ?? 'https://mcp.atlassian.com/v1/sse';

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const client = new Client({ name: 'cursor-pr-helper', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async getIssue(issueKey: string): Promise<JiraIssueContext | undefined> {
    try {
      const client = await this.ensureClient();
      const result = await client.callTool({
        name: 'getJiraIssue',
        arguments: { issueIdOrKey: issueKey },
      });
      const rawText = formatToolResult(result);
      return {
        key: issueKey,
        rawText,
        summary: extractField(rawText, 'summary'),
        description: extractField(rawText, 'description'),
        status: extractField(rawText, 'status'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Jira context unavailable for ${issueKey}: ${msg}`);
      return undefined;
    }
  }
}

function formatToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '');
  }
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

function extractField(raw: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fields = parsed.fields as Record<string, unknown> | undefined;
    if (fields && fields[field] != null) {
      return String(fields[field]);
    }
    if (parsed[field] != null) {
      return String(parsed[field]);
    }
  } catch {
    const re = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'i');
    const m = re.exec(raw);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}
