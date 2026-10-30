import * as assert from 'assert';
import { renderMarkdown } from '../util/markdown';

describe('renderMarkdown', () => {
  it('renders markdown formatting', () => {
    const html = renderMarkdown('## Title\n\n- a\n- b\n\n`x`');
    assert.ok(html.includes('<h2'));
    assert.ok(html.includes('<li>a</li>'));
    assert.ok(html.includes('<code>x</code>'));
  });
  it('escapes raw html and scripts', () => {
    const html = renderMarkdown('<script nonce="detail">alert(1)</script>');
    assert.ok(!html.includes('<script'));
  });
  it('drops javascript: links', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    assert.ok(!html.includes('href'));
  });
});
