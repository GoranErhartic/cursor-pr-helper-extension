import { ProviderError, mapHttpToProviderError, readErrorBody, withTimeout } from './errors';
import type { LlmProvider, ModelInfo, ReviewInput } from './types';

const CHAT_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-'];

function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return CHAT_PREFIXES.some((p) => lower.startsWith(p));
}

export class OpenAiProvider implements LlmProvider {
  id = 'openai' as const;
  label = 'OpenAI';

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    await this.listModels(apiKey, signal);
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: withTimeout(signal),
    });
    if (!res.ok) {
      throw mapHttpToProviderError(res.status, await readErrorBody(res), apiKey);
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? [])
      .map((m) => m.id)
      .filter(isChatModel)
      .sort()
      .map((id) => ({ id, label: id }));
  }

  async review(
    apiKey: string,
    model: string,
    input: ReviewInput,
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
      }),
      signal,
    });
    if (!res.ok) {
      throw mapHttpToProviderError(res.status, await readErrorBody(res), apiKey);
    }
    if (!res.body) {
      throw new ProviderError('OpenAI returned an empty response body.', 'api');
    }
    await readSseStream(res.body, (line) => {
      if (!line.startsWith('data: ')) {
        return;
      }
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') {
        return;
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          onChunk(delta);
        }
      } catch {
        /* ignore malformed chunks */
      }
    }, signal);
  }
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reading = true;
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
        onLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
