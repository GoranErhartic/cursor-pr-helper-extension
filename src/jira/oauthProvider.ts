import * as vscode from 'vscode';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const TOKENS_KEY = 'prHelper.jira.oauth.tokens';
const CLIENT_KEY = 'prHelper.jira.oauth.client';
const VERIFIER_KEY = 'prHelper.jira.oauth.verifier';

export const DEFAULT_OAUTH_PORT = 33418;

/** OAuth client state for the Atlassian MCP server, persisted in SecretStorage. */
export class JiraOAuthProvider implements OAuthClientProvider {
  private currentState: string | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly port: number,
    private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Cursor PR Helper',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  setState(state: string): void {
    this.currentState = state;
  }

  state(): string {
    if (!this.currentState) {
      throw new Error('OAuth state not initialised');
    }
    return this.currentState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = await this.secrets.get(CLIENT_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      const stored = JSON.parse(raw) as { redirectUrl: string; info: OAuthClientInformationMixed };
      // Registration is bound to the redirect URL; re-register if the port changed.
      return stored.redirectUrl === this.redirectUrl ? stored.info : undefined;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.secrets.store(CLIENT_KEY, JSON.stringify({ redirectUrl: this.redirectUrl, info }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await this.secrets.get(TOKENS_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.onAuthorizationUrl(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.secrets.store(VERIFIER_KEY, verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.secrets.get(VERIFIER_KEY);
    if (!v) {
      throw new Error('Missing PKCE code verifier');
    }
    return v;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      await this.secrets.delete(TOKENS_KEY);
    }
    if (scope === 'all' || scope === 'client') {
      await this.secrets.delete(CLIENT_KEY);
    }
    if (scope === 'all' || scope === 'verifier') {
      await this.secrets.delete(VERIFIER_KEY);
    }
  }
}

export async function hasOAuthTokens(secrets: vscode.SecretStorage): Promise<boolean> {
  return Boolean(await secrets.get(TOKENS_KEY));
}

export async function clearOAuthCredentials(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(TOKENS_KEY);
  await secrets.delete(CLIENT_KEY);
  await secrets.delete(VERIFIER_KEY);
}
