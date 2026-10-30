import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  assertMcpToolSuccess,
  buildIssueContext,
  describeResourcesResponse,
  isLikelyAuthError,
  issueContextLooksEmpty,
  parseAccessibleResources,
  pickCloudId,
  type JiraIssueContext,
} from './jiraHelpers';
import { newOAuthState, waitForOAuthCallback } from './oauthCallback';
import {
  clearOAuthCredentials,
  DEFAULT_OAUTH_PORT,
  hasOAuthTokens,
  JiraOAuthProvider,
} from './oauthProvider';
import { logPrHelper } from '../util/prHelperLog';

export type { JiraIssueContext };

const ACCESS_TOKEN_KEY = 'prHelper.jira.accessToken';
const REFRESH_TOKEN_KEY = 'prHelper.jira.refreshToken';

const ISSUE_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'comment'];

type McpTransport = StreamableHTTPClientTransport | SSEClientTransport;

export class JiraMcpClient {
  private client: Client | undefined;
  private cachedCloudId: string | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async isConnected(): Promise<boolean> {
    if (await hasOAuthTokens(this.secrets)) {
      return true;
    }
    return Boolean(await this.secrets.get(ACCESS_TOKEN_KEY));
  }

  async disconnect(): Promise<void> {
    await this.secrets.delete(ACCESS_TOKEN_KEY);
    await this.secrets.delete(REFRESH_TOKEN_KEY);
    await clearOAuthCredentials(this.secrets);
    this.resetConnection();
  }

  /**
   * Browser (SSO) sign-in using OAuth 2.1 + PKCE with dynamic client registration, as defined by
   * the MCP authorization spec. Opens the Atlassian login page and receives the code on a loopback port.
   */
  async signIn(): Promise<void> {
    const port = this.getOAuthPort();
    const state = newOAuthState();
    const provider = new JiraOAuthProvider(this.secrets, port, async (url) => {
      logPrHelper('Opening browser for Jira sign-in…');
      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    });
    provider.setState(state);

    const abort = new AbortController();
    const callback = waitForOAuthCallback({ port, expectedState: state, signal: abort.signal });
    await callback.ready;

    try {
      const transport = this.buildTransport({ authProvider: provider });
      const probe = new Client({ name: 'cursor-pr-helper', version: '0.1.0' }, { capabilities: {} });
      try {
        await probe.connect(transport);
        // Existing tokens were still valid; no browser round trip needed.
        abort.abort();
        await probe.close();
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) {
          throw err;
        }
        const { code } = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'PR Helper: complete Jira sign-in in your browser…',
            cancellable: true,
          },
          async (_progress, token) => {
            token.onCancellationRequested(() => abort.abort());
            return callback.result;
          }
        );
        await transport.finishAuth(code);
      }
    } finally {
      abort.abort();
    }

    await this.secrets.delete(ACCESS_TOKEN_KEY);
    this.resetConnection();
    await this.verifyConnection();
    vscode.window.showInformationMessage('PR Helper: signed in to Jira.');
  }

  /**
   * Stores a bearer token for the Atlassian MCP server (admin-provided or from another OAuth flow).
   */
  async connectWithAccessToken(token: string): Promise<void> {
    await clearOAuthCredentials(this.secrets);
    await this.secrets.store(ACCESS_TOKEN_KEY, token.trim());
    this.resetConnection();
    await this.verifyConnection();
    vscode.window.showInformationMessage('PR Helper: connected to Jira MCP.');
  }

  async connectInteractive(context: vscode.ExtensionContext): Promise<void> {
    void context;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(globe) Sign in with browser (SSO)', description: 'Recommended', mode: 'sso' as const },
        { label: '$(key) Paste access token', mode: 'token' as const },
      ],
      { title: 'Connect Jira', ignoreFocusOut: true }
    );
    if (!pick) {
      return;
    }
    try {
      if (pick.mode === 'sso') {
        await this.signIn();
        return;
      }
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
      await this.connectWithAccessToken(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Jira connection failed: ${msg}`);
      logPrHelper(`Jira connect failed: ${msg}`);
    }
  }

  private resetConnection(): void {
    void this.client?.close();
    this.client = undefined;
    this.cachedCloudId = undefined;
  }

  private getMcpUrl(): string {
    const config = vscode.workspace.getConfiguration('prHelper');
    return config.get<string>('jiraMcpUrl') ?? 'https://mcp.atlassian.com/v2/mcp';
  }

  private getOAuthPort(): number {
    const config = vscode.workspace.getConfiguration('prHelper');
    return config.get<number>('jiraOAuthPort') ?? DEFAULT_OAUTH_PORT;
  }

  private getJiraSiteUrlSetting(): string {
    const config = vscode.workspace.getConfiguration('prHelper');
    return config.get<string>('jiraSiteUrl') ?? '';
  }

  private buildTransport(auth: { authProvider?: JiraOAuthProvider; bearer?: string }): McpTransport {
    const url = new URL(this.getMcpUrl());
    const headers: Record<string, string> = auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {};
    if (url.pathname.replace(/\/$/, '').endsWith('/sse')) {
      return new SSEClientTransport(url, {
        authProvider: auth.authProvider,
        requestInit: { headers },
        eventSourceInit: {
          fetch: async (input, init) => {
            const h = new Headers(init?.headers);
            for (const [k, v] of Object.entries(headers)) {
              h.set(k, v);
            }
            const token = await auth.authProvider?.tokens();
            if (token) {
              h.set('Authorization', `Bearer ${token.access_token}`);
            }
            return fetch(input, { ...init, headers: h });
          },
        },
      });
    }
    return new StreamableHTTPClientTransport(url, {
      authProvider: auth.authProvider,
      requestInit: { headers },
    });
  }

  private async createTransport(): Promise<McpTransport> {
    if (await hasOAuthTokens(this.secrets)) {
      // Silent use: refresh is automatic; if it fails we must not hang waiting for a browser.
      const provider = new JiraOAuthProvider(this.secrets, this.getOAuthPort(), () => {
        throw new Error('Jira session expired. Run "PR Helper: Connect Jira" to sign in again.');
      });
      provider.setState(newOAuthState());
      return this.buildTransport({ authProvider: provider });
    }
    const token = await this.secrets.get(ACCESS_TOKEN_KEY);
    if (!token) {
      throw new Error('Not connected to Jira. Run "PR Helper: Connect Jira".');
    }
    return this.buildTransport({ bearer: token });
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    const transport = await this.createTransport();
    const client = new Client({ name: 'cursor-pr-helper', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async callJiraTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    try {
      const client = await this.ensureClient();
      const result = await client.callTool({ name, arguments: arguments_ });
      return assertMcpToolSuccess(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof UnauthorizedError || isLikelyAuthError(msg)) {
        this.resetConnection();
      }
      throw err;
    }
  }

  private async resolveCloudId(): Promise<string> {
    if (this.cachedCloudId) {
      return this.cachedCloudId;
    }
    const raw = await this.callJiraTool('getAccessibleAtlassianResources', {});
    const resources = parseAccessibleResources(raw);
    const siteSetting = this.getJiraSiteUrlSetting();
    if (resources.length === 0) {
      logPrHelper(`No Atlassian sites parsed from response (${describeResourcesResponse(raw)}).`);
    }
    const cloudId = pickCloudId(resources, siteSetting);
    this.cachedCloudId = cloudId;
    logPrHelper(`Jira cloudId: ${cloudId}${siteSetting ? ` (matched ${siteSetting})` : ''}`);
    return cloudId;
  }

  private async verifyConnection(): Promise<void> {
    await this.resolveCloudId();
    logPrHelper('Jira MCP connection verified.');
  }

  async getIssue(issueKey: string): Promise<JiraIssueContext | undefined> {
    try {
      const cloudId = await this.resolveCloudId();
      logPrHelper(`Fetching Jira issue ${issueKey}…`);
      const rawText = await this.callJiraTool('getJiraIssue', {
        cloudId,
        issueIdOrKey: issueKey,
        responseContentFormat: 'markdown',
        fields: ISSUE_FIELDS,
      });
      const ctx = buildIssueContext(issueKey, rawText);
      if (issueContextLooksEmpty(ctx)) {
        throw new Error('Jira returned no usable issue fields.');
      }
      logPrHelper(`Jira ${issueKey} loaded (${ctx.summary ?? 'no summary'}).`);
      vscode.window.setStatusBarMessage(`PR Helper: Jira ${issueKey} loaded`, 4000);
      return ctx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logPrHelper(`Jira fetch failed for ${issueKey}: ${msg}`);
      vscode.window.showWarningMessage(`Jira context unavailable for ${issueKey}: ${msg}`);
      return undefined;
    }
  }
}
