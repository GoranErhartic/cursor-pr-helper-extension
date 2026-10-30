import assert from 'node:assert';
import { isAbortError, mapHttpToProviderError, ProviderError, redactSecrets } from '../llm/errors';
import { mapCursorError } from '../llm/cursor';
import { isProviderId, secretKeyForProvider } from '../llm/types';

describe('redactSecrets', () => {
  it('removes the exact api key and known key shapes', () => {
    const key = 'crsr_abcdef1234567890';
    const out = redactSecrets(`failed for ${key} with Bearer abc.def-123 and sk-ant-abcdefgh12 / sk-abcdefgh12`, key);
    assert.ok(!out.includes(key));
    assert.ok(!out.includes('abc.def-123'));
    assert.ok(out.includes('REDACTED:API_KEY'));
    assert.ok(out.includes('REDACTED:ANTHROPIC_KEY'));
    assert.ok(out.includes('REDACTED:OPENAI_KEY'));
  });
});

describe('mapHttpToProviderError', () => {
  it('maps auth failures to invalid_key', () => {
    assert.strictEqual(mapHttpToProviderError(401, '').code, 'invalid_key');
    assert.strictEqual(mapHttpToProviderError(403, '').code, 'invalid_key');
  });

  it('maps 429 to rate_limit and others to api with redacted body', () => {
    assert.strictEqual(mapHttpToProviderError(429, '').code, 'rate_limit');
    const err = mapHttpToProviderError(500, 'boom secret-key-value', 'secret-key-value');
    assert.strictEqual(err.code, 'api');
    assert.ok(!err.message.includes('secret-key-value'));
  });
});

describe('mapCursorError', () => {
  const key = 'crsr_testkey1234567';

  it('maps SDK authentication errors to invalid_key', () => {
    const err = mapCursorError(Object.assign(new Error('Invalid User API Key'), { status: 401 }), key);
    assert.strictEqual(err.code, 'invalid_key');
    assert.strictEqual(err.status, 401);
  });

  it('maps rate limits and redacts the key from generic failures', () => {
    assert.strictEqual(mapCursorError(Object.assign(new Error('x'), { status: 429 }), key).code, 'rate_limit');
    const generic = mapCursorError(new Error(`network down for ${key}`), key);
    assert.strictEqual(generic.code, 'api');
    assert.ok(!generic.message.includes(key));
  });

  it('passes ProviderError through and maps AbortError', () => {
    const original = new ProviderError('nope', 'network');
    assert.strictEqual(mapCursorError(original, key), original);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.strictEqual(mapCursorError(abort, key).code, 'aborted');
  });
});

describe('isAbortError', () => {
  it('recognises DOM/Error aborts and aborted ProviderErrors only', () => {
    assert.ok(isAbortError(new DOMException('Aborted', 'AbortError')));
    assert.ok(isAbortError(new ProviderError('Request aborted.', 'aborted')));
    assert.ok(!isAbortError(new ProviderError('x', 'api')));
    assert.ok(!isAbortError(new Error('x')));
  });
});

describe('provider ids', () => {
  it('validates ids and namespaces secret keys per provider', () => {
    assert.ok(isProviderId('cursor'));
    assert.ok(!isProviderId('nope'));
    assert.strictEqual(secretKeyForProvider('cursor'), 'prHelper.apiKey.cursor');
  });
});
