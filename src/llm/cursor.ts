import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Cursor } from '@cursor/sdk';
import { ProviderError, redactSecrets } from './errors';
import type { LlmProvider, ModelInfo, ReviewInput } from './types';

type CursorSdk = { Agent: typeof Agent; Cursor: typeof Cursor };

/**
 * Loaded lazily (and kept external to the bundle) so the extension activates
 * even if the SDK or its native binary cannot be loaded.
 */
async function loadSdk(): Promise<CursorSdk> {
  // Keep runtime `require()` dynamic so bundling doesn't inline SDK internals.
  const runtimeRequire = require as NodeRequire;
  try {
    return runtimeRequire('@cursor/sdk') as CursorSdk;
  } catch {
    try {
      return runtimeRequire('./vendor/cursor-sdk') as CursorSdk;
    } catch {
      throw new ProviderError(
        'Cursor SDK is unavailable in this build. Reinstall dependencies and rebuild the extension.',
        'api'
      );
    }
  }
}

export function mapCursorError(err: unknown, apiKey: string): ProviderError {
  if (err instanceof ProviderError) {
    return err;
  }
  const e = err as { message?: string; status?: number; name?: string };
  const message = redactSecrets(e?.message ?? String(err), apiKey);
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 401 || status === 403 || /unauthor|invalid.*(api )?key|authentication/i.test(message)) {
    return new ProviderError(
      'Invalid API key. Reconfigure your key via "PR Helper: Configure Provider".',
      'invalid_key',
      status
    );
  }
  if (status === 429 || /rate.?limit/i.test(message)) {
    return new ProviderError('Rate limit exceeded. Try again shortly.', 'rate_limit', status);
  }
  if (e?.name === 'AbortError') {
    return new ProviderError('Request aborted.', 'aborted');
  }
  return new ProviderError(message || 'Cursor request failed.', 'api', status);
}

export class CursorProvider implements LlmProvider {
  id = 'cursor' as const;
  label = 'Cursor';

  async validateKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    await this.listModels(apiKey, signal);
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const { Cursor } = await loadSdk();
      const models = await Cursor.models.list({ apiKey });
      if (signal?.aborted) {
        throw new ProviderError('Request aborted.', 'aborted');
      }
      if (models.length === 0) {
        throw new ProviderError('Cursor returned no models for this account.', 'api');
      }
      return models
        .map((m) => ({ id: m.id, label: m.displayName || m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      throw mapCursorError(err, apiKey);
    }
  }

  async review(
    apiKey: string,
    model: string,
    input: ReviewInput,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    onStatus?: (status: string) => void
  ): Promise<void> {
    // Isolated empty working dir: the agent never sees or touches the user's workspace.
    const cwd = await mkdtemp(join(tmpdir(), 'pr-helper-cursor-'));
    try {
      const { Agent } = await loadSdk();
      const agent = await Agent.create({
        apiKey,
        model: { id: model },
        local: { cwd, settingSources: [] },
      });
      try {
        const prompt = `Instructions:\n${input.systemPrompt}\n\n${input.userPrompt}`;
        const run = await agent.send(prompt, { mode: 'plan' });
        const onAbort = (): void => {
          void run.cancel?.();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          onStatus?.('Thinking…');
          for await (const event of run.stream()) {
            if (signal?.aborted) {
              break;
            }
            if (event.type === 'assistant') {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  onChunk(block.text);
                }
              }
            }
          }
          if (signal?.aborted) {
            throw new ProviderError('Request aborted.', 'aborted');
          }
          const result = await run.wait();
          if (result.status === 'error') {
            throw new ProviderError('Cursor run failed.', 'api');
          }
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    } catch (err) {
      throw mapCursorError(err, apiKey);
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
