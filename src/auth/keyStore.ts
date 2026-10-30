import * as vscode from 'vscode';
import { ProviderId, secretKeyForProvider } from '../llm/types';

/** API keys live only in VS Code/Cursor Secret Storage, one entry per provider. */
export class KeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getKey(providerId: ProviderId): Promise<string | undefined> {
    const value = await this.secrets.get(secretKeyForProvider(providerId));
    return value?.trim() || undefined;
  }

  async setKey(providerId: ProviderId, key: string): Promise<void> {
    await this.secrets.store(secretKeyForProvider(providerId), key.trim());
  }

  async deleteKey(providerId: ProviderId): Promise<void> {
    await this.secrets.delete(secretKeyForProvider(providerId));
  }

  async hasKey(providerId: ProviderId): Promise<boolean> {
    return (await this.getKey(providerId)) !== undefined;
  }
}
