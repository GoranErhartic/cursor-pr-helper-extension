export type ProviderErrorCode = 'invalid_key' | 'rate_limit' | 'network' | 'api' | 'aborted';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function redactSecrets(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length > 4) {
    out = out.split(apiKey).join('REDACTED:API_KEY');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer REDACTED:TOKEN');
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'REDACTED:ANTHROPIC_KEY');
  out = out.replace(/sk-[A-Za-z0-9]{8,}/g, 'REDACTED:OPENAI_KEY');
  out = out.replace(/(?:cursor|crsr)_[A-Za-z0-9_-]{8,}/g, 'REDACTED:CURSOR_KEY');
  return out;
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

export function mapHttpToProviderError(status: number, body: string, apiKey?: string): ProviderError {
  const message = redactSecrets(body || `HTTP ${status}`, apiKey);
  if (status === 401 || status === 403) {
    return new ProviderError(
      'Invalid API key. Reconfigure your key via "PR Helper: Configure Provider".',
      'invalid_key',
      status
    );
  }
  if (status === 429) {
    return new ProviderError('Rate limit exceeded. Try again shortly.', 'rate_limit', status);
  }
  return new ProviderError(message || `Request failed (${status})`, 'api', status);
}

/** Combines the caller's signal with a request timeout. */
export function withTimeout(signal?: AbortSignal, ms = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.code === 'aborted';
  }
  return (err instanceof Error || err instanceof DOMException) && err.name === 'AbortError';
}
