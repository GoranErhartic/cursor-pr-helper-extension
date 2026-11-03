import type { Run, RunResultStatus } from '@cursor/sdk';
import { ProviderError } from './errors';

export const DEFAULT_RUN_MAX_DURATION_MS = 15 * 60 * 1000;
/** After `turn-ended`, how long the run lifecycle gets to settle before we cancel it. */
export const FINALIZE_GRACE_MS = 5_000;

/**
 * Minimal structural view of the SDK's `InteractionUpdate` (the `onDelta` payload).
 * Only the variants this extension reads are modelled.
 */
export type RunUpdate =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-completed' }
  | { type: 'tool-call-started'; toolCall?: unknown }
  | { type: 'turn-ended' }
  | { type: string };

export type EndedBy = 'turn-ended' | 'wait';

export interface ConsumeRunResult {
  status: RunResultStatus;
  endedBy: EndedBy;
  error?: { message: string; code?: string };
}

export interface RunTrackerHandlers {
  onText: (text: string) => void;
  onStatus?: (status: string) => void;
}

export interface RunTracker {
  /** Pass as `onDelta` to `agent.send`. Never throws: UI errors must not break the SDK callback chain. */
  onDelta: (args: { update: RunUpdate }) => void;
  /** Resolves on the first `turn-ended` update. */
  turnEnded: Promise<void>;
  hasEnded(): boolean;
  receivedOutput(): boolean;
}

function toolNameOf(update: { toolCall?: unknown }): string | undefined {
  const call = update.toolCall as { name?: unknown; type?: unknown } | undefined;
  if (typeof call?.name === 'string') {
    return call.name;
  }
  return typeof call?.type === 'string' ? call.type : undefined;
}

/**
 * The SDK delivers `onDelta` updates in order and awaits each callback, so every text delta
 * is seen before `turn-ended`. That makes `turn-ended` an exact "the answer is complete" signal,
 * independent of when the backend connection closes.
 */
export function createRunTracker(handlers: RunTrackerHandlers): RunTracker {
  let ended = false;
  let output = false;
  let resolveEnded: () => void = () => undefined;
  const turnEnded = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a handler failure must never break the SDK's awaited callback chain */
    }
  };

  const onDelta = ({ update }: { update: RunUpdate }): void => {
    if (ended) {
      return;
    }
    switch (update.type) {
      case 'text-delta': {
        const text = (update as { text: string }).text;
        if (typeof text === 'string' && text.length > 0) {
          output = true;
          safe(() => handlers.onText(text));
          safe(() => handlers.onStatus?.('Streaming review output…'));
        }
        return;
      }
      case 'thinking-delta': {
        const text = ((update as { text: string }).text ?? '').trim();
        const snippet = text.slice(0, 120);
        safe(() =>
          handlers.onStatus?.(snippet ? `Thinking… ${snippet}${text.length > 120 ? '…' : ''}` : 'Thinking…')
        );
        return;
      }
      case 'tool-call-started': {
        const name = toolNameOf(update as { toolCall?: unknown });
        safe(() => handlers.onStatus?.(name ? `Running tool: ${name}…` : 'Running tool…'));
        return;
      }
      case 'turn-ended':
        ended = true;
        resolveEnded();
        return;
      default:
        return;
    }
  };

  return { onDelta, turnEnded, hasEnded: () => ended, receivedOutput: () => output };
}

export interface ConsumeRunOptions {
  signal?: AbortSignal;
  maxDurationMs?: number;
}

async function cancelRunIfSupported(run: Run): Promise<void> {
  if (run.supports('cancel')) {
    await run.cancel().catch(() => undefined);
  }
}

/**
 * Waits for the review to finish. The primary signal is `turn-ended` from the tracker; `run.wait()`
 * is only a backstop for runs that end before any turn (auth/model/transport errors).
 */
export async function consumeRun(
  run: Run,
  tracker: RunTracker,
  options: ConsumeRunOptions = {}
): Promise<ConsumeRunResult> {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_RUN_MAX_DURATION_MS;
  const { signal } = options;
  if (signal?.aborted) {
    await cancelRunIfSupported(run);
    return { status: 'cancelled', endedBy: 'wait' };
  }

  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  type Step =
    | { kind: 'turn-ended' }
    | { kind: 'wait'; result: Awaited<ReturnType<Run['wait']>> }
    | { kind: 'wait-failed'; error: unknown }
    | { kind: 'aborted' }
    | { kind: 'ceiling' };

  const racers: Promise<Step>[] = [
    tracker.turnEnded.then((): Step => ({ kind: 'turn-ended' })),
    run.wait().then(
      (result): Step => ({ kind: 'wait', result }),
      (error: unknown): Step => ({ kind: 'wait-failed', error })
    ),
    new Promise<Step>((resolve) => {
      ceilingTimer = setTimeout(() => resolve({ kind: 'ceiling' }), maxDurationMs);
    }),
  ];
  if (signal) {
    racers.push(
      new Promise<Step>((resolve) => {
        abortListener = (): void => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', abortListener, { once: true });
      })
    );
  }

  try {
    const step = await Promise.race(racers);
    switch (step.kind) {
      case 'turn-ended':
        return { status: 'finished', endedBy: 'turn-ended' };
      case 'aborted':
        await cancelRunIfSupported(run);
        return { status: 'cancelled', endedBy: 'wait' };
      case 'ceiling':
        await cancelRunIfSupported(run);
        throw new ProviderError('Cursor review exceeded maximum duration.', 'api');
      case 'wait-failed':
        if (tracker.hasEnded()) {
          return { status: 'finished', endedBy: 'turn-ended' };
        }
        if (tracker.receivedOutput()) {
          return { status: 'finished', endedBy: 'wait' };
        }
        throw step.error;
      case 'wait': {
        if (tracker.hasEnded()) {
          return { status: 'finished', endedBy: 'turn-ended' };
        }
        return { status: step.result.status, endedBy: 'wait', error: step.result.error };
      }
      default:
        throw new Error('Unexpected run step.');
    }
  } finally {
    clearTimeout(ceilingTimer);
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

export interface FinalizeResult {
  /** How the lifecycle ended: its own status, or cancelled by us after the grace period. */
  lifecycle: RunResultStatus | 'cancelled-after-grace';
  elapsedMs: number;
}

/**
 * Background cleanup after the review is done. Gives the run lifecycle a short grace period
 * to settle on its own, then cancels so no stall retry can re-run the review.
 */
export async function finalizeRun(run: Run, graceMs: number = FINALIZE_GRACE_MS): Promise<FinalizeResult> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      run.wait().then(
        (r) => r.status as RunResultStatus,
        () => 'error' as RunResultStatus
      ),
      new Promise<'grace'>((resolve) => {
        timer = setTimeout(() => resolve('grace'), graceMs);
      }),
    ]);
    if (settled !== 'grace') {
      return { lifecycle: settled, elapsedMs: Date.now() - startedAt };
    }
    if (run.status === 'running') {
      await cancelRunIfSupported(run);
      return { lifecycle: 'cancelled-after-grace', elapsedMs: Date.now() - startedAt };
    }
    return { lifecycle: run.status as RunResultStatus, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
