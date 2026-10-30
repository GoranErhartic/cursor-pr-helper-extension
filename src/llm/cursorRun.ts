import type { Run, RunResult, RunResultStatus, RunStatus, SDKMessage } from '@cursor/sdk';
import { ProviderError } from './errors';

export const DEFAULT_RUN_MAX_DURATION_MS = 15 * 60 * 1000;
export const RUN_WAIT_METADATA_TIMEOUT_MS = 10_000;

export type ConsumedRunStatus = RunResultStatus | 'expired';

export interface ConsumeRunResult {
  status: ConsumedRunStatus;
  error?: { message: string; code?: string };
}

export interface ConsumeRunOptions {
  onText: (text: string) => void;
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
  maxDurationMs?: number;
  /** Override for tests; production uses RUN_WAIT_METADATA_TIMEOUT_MS. */
  waitMetadataTimeoutMs?: number;
}

const TERMINAL_SDK_STATUSES = new Set(['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']);

export function mapSdkLifecycleStatus(status: string): ConsumedRunStatus | undefined {
  switch (status) {
    case 'FINISHED':
      return 'finished';
    case 'ERROR':
      return 'error';
    case 'CANCELLED':
      return 'cancelled';
    case 'EXPIRED':
      return 'expired';
    default:
      return undefined;
  }
}

function isTerminalRunStatus(status: RunStatus): status is RunResultStatus {
  return status !== 'running';
}

async function cancelRunIfSupported(run: Run): Promise<void> {
  if (run.supports('cancel')) {
    await run.cancel().catch(() => undefined);
  }
}

function handleStreamMessage(
  message: SDKMessage,
  handlers: ConsumeRunOptions,
  onFirstOutput: () => void
): ConsumedRunStatus | undefined {
  if (message.type === 'assistant') {
    let sawText = false;
    for (const block of message.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        sawText = true;
        onFirstOutput();
        handlers.onText(block.text);
      }
    }
    if (sawText) {
      handlers.onStatus?.('Streaming review output…');
    }
    return undefined;
  }
  if (message.type === 'thinking') {
    const snippet = message.text.trim().slice(0, 120);
    handlers.onStatus?.(
      snippet ? `Thinking… ${snippet}${message.text.length > 120 ? '…' : ''}` : 'Thinking…'
    );
    return undefined;
  }
  if (message.type === 'tool_call') {
    handlers.onStatus?.(`Running tool: ${message.name}…`);
    return undefined;
  }
  if (message.type === 'status' && TERMINAL_SDK_STATUSES.has(message.status)) {
    return mapSdkLifecycleStatus(message.status);
  }
  return undefined;
}

/**
 * Consumes a Cursor SDK run using terminal status signals from the stream and
 * `onDidChangeStatus`, then optionally reads final metadata via bounded `wait()`.
 */
export async function consumeRun(run: Run, options: ConsumeRunOptions): Promise<ConsumeRunResult> {
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_RUN_MAX_DURATION_MS;
  const startedAt = Date.now();
  let terminalStatus: ConsumedRunStatus | undefined;
  let resolveTerminal: (() => void) | undefined;
  const terminalReached = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  const markTerminal = (status: ConsumedRunStatus): void => {
    if (terminalStatus) {
      return;
    }
    terminalStatus = status;
    resolveTerminal?.();
  };

  const unsubscribe = run.onDidChangeStatus((status) => {
    if (isTerminalRunStatus(status)) {
      markTerminal(status);
    }
  });

  if (isTerminalRunStatus(run.status)) {
    markTerminal(run.status);
  }

  let receivedOutput = false;
  const onFirstOutput = (): void => {
    receivedOutput = true;
  };

  const streamIterator = run.stream()[Symbol.asyncIterator]();

  const remainingMs = (): number => Math.max(0, maxDurationMs - (Date.now() - startedAt));

  const failMaxDuration = async (): Promise<ConsumeRunResult> => {
    await cancelRunIfSupported(run);
    throw new ProviderError('Cursor review exceeded maximum duration.', 'api');
  };

  try {
    while (!terminalStatus) {
      if (options.signal?.aborted) {
        await cancelRunIfSupported(run);
        return { status: 'cancelled' };
      }
      if (remainingMs() === 0) {
        return await failMaxDuration();
      }

      let abortListener: (() => void) | undefined;
      const abortPromise = options.signal
        ? new Promise<'aborted'>((resolve) => {
            if (options.signal!.aborted) {
              resolve('aborted');
              return;
            }
            abortListener = (): void => resolve('aborted');
            options.signal!.addEventListener('abort', abortListener, { once: true });
          })
        : undefined;

      let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
      const ceilingPromise = new Promise<'ceiling'>((resolve) => {
        ceilingTimer = setTimeout(() => resolve('ceiling'), remainingMs());
      });

      const nextPromise = streamIterator.next().then((result) => ({ kind: 'next' as const, result }));

      type RaceStep =
        | { kind: 'next'; result: IteratorResult<SDKMessage, void> }
        | { kind: 'terminal' }
        | { kind: 'aborted' }
        | { kind: 'ceiling' };

      const racers: Promise<RaceStep>[] = [
        nextPromise,
        terminalReached.then(() => ({ kind: 'terminal' as const })),
        ceilingPromise.then(() => ({ kind: 'ceiling' as const })),
      ];
      if (abortPromise) {
        racers.push(abortPromise.then(() => ({ kind: 'aborted' as const })));
      }

      const raceResult = await Promise.race(racers);

      if (abortListener && options.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      clearTimeout(ceilingTimer);

      if (raceResult.kind === 'aborted') {
        await cancelRunIfSupported(run);
        return { status: 'cancelled' };
      }
      if (raceResult.kind === 'ceiling') {
        return await failMaxDuration();
      }
      if (raceResult.kind === 'terminal' || terminalStatus) {
        break;
      }

      if (raceResult.kind !== 'next') {
        continue;
      }

      const { result } = raceResult;
      if (result.done) {
        break;
      }

      const fromMessage = handleStreamMessage(result.value, options, onFirstOutput);
      if (fromMessage) {
        markTerminal(fromMessage);
        break;
      }
    }
  } finally {
    unsubscribe();
    void Promise.resolve(streamIterator.return?.()).catch(() => undefined);
  }

  if (options.signal?.aborted) {
    return { status: 'cancelled' };
  }

  options.onStatus?.('Finalizing review response…');

  const waitMetadataTimeoutMs = options.waitMetadataTimeoutMs ?? RUN_WAIT_METADATA_TIMEOUT_MS;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waitOutcome = await Promise.race([
    run.wait().catch((err: unknown) => ({ waitFailed: err as unknown })),
    new Promise<{ timedOut: true }>((resolve) => {
      waitTimer = setTimeout(() => resolve({ timedOut: true }), waitMetadataTimeoutMs);
    }),
  ]);
  clearTimeout(waitTimer);

  if (waitOutcome && 'id' in waitOutcome) {
    const result = waitOutcome as RunResult;
    return {
      status: result.status,
      error: result.error,
    };
  }

  if (waitOutcome && 'waitFailed' in waitOutcome && !receivedOutput && !terminalStatus) {
    throw waitOutcome.waitFailed;
  }

  return {
    status: terminalStatus ?? 'finished',
  };
}
