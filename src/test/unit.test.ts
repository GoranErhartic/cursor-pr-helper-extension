import assert from 'node:assert';
import { extractJiraKeys, pickPrimaryJiraKey, parseProjectKeys, pickPrimaryJiraKeyFromTexts } from '../util/jiraKey';
import { buildReviewPrompt } from '../review/buildPrompt';
import type { PullRequestDetail } from '../github/GitHubClient';

describe('jiraKey', () => {
  it('extracts keys from branch and title', () => {
    assert.deepStrictEqual(extractJiraKeys('feat/ART-722/foo', []), ['ART-722']);
    assert.deepStrictEqual(extractJiraKeys('fix something RE-99', ['RE']), ['RE-99']);
  });

  it('pickPrimaryJiraKey prefers branch', () => {
    const key = pickPrimaryJiraKey('feat/ART-1/x', 'RE-2 title', []);
    assert.strictEqual(key, 'ART-1');
  });

  it('parseProjectKeys splits config', () => {
    assert.deepStrictEqual(parseProjectKeys(' art, RE '), ['ART', 'RE']);
  });

  it('pickPrimaryJiraKeyFromTexts checks body and falls back when project filter misses', () => {
    const key = pickPrimaryJiraKeyFromTexts(
      ['feature/no-ticket', 'Improve parser', 'Implements ABC-123 acceptance criteria'],
      ['ART', 'RE']
    );
    assert.strictEqual(key, 'ABC-123');
  });
});

describe('buildReviewPrompt', () => {
  const pr: PullRequestDetail = {
    number: 1,
    title: 'Test',
    author: 'dev',
    draft: false,
    htmlUrl: 'https://github.com/o/r/pull/1',
    headRef: 'feature',
    baseRef: 'main',
    createdAt: '',
    updatedAt: '',
    labels: [],
    reviewers: [],
    body: 'body',
    mergeableState: 'clean',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    checks: [],
    issueComments: [],
    reviewComments: [],
    reviews: [],
  };

  it('includes diff and metadata', () => {
    const { userPrompt, systemPrompt } = buildReviewPrompt({
      pr,
      diff: '+line',
      repoFullName: 'o/r',
    });
    assert.ok(systemPrompt.includes('pull request review'));
    assert.ok(userPrompt.includes('# Pull request #1'));
    assert.ok(userPrompt.includes('+line'));
  });

  it('includes structured Jira comments without raw dump', () => {
    const { userPrompt } = buildReviewPrompt({
      pr,
      diff: '+line',
      repoFullName: 'o/r',
      jira: {
        key: 'ART-1',
        summary: 'Do thing',
        status: 'Open',
        comments: [{ author: 'Bob', body: 'Criteria: must pass tests' }],
        rawText: '{"key":"ART-1"}',
        hasStructuredFields: true,
      },
    });
    assert.ok(userPrompt.includes('## Jira ART-1'));
    assert.ok(userPrompt.includes('Criteria: must pass tests'));
    assert.ok(!userPrompt.includes('Raw (truncated)'));
  });

  it('system prompt covers the stack checklists and output contract', () => {
    const { systemPrompt } = buildReviewPrompt({ pr, diff: '+line', repoFullName: 'o/r' });
    for (const section of [
      '# TypeScript (all code)',
      '# Backend (AWS Lambda)',
      '# Frontend (Vue 3)',
      '# CDK / infra wiring compliance',
      '# CDK quality',
      '# Severity rubric',
      '- Verdict:',
      '- **Confidence:**',
      '### Not reviewed / blind spots',
    ]) {
      assert.ok(systemPrompt.includes(section), `missing: ${section}`);
    }
  });
});
