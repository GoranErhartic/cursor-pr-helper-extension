import assert from 'node:assert';
import type { Run, RunResult, RunStatus, SDKMessage } from '@cursor/sdk';
import {
  consumeRun,
  mapSdkLifecycleStatus,
} from '../llm/cursorRun';
import { ProviderError } from '../llm/errors';

const AGENT_ID = 'agent-test';
const RUN_ID = 'run-test';

function assistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    agent_id: AGENT_ID,
    run_id: RUN_ID,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function lifecycleStatus(status: 'FINISHED' | 'ERROR' | 'CANCELLED' | 'EXPIRED'): SDKMessage {
  return {
    type: 'status',
    agent_id: AGENT_ID,
    run_id: RUN_ID,
    status,
  };
}

function thinkingMessage(text: string): SDKMessage {
  return {
    type: 'thinking',
    agent_id: AGENT_ID,
    run_id: RUN_ID,
    text,
  };
}

function toolCallMessage(name: string): SDKMessage {
  return {
    type: 'tool_call',
    agent_id: AGENT_ID,
    run_id: RUN_ID,
    call_id: 'call-1',
    name,
    status: 'running',
  };
}

class FakeRun implements Run {
  readonly id = RUN_ID;
  readonly agentId = AGENT_ID;
  private currentStatus: RunStatus = 'running';
  private readonly listeners = new Set<(status: RunStatus) => void>();
  private cancelCalls = 0;

  constructor(
    private readonly messagePlan: () => AsyncGenerator<SDKMessage, void>,
    private readonly waitFn: () => Promise<RunResult>
  ) {}

  get status(): RunStatus {
    return this.currentStatus;
  }

  emitStatus(status: RunStatus): void {
    this.currentStatus = status;
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  supports(_operation: 'stream' | 'wait' | 'cancel' | 'conversation'): boolean {
    return true;
  }

  unsupportedReason(): string | undefined {
    return undefined;
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stream(): AsyncGenerator<SDKMessage, void> {
    return this.messagePlan();
  }

  async conversation(): Promise<never[]> {
    return [];
  }

  wait(): Promise<RunResult> {
    return this.waitFn();
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.emitStatus('cancelled');
  }

  get cancelCallCount(): number {
    return this.cancelCalls;
  }
}

describe('mapSdkLifecycleStatus', () => {
  it('maps terminal SDK lifecycle values', () => {
    assert.strictEqual(mapSdkLifecycleStatus('FINISHED'), 'finished');
    assert.strictEqual(mapSdkLifecycleStatus('ERROR'), 'error');
    assert.strictEqual(mapSdkLifecycleStatus('EXPIRED'), 'expired');
  });
});

describe('consumeRun', () => {
  it('ends on terminal status message while the stream stays open', async () => {
    const run = new FakeRun(
      async function* () {
        yield assistantText('partial ');
        yield lifecycleStatus('FINISHED');
        await new Promise(() => {
          /* never resolves — stream stays open */
        });
      },
      () =>
        new Promise(() => {
          /* hang — metadata wait should time out */
        })
    );

    const chunks: string[] = [];
    const outcome = await consumeRun(run, {
      onText: (text) => chunks.push(text),
      maxDurationMs: 30_000,
      waitMetadataTimeoutMs: 50,
    });

    assert.strictEqual(outcome.status, 'finished');
    assert.deepStrictEqual(chunks, ['partial ']);
  });

  it('ends when onDidChangeStatus reports finished without a status message', async () => {
    const run = new FakeRun(
      async function* () {
        yield assistantText('done');
        await new Promise(() => undefined);
      },
      async () => ({
        id: RUN_ID,
        status: 'finished',
        result: 'done',
      })
    );

    setTimeout(() => run.emitStatus('finished'), 10);

    const outcome = await consumeRun(run, { onText: () => undefined, maxDurationMs: 30_000 });
    assert.strictEqual(outcome.status, 'finished');
  });

  it('falls back to terminal status when wait() never resolves', async () => {
    const run = new FakeRun(
      async function* () {
        yield lifecycleStatus('FINISHED');
        await new Promise(() => undefined);
      },
      () =>
        new Promise(() => {
          /* never */
        })
    );

    const started = Date.now();
    const outcome = await consumeRun(run, {
      onText: () => undefined,
      maxDurationMs: 30_000,
      waitMetadataTimeoutMs: 100,
    });
    const elapsed = Date.now() - started;

    assert.strictEqual(outcome.status, 'finished');
    assert.ok(elapsed >= 90);
    assert.ok(elapsed < 2000);
  });

  it('does not complete early during long thinking-only gaps after text', async () => {
    const run = new FakeRun(
      async function* () {
        yield assistantText('start');
        for (let i = 0; i < 15; i += 1) {
          yield thinkingMessage(`step ${i}`);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        yield lifecycleStatus('FINISHED');
      },
      async () => ({ id: RUN_ID, status: 'finished' })
    );

    const outcome = await consumeRun(run, { onText: () => undefined, maxDurationMs: 60_000 });
    assert.strictEqual(outcome.status, 'finished');
  });

  it('surfaces tool_call progress without ending early', async () => {
    const statuses: string[] = [];
    const run = new FakeRun(
      async function* () {
        yield assistantText('x');
        yield toolCallMessage('Grep');
        await new Promise((resolve) => setTimeout(resolve, 500));
        yield lifecycleStatus('FINISHED');
      },
      async () => ({ id: RUN_ID, status: 'finished' })
    );

    await consumeRun(run, {
      onText: () => undefined,
      onStatus: (s) => statuses.push(s),
      maxDurationMs: 30_000,
    });

    assert.ok(statuses.some((s) => s.includes('Grep')));
  });

  it('returns error details from wait() when status is error', async () => {
    const run = new FakeRun(
      async function* () {
        yield lifecycleStatus('ERROR');
      },
      async () => ({
        id: RUN_ID,
        status: 'error',
        error: { message: 'model blew up', code: 'E_MODEL' },
      })
    );

    const outcome = await consumeRun(run, { onText: () => undefined, maxDurationMs: 30_000 });
    assert.strictEqual(outcome.status, 'error');
    assert.strictEqual(outcome.error?.message, 'model blew up');
  });

  it('returns cancelled when the abort signal fires', async () => {
    const controller = new AbortController();
    const run = new FakeRun(
      async function* () {
        yield thinkingMessage('working');
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield lifecycleStatus('FINISHED');
      },
      async () => ({ id: RUN_ID, status: 'finished' })
    );

    setTimeout(() => controller.abort(), 20);

    const outcome = await consumeRun(run, {
      onText: () => undefined,
      signal: controller.signal,
      maxDurationMs: 30_000,
    });

    assert.strictEqual(outcome.status, 'cancelled');
    assert.ok(run.cancelCallCount >= 1);
  });

  it('fails when the safety ceiling is exceeded', async () => {
    const run = new FakeRun(
      async function* () {
        yield thinkingMessage('slow');
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      async () => ({ id: RUN_ID, status: 'finished' })
    );

    await assert.rejects(
      () =>
        consumeRun(run, {
          onText: () => undefined,
          maxDurationMs: 80,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.match((err as ProviderError).message, /maximum duration/i);
        return true;
      }
    );
    assert.ok(run.cancelCallCount >= 1);
  });
});
