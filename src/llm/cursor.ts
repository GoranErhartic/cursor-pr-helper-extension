import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Cursor } from '@cursor/sdk';
import { consumeRun, createRunTracker, finalizeRun } from './cursorRun';
import { ProviderError, redactSecrets } from './errors';
import type { LlmProvider, ModelInfo, ReviewInput } from './types';

type CursorSdk = { Agent: typeof Agent; Cursor: typeof Cursor };
const CLEANUP_TIMEOUT_MS = 5000;

let logSink: (message: string) => void = () => undefined;

/** Lets the extension host route diagnostics to its output channel (kept vscode-free for tests). */
export function setCursorLogSink(sink: (message: string) => void): void {
  logSink = sink;
}

function logPrHelper(message: string): void {
  logSink(message);
}

/**
 * Read-only guardrail: the review agent may only inspect files. This is an allowlist
 * (anything not listed is not offered), plus an explicit denylist of every mutating or
 * side-effecting capability as defense in depth. "shell" and "mcp" are capability groups.
 */
export const REVIEW_ALLOWED_TOOLS = ['read', 'grep', 'glob', 'ls'];
export const REVIEW_DISALLOWED_TOOLS = [
  'shell',
  'edit',
  'delete',
  'applyAgentDiff',
  'mcp',
  'task',
  'webFetch',
  'webSearch',
  'generateImage',
];

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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let cleanupDeferred = false;
    const cleanup = async (): Promise<void> => {
      if (agent) {
        await withTimeout(agent[Symbol.asyncDispose](), CLEANUP_TIMEOUT_MS);
      }
      await withTimeout(rm(cwd, { recursive: true, force: true }), CLEANUP_TIMEOUT_MS);
    };
    try {
      onStatus?.('Initializing Cursor agent…');
      const { Agent } = await loadSdk();
      agent = await Agent.create({
        apiKey,
        model: { id: model },
        // No `sandboxOptions`: OS sandboxing is unavailable in many environments and makes the run
        // fail. Read-only is enforced by the tool allowlist/denylist below.
        local: { cwd, settingSources: [] },
        tools: REVIEW_ALLOWED_TOOLS,
        disallowedTools: REVIEW_DISALLOWED_TOOLS,
      });
      const prompt = `Instructions:\n${input.systemPrompt}\n\n${input.userPrompt}`;
      onStatus?.('Sending review prompt to Cursor…');
      const tracker = createRunTracker({ onText: onChunk, onStatus });
      const startedAt = Date.now();
      const run = await agent.send(prompt, {
        mode: 'agent',
        // `turn-ended` is the authoritative "answer complete" signal (delivered in order, after all text).
        onDelta: tracker.onDelta as NonNullable<Parameters<typeof agent.send>[1]>['onDelta'],
      });
      const onAbort = (): void => {
        if (run.supports('cancel')) {
          void run.cancel();
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        onStatus?.('Waiting for agent output…');
        const outcome = await consumeRun(run, tracker, { signal });
        logPrHelper(
          `[cursor] run ${run.id} ended by ${outcome.endedBy}: status=${outcome.status} after ${
            Date.now() - startedAt
          }ms` +
            (outcome.error
              ? ` code=${outcome.error.code ?? 'n/a'} message=${redactSecrets(outcome.error.message, apiKey)}`
              : '')
        );
        if (outcome.status === 'cancelled') {
          throw new ProviderError('Request aborted.', 'aborted');
        }
        if (outcome.status === 'error') {
          if (tracker.receivedOutput()) {
            // The review text was fully streamed; a late run-level error must not turn a delivered review into a failure.
            logPrHelper('[cursor] run reported an error after output was delivered; treating review as complete.');
            return;
          }
          const detail = outcome.error?.message?.trim();
          const code = outcome.error?.code ? ` [${outcome.error.code}]` : '';
          throw new ProviderError(`${detail || 'Cursor run failed.'}${code}`, 'api');
        }
        // Complete. Let the run lifecycle settle (or cancel it) in the background so the UI isn't held up
        // and a stall retry cannot re-run the review.
        cleanupDeferred = true;
        void finalizeRun(run)
          .then((r) =>
            logPrHelper(`[cursor] run ${run.id} lifecycle: ${r.lifecycle} +${r.elapsedMs}ms after turn end`)
          )
          .catch(() => undefined)
          .finally(() => void cleanup());
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      const mapped = mapCursorError(err, apiKey);
      logPrHelper(`[cursor] review failed: ${mapped.code}: ${mapped.message}`);
      throw mapped;
    } finally {
      if (!cleanupDeferred) {
        void cleanup();
      }
    }
  }
}
