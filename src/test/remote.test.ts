import { parseGitHubRemote } from '../util/githubRemote';
import assert from 'node:assert';

describe('parseGitHubRemote', () => {
  it('parses ssh and https remotes', () => {
    assert.deepStrictEqual(parseGitHubRemote('git@github.com:org/repo.git'), {
      owner: 'org',
      repo: 'repo',
    });
    assert.deepStrictEqual(parseGitHubRemote('https://github.com/org/repo'), {
      owner: 'org',
      repo: 'repo',
    });
  });
});
