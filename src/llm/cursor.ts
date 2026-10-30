import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Cursor } from '@cursor/sdk';
import { ProviderError, redactSecrets } from './errors';
import type { LlmProvider, ModelInfo, ReviewInput } from './types';

type CursorSdk = { Agent: typeof Agent; Cursor: typeof Cursor };
const FINAL_WAIT_TIMEOUT_MS = 20000;
const STREAM_IDLE_TIMEOUT_MS = 15000;
const THINKING_ROTATION_MS = 7500;
const STREAM_DRAIN_MS = 1500;
const FIRST_OUTPUT_TIMEOUT_MS = 180000;
const THINKING_STATUS_PREFIX = 'Thinking... ';
const THINKING_WORD_BANK = {
  verbs: [
    'untangling', 'tracing', 'inspecting', 'decoding', 'profiling',
    'triaging', 'cross-checking', 'stress-testing', 'synthesizing', 'validating',
    'interrogating', 'dissecting', 'auditing', 'sniffing out', 'second-guessing',
    'mapping', 'poking at', 'squinting at', 'reverse-engineering', 'fact-checking',
    'bisecting', 'scrutinizing', 'chasing down', 'eyeballing', 'unpacking',
    'rubber-ducking', 'connecting the dots on', 'benchmarking my doubts about', 'pressure-testing', 'peeling back',
  ],
  objects: [
    'edge cases', 'code paths', 'review threads', 'changed files', 'diff hunks',
    'regression risks', 'dependency assumptions', 'failure modes', 'implementation trade-offs', 'test coverage gaps',
    'null checks', 'error handling', 'naming choices', 'async race conditions', 'config drift',
    'retry logic', 'permission boundaries', 'hidden side effects', 'type contracts', 'rollback plans',
    'off-by-one suspects', 'copy-pasted logic', 'TODO comments', 'timeout settings', 'log lines',
    'API contracts', 'migration risks', 'cache invalidation', 'happy-path optimism', 'the Jira acceptance criteria',
  ],
  tails: [
    'like a caffeinated detective', 'with suspiciously calm precision', 'one hunk at a time', 'without waking the pager', 'while keeping signal over noise',
    'before anything hits production', 'and double-checking the gotchas', 'for correctness and blast radius', 'with a ruthless bug radar', 'while the coffee kicks in',
    'like a very polite linter', 'with the patience of a senior reviewer', 'before the weekend deploy', 'so you do not have to', 'with mild suspicion and great curiosity',
    'as if production depended on it', 'while humming the CI theme tune', 'with a magnifying glass and strong opinions', 'before anyone says LGTM too early', 'in glorious slow motion',
    'like a cat watching a laser pointer', 'while avoiding the bikeshed', 'with exactly the right amount of paranoia', 'and taking very detailed notes', 'before the standup starts',
    'like it is Friday at 4:59 PM', 'with a healthy fear of merge conflicts', 'while ignoring the shiny distractions', 'and quietly judging the variable names', 'so future-you says thanks',
  ],
  openers: [
    '', '', '', 'still ', 'carefully ', 'currently ', 'quietly ', 'diligently ', 'patiently ', 'cheerfully ',
  ],
  templates: [
    '{o}{v} {obj} {t}.',
    '{o}{v} {obj}, {t}.',
    'hold tight, {v} {obj} {t}.',
    'one moment: {v} {obj} {t}.',
    'bear with me, {v} {obj} {t}.',
    'brb, {v} {obj} {t}.',
    '{o}{v} {obj}… {t}.',
  ],
} as const;

const RECENT_LINES_TO_AVOID = 40;

function pickFrom<T>(items: readonly T[], avoid?: T): T {
  if (items.length === 1) {
    return items[0];
  }
  let item = items[Math.floor(Math.random() * items.length)];
  while (item === avoid) {
    item = items[Math.floor(Math.random() * items.length)];
  }
  return item;
}

class ThinkingLinePicker {
  private readonly recent: string[] = [];
  private lastVerb: string | undefined;
  private lastObject: string | undefined;
  private lastTail: string | undefined;

  next(): string {
    const { verbs, objects, tails, openers, templates } = THINKING_WORD_BANK;
    let line = '';
    // Re-roll until the line is not among the most recent ones.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const verb = pickFrom(verbs, this.lastVerb);
      const object = pickFrom(objects, this.lastObject);
      const tail = pickFrom(tails, this.lastTail);
      line = pickFrom(templates)
        .replace('{o}', pickFrom(openers))
        .replace('{v}', verb)
        .replace('{obj}', object)
        .replace('{t}', tail);
      if (!this.recent.includes(line)) {
        this.lastVerb = verb;
        this.lastObject = object;
        this.lastTail = tail;
        break;
      }
    }
    this.recent.push(line);
    if (this.recent.length > RECENT_LINES_TO_AVOID) {
      this.recent.shift();
    }
    return line;
  }
}

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
      onStatus?.('Initializing Cursor agent…');
      const { Agent } = await loadSdk();
      const agent = await Agent.create({
        apiKey,
        model: { id: model },
        local: { cwd, settingSources: [] },
      });
      try {
        const prompt = `Instructions:\n${input.systemPrompt}\n\n${input.userPrompt}`;
        onStatus?.('Sending review prompt to Cursor…');
        const run = await agent.send(prompt, { mode: 'plan' });
        const onAbort = (): void => {
          void run.cancel?.();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const thinkingLinePicker = new ThinkingLinePicker();
          const emitThinkingStatus = (): void => {
            onStatus?.(`${THINKING_STATUS_PREFIX}${thinkingLinePicker.next()}`);
          };
          emitThinkingStatus();
          let thinkingTicker: ReturnType<typeof setInterval> | undefined;
          const stopThinkingTicker = (): void => {
            if (thinkingTicker) {
              clearInterval(thinkingTicker);
              thinkingTicker = undefined;
            }
          };
          let receivedFirstChunk = false;
          thinkingTicker = setInterval(() => {
            if (receivedFirstChunk || signal?.aborted) {
              return;
            }
            emitThinkingStatus();
          }, THINKING_ROTATION_MS);
          // `run.wait()` is the authoritative end signal. The event stream can stay open
          // (heartbeats, tool events, or never closing), so we race it against the stream.
          const waitState: { settled: boolean; status?: string; error?: unknown } = { settled: false };
          const waitSettled = run.wait().then(
            (result) => {
              waitState.settled = true;
              waitState.status = result.status;
            },
            (err: unknown) => {
              waitState.settled = true;
              waitState.error = err;
            }
          );
          type StreamStep =
            | { kind: 'event'; result: IteratorResult<unknown> }
            | { kind: 'timeout' }
            | { kind: 'waitDone' };
          let lastTextAt = Date.now();
          let endedBy: 'closed' | 'idle' | 'wait' = 'closed';
          const streamIterator = run.stream()[Symbol.asyncIterator]();
          let pendingNext: Promise<StreamStep> | undefined;
          try {
            for (;;) {
              if (signal?.aborted) {
                break;
              }
              let timeoutMs: number;
              if (waitState.settled) {
                timeoutMs = STREAM_DRAIN_MS;
              } else if (receivedFirstChunk) {
                timeoutMs = Math.max(0, STREAM_IDLE_TIMEOUT_MS - (Date.now() - lastTextAt));
              } else {
                timeoutMs = FIRST_OUTPUT_TIMEOUT_MS;
              }
              let timer: ReturnType<typeof setTimeout> | undefined;
              const timeout = new Promise<StreamStep>((resolve) => {
                timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
              });
              pendingNext ??= streamIterator.next().then((result) => ({ kind: 'event', result }));
              const racers: Promise<StreamStep>[] = [pendingNext, timeout];
              if (!waitState.settled) {
                racers.push(waitSettled.then(() => ({ kind: 'waitDone' })));
              }
              const step = await Promise.race(racers);
              clearTimeout(timer);
              if (step.kind === 'waitDone') {
                continue; // next loop iteration only drains briefly
              }
              if (step.kind === 'timeout') {
                if (!receivedFirstChunk && !waitState.settled) {
                  throw new ProviderError('Cursor review stream stalled before producing output.', 'api');
                }
                endedBy = waitState.settled ? 'wait' : 'idle';
                break;
              }
              pendingNext = undefined;
              if (step.result.done) {
                break;
              }
              const event = step.result.value as {
                type?: string;
                message?: { content?: Array<{ type?: string; text?: string }> };
              };
              if (event.type === 'assistant') {
                for (const block of event.message?.content ?? []) {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    if (!receivedFirstChunk) {
                      receivedFirstChunk = true;
                      stopThinkingTicker();
                      onStatus?.('Streaming review output… drafting findings and recommendations…');
                    }
                    lastTextAt = Date.now();
                    onChunk(block.text);
                  }
                }
              }
            }
          } finally {
            stopThinkingTicker();
            // Don't await: closing a stalled stream may itself hang.
            void Promise.resolve(streamIterator.return?.()).catch(() => undefined);
          }
          if (signal?.aborted) {
            throw new ProviderError('Request aborted.', 'aborted');
          }
          onStatus?.('Finalizing review response…');
          if (!waitState.settled) {
            let finalTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              waitSettled,
              new Promise<void>((resolve) => {
                finalTimer = setTimeout(resolve, FINAL_WAIT_TIMEOUT_MS);
              }),
            ]);
            clearTimeout(finalTimer);
          }
          if (!waitState.settled) {
            void run.cancel?.();
            if (!receivedFirstChunk) {
              throw new ProviderError('Cursor did not return output before timing out.', 'api');
            }
            onStatus?.(
              endedBy === 'idle'
                ? 'Stream went quiet; completing from streamed output.'
                : 'Final status timeout reached; completing from streamed output.'
            );
            return;
          }
          if (waitState.error !== undefined) {
            if (!receivedFirstChunk) {
              throw waitState.error;
            }
            return;
          }
          const waitOutcome = { status: waitState.status };
          if (waitOutcome.status === 'error') {
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
