import assert from 'node:assert';
import type { Run, RunResult, RunStatus } from '@cursor/sdk';
import { consumeRun, createRunTracker, finalizeRun } from '../llm/cursorRun';
import { ProviderError } from '../llm/errors';
import { ActiveReviewGate } from '../review/activeReview';
import { REVIEW_ALLOWED_TOOLS, REVIEW_DISALLOWED_TOOLS } from '../llm/cursor';

class FakeRun {
  readonly id = 'run-test';
  readonly agentId = 'agent-test';
  status: RunStatus = 'running';
  cancelCalls = 0;
  constructor(private readonly waitFn: () => Promise<RunResult>) {}
  supports(): boolean {
    return true;
  }
  wait(): Promise<RunResult> {
    return this.waitFn();
  }
  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.status = 'cancelled';
  }
}

const never = (): Promise<RunResult> => new Promise(() => undefined);
const asRun = (r: FakeRun): Run => r as unknown as Run;

function setup() {
  const chunks: string[] = [];
  const statuses: string[] = [];
  const tracker = createRunTracker({ onText: (t) => chunks.push(t), onStatus: (s) => statuses.push(s) });
  return { chunks, statuses, tracker };
}

describe('consumeRun', () => {
  it('completes on turn-ended while wait() never resolves and the run stays running', async () => {
    const { chunks, tracker } = setup();
    const run = new FakeRun(never);
    const p = consumeRun(asRun(run), tracker, { maxDurationMs: 30_000 });
    tracker.onDelta({ update: { type: 'text-delta', text: 'Hello ' } });
    tracker.onDelta({ update: { type: 'text-delta', text: 'world' } });
    tracker.onDelta({ update: { type: 'turn-ended' } });
    const outcome = await p;
    assert.strictEqual(outcome.status, 'finished');
    assert.strictEqual(outcome.endedBy, 'turn-ended');
    assert.deepStrictEqual(chunks, ['Hello ', 'world']);
  });

  it('does not complete on thinking or tool updates after text', async () => {
    const { statuses, tracker } = setup();
    const run = new FakeRun(never);
    let done = false;
    const p = consumeRun(asRun(run), tracker, { maxDurationMs: 30_000 }).then((o) => {
      done = true;
      return o;
    });
    tracker.onDelta({ update: { type: 'text-delta', text: 'x' } });
    tracker.onDelta({ update: { type: 'thinking-delta', text: 'pondering' } });
    tracker.onDelta({ update: { type: 'tool-call-started', toolCall: { name: 'read' } } });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(done, false);
    assert.ok(statuses.some((s) => s.startsWith('Thinking')));
    tracker.onDelta({ update: { type: 'turn-ended' } });
    assert.strictEqual((await p).endedBy, 'turn-ended');
  });

  it('ignores updates after turn-ended', () => {
    const { chunks, tracker } = setup();
    tracker.onDelta({ update: { type: 'turn-ended' } });
    tracker.onDelta({ update: { type: 'text-delta', text: 'late' } });
    assert.deepStrictEqual(chunks, []);
  });

  it('survives handler errors', () => {
    const tracker = createRunTracker({
      onText: () => {
        throw new Error('ui');
      },
    });
    tracker.onDelta({ update: { type: 'text-delta', text: 'a' } });
    tracker.onDelta({ update: { type: 'turn-ended' } });
    assert.strictEqual(tracker.hasEnded(), true);
  });

  it('fails when wait() rejects before any output', async () => {
    const { tracker } = setup();
    const run = new FakeRun(() => Promise.reject(new Error('boom')));
    await assert.rejects(consumeRun(asRun(run), tracker), /boom/);
  });

  it('treats wait() rejection after output as finished', async () => {
    const { tracker } = setup();
    tracker.onDelta({ update: { type: 'text-delta', text: 'x' } });
    const run = new FakeRun(() => Promise.reject(new Error('late')));
    const outcome = await consumeRun(asRun(run), tracker);
    assert.strictEqual(outcome.status, 'finished');
  });

  it('completes when wait() finishes without turn-ended', async () => {
    const { tracker } = setup();
    const run = new FakeRun(async () => ({ id: 'run-test', status: 'finished' }));
    const outcome = await consumeRun(asRun(run), tracker);
    assert.deepStrictEqual([outcome.status, outcome.endedBy], ['finished', 'wait']);
  });

  it('returns error details from wait()', async () => {
    const { tracker } = setup();
    const run = new FakeRun(async () => ({
      id: 'run-test',
      status: 'error',
      error: { message: 'bad', code: 'E1' },
    }));
    const outcome = await consumeRun(asRun(run), tracker);
    assert.strictEqual(outcome.status, 'error');
    assert.strictEqual(outcome.error?.code, 'E1');
  });

  it('cancels the run when the abort signal fires', async () => {
    const { tracker } = setup();
    const run = new FakeRun(never);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const outcome = await consumeRun(asRun(run), tracker, { signal: ac.signal });
    assert.strictEqual(outcome.status, 'cancelled');
    assert.strictEqual(run.cancelCalls, 1);
  });

  it('fails and cancels when the ceiling is exceeded', async () => {
    const { tracker } = setup();
    const run = new FakeRun(never);
    await assert.rejects(
      consumeRun(asRun(run), tracker, { maxDurationMs: 20 }),
      (err: unknown) => err instanceof ProviderError && /maximum duration/.test(err.message)
    );
    assert.strictEqual(run.cancelCalls, 1);
  });
});

describe('finalizeRun', () => {
  it('cancels the run when the lifecycle does not settle within the grace period', async () => {
    const run = new FakeRun(never);
    const result = await finalizeRun(asRun(run), 20);
    assert.strictEqual(result.lifecycle, 'cancelled-after-grace');
    assert.strictEqual(run.cancelCalls, 1);
  });

  it('does not cancel when the lifecycle settles in time', async () => {
    const run = new FakeRun(async () => ({ id: 'run-test', status: 'finished' }));
    const result = await finalizeRun(asRun(run), 1000);
    assert.strictEqual(result.lifecycle, 'finished');
    assert.strictEqual(run.cancelCalls, 0);
  });
});

describe('review read-only guardrail', () => {
  it('only allows read tools and denies every mutating capability', () => {
    assert.deepStrictEqual([...REVIEW_ALLOWED_TOOLS].sort(), ['glob', 'grep', 'ls', 'read']);
    for (const tool of ['shell', 'edit', 'delete', 'applyAgentDiff', 'mcp', 'task']) {
      assert.ok(REVIEW_DISALLOWED_TOOLS.includes(tool), `${tool} must be denied`);
      assert.ok(!REVIEW_ALLOWED_TOOLS.includes(tool), `${tool} must not be allowed`);
    }
  });
});

describe('ActiveReviewGate', () => {
  it('aborts the previous review so it cannot write to the panel', () => {
    const gate = new ActiveReviewGate();
    const first = gate.begin();
    const writes: string[] = [];
    const write = (generation: number, text: string): void => {
      if (gate.isCurrent(generation)) {
        writes.push(text);
      }
    };

    const second = gate.begin();
    write(first.generation, 'stale');
    write(second.generation, 'fresh');
    gate.end(first.generation);

    assert.strictEqual(first.signal.aborted, true);
    assert.strictEqual(second.signal.aborted, false);
    assert.strictEqual(gate.isCurrent(second.generation), true);
    assert.deepStrictEqual(writes, ['fresh']);
  });
});
