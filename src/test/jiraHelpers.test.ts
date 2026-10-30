import assert from 'node:assert';
import {
  adfToPlain,
  assertMcpToolSuccess,
  buildIssueContext,
  parseAccessibleResources,
  pickCloudId,
  mcpToolResultToText,
} from '../jira/jiraHelpers';

describe('jiraHelpers', () => {
  it('assertMcpToolSuccess throws on isError', () => {
    assert.throws(
      () =>
        assertMcpToolSuccess({
          isError: true,
          content: [{ type: 'text', text: 'cloudId required' }],
        }),
      /cloudId required/
    );
  });

  it('mcpToolResultToText joins text blocks', () => {
    const text = mcpToolResultToText({
      content: [{ type: 'text', text: '{"key":"ART-1"}' }],
    });
    assert.strictEqual(text, '{"key":"ART-1"}');
  });

  it('parseAccessibleResources reads array JSON', () => {
    const resources = parseAccessibleResources(
      '[{"id":"abc-123","url":"https://foo.atlassian.net","name":"Foo"}]'
    );
    assert.strictEqual(resources.length, 1);
    assert.strictEqual(resources[0].id, 'abc-123');
  });

  it('pickCloudId matches site URL setting', () => {
    const resources = [
      { id: 'id-a', url: 'https://a.atlassian.net' },
      { id: 'id-b', url: 'https://b.atlassian.net' },
    ];
    assert.strictEqual(pickCloudId(resources, 'https://b.atlassian.net'), 'id-b');
  });

  it('pickCloudId uses first resource when setting empty', () => {
    assert.strictEqual(pickCloudId([{ id: 'only' }], ''), 'only');
  });

  it('buildIssueContext parses status and ADF description', () => {
    const raw = JSON.stringify({
      key: 'ART-99',
      fields: {
        summary: 'Fix bug',
        status: { name: 'In Progress' },
        issuetype: { name: 'Story' },
        description: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acceptance: works' }] }],
        },
        comment: {
          comments: [{ author: { displayName: 'Alice' }, body: 'LGTM' }],
        },
      },
    });
    const ctx = buildIssueContext('ART-99', raw);
    assert.strictEqual(ctx.summary, 'Fix bug');
    assert.strictEqual(ctx.status, 'In Progress');
    assert.strictEqual(ctx.issueType, 'Story');
    assert.ok(ctx.description?.includes('Acceptance'));
    assert.strictEqual(ctx.comments?.[0].author, 'Alice');
    assert.strictEqual(ctx.hasStructuredFields, true);
  });

  it('adfToPlain extracts nested text', () => {
    const plain = adfToPlain({
      type: 'doc',
      content: [{ type: 'text', text: 'hello' }],
    });
    assert.strictEqual(plain, 'hello');
  });
});
