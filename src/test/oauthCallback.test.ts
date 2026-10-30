import assert from 'node:assert';
import * as http from 'node:http';
import { newOAuthState, waitForOAuthCallback } from '../jira/oauthCallback';

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

describe('waitForOAuthCallback', () => {
  it('resolves with the code when state matches', async () => {
    const port = 39481;
    const state = newOAuthState();
    const cb = waitForOAuthCallback({ port, expectedState: state });
    await cb.ready;
    const status = await get(`http://127.0.0.1:${port}/callback?code=abc&state=${state}`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(await cb.result, { code: 'abc' });
  });

  it('rejects on state mismatch', async () => {
    const port = 39482;
    const cb = waitForOAuthCallback({ port, expectedState: 'expected' });
    await cb.ready;
    const status = await get(`http://127.0.0.1:${port}/callback?code=abc&state=wrong`);
    assert.strictEqual(status, 400);
    await assert.rejects(cb.result, /invalid state/);
  });

  it('rejects on provider error', async () => {
    const port = 39483;
    const cb = waitForOAuthCallback({ port, expectedState: 's' });
    await cb.ready;
    await get(`http://127.0.0.1:${port}/callback?error=access_denied`);
    await assert.rejects(cb.result, /access_denied/);
  });
});
