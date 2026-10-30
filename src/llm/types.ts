export type ProviderId = 'openai' | 'anthropic' | 'cursor';

export const PROVIDER_IDS: ProviderId[] = ['openai', 'anthropic', 'cursor'];

export function isProviderId(value: string | undefined): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

export interface ModelInfo {
  id: string;
  label: string;
}

export interface ReviewInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface LlmProvider {
  id: ProviderId;
  label: string;
  /** Throws a `ProviderError` when the key is rejected or the provider is unreachable. */
  validateKey(apiKey: string, signal?: AbortSignal): Promise<void>;
  listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]>;
  review(
    apiKey: string,
    model: string,
    input: ReviewInput,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    onStatus?: (status: string) => void
  ): Promise<void>;
}

export const SECRET_KEY_PREFIX = 'prHelper.apiKey.';

export function secretKeyForProvider(provider: ProviderId): string {
  return `${SECRET_KEY_PREFIX}${provider}`;
}
