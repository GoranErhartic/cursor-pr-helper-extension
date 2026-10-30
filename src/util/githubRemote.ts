export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(\.git)?$/i.exec(url);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2].replace(/\.git$/, '') };
  }
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?\/?$/i.exec(url);
  if (https) {
    return { owner: https[1], repo: https[2].replace(/\.git$/, '') };
  }
  return undefined;
}
