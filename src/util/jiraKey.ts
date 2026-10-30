const DEFAULT_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export function parseProjectKeys(config: string): string[] {
  return config
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function extractJiraKeys(text: string, projectKeys: string[]): string[] {
  if (!text) {
    return [];
  }
  const keys = new Set<string>();
  const pattern =
    projectKeys.length > 0
      ? new RegExp(`\\b(${projectKeys.join('|')})-\\d+\\b`, 'gi')
      : DEFAULT_KEY_PATTERN;

  let match: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags);
  while ((match = re.exec(text)) !== null) {
    keys.add(match[0].toUpperCase());
  }
  return [...keys];
}

export function pickPrimaryJiraKey(branch: string, title: string, projectKeys: string[]): string | undefined {
  const fromBranch = extractJiraKeys(branch, projectKeys);
  if (fromBranch.length > 0) {
    return fromBranch[0];
  }
  const fromTitle = extractJiraKeys(title, projectKeys);
  return fromTitle[0];
}
