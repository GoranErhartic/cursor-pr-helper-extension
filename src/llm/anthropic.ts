import { ProviderError, mapHttpToProviderError, readErrorBody, withTimeout } from './errors';
import type { LlmProvider, ModelInfo, ReviewInput } from './types';

const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements LlmProvider {
  id = 'anthropic' as const;
  label = 'Anthropic';

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    await this.listModels(apiKey, signal);
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: withTimeout(signal),
    });
    if (!res.ok) {
      throw mapHttpToProviderError(res.status, await readErrorBody(res), apiKey);
    }
    const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
    }));
  }

  async review(
    apiKey: string,
    model: string,
    input: ReviewInput,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    onStatus?: (status: string) => void
  ): Promise<void> {
    onStatus?.('Connecting to Anthropic…');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt }],
      }),
      signal,
    });
    if (!res.ok) {
      throw mapHttpToProviderError(res.status, await readErrorBody(res), apiKey);
    }
    if (!res.body) {
      throw new ProviderError('Anthropic returned an empty response body.', 'api');
    }
    onStatus?.('Anthropic accepted the request. Waiting for first tokens…');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reading = true;
    let receivedFirstToken = false;
    try {
      while (reading) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            continue;
          }
          const payload = line.slice(6).trim();
          try {
            const parsed = JSON.parse(payload) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              if (!receivedFirstToken) {
                receivedFirstToken = true;
                onStatus?.('Streaming review output…');
              }
              onChunk(parsed.delta.text);
            }
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
