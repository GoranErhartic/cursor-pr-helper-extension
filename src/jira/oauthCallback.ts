import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

export interface CallbackResult {
  code: string;
}

export function newOAuthState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Starts a loopback HTTP server on 127.0.0.1 and resolves with the authorization code once the
 * browser is redirected back. Rejects on state mismatch, provider error, timeout or cancellation.
 */
export function waitForOAuthCallback(options: {
  port: number;
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): { ready: Promise<void>; result: Promise<CallbackResult> } {
  const { port, expectedState, timeoutMs = 5 * 60_000, signal } = options;
  let server: http.Server | undefined;
  let timer: NodeJS.Timeout | undefined;

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const result = new Promise<CallbackResult>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (timer) {
        clearTimeout(timer);
      }
      server?.close();
      fn();
    };

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const respond = (status: number, message: string): void => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>PR Helper</title><body style="font-family:sans-serif"><p>${message}</p></body>`);
      };
      if (error) {
        respond(400, 'Sign-in failed. You can close this tab.');
        finish(() => reject(new Error(`Jira sign-in failed: ${error}`)));
        return;
      }
      if (!code || state !== expectedState) {
        respond(400, 'Invalid sign-in response. You can close this tab.');
        finish(() => reject(new Error('Jira sign-in failed: invalid state or missing code')));
        return;
      }
      respond(200, 'Signed in to Jira. You can close this tab and return to the editor.');
      finish(() => resolve({ code }));
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      const e =
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use. Change prHelper.jiraOAuthPort and retry.`)
          : err;
      rejectReady(e);
      finish(() => reject(e));
    });
    server.listen(port, '127.0.0.1', () => resolveReady());

    timer = setTimeout(() => finish(() => reject(new Error('Jira sign-in timed out.'))), timeoutMs);
    signal?.addEventListener('abort', () => finish(() => reject(new Error('Jira sign-in cancelled.'))));
  });
  // Avoid unhandled rejection if only `ready` is awaited and fails first.
  result.catch(() => undefined);

  return { ready, result };
}
