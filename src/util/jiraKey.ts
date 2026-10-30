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
  return pickPrimaryJiraKeyFromTexts([branch, title], projectKeys);
}

export function pickPrimaryJiraKeyFromTexts(texts: string[], projectKeys: string[]): string | undefined {
  for (const text of texts) {
    const scoped = extractJiraKeys(text, projectKeys);
    if (scoped.length > 0) {
      return scoped[0];
    }
  }
  // If project keys were configured but no match was found, fall back to generic key extraction.
  if (projectKeys.length > 0) {
    for (const text of texts) {
      const fallback = extractJiraKeys(text, []);
      if (fallback.length > 0) {
        return fallback[0];
      }
    }
  }
  return undefined;
}
