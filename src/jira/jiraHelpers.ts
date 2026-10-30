export interface JiraIssueContext {
  key: string;
  summary?: string;
  description?: string;
  status?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  comments?: { author: string; body: string }[];
  rawText: string;
  hasStructuredFields: boolean;
}

export interface AtlassianResource {
  id: string;
  url?: string;
  name?: string;
}

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolResultShape {
  content?: McpContentBlock[];
  isError?: boolean;
}

const MAX_COMMENT_BODY = 2000;
const MAX_COMMENTS = 20;

export function mcpToolResultToText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '');
  }
  const content = (result as McpToolResultShape).content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

export function assertMcpToolSuccess(result: unknown): string {
  const text = mcpToolResultToText(result);
  const isError = Boolean(result && typeof result === 'object' && (result as McpToolResultShape).isError);
  if (isError) {
    throw new Error(text.trim() || 'Jira MCP tool returned an error');
  }
  return text;
}

export function parseAccessibleResources(rawText: string): AtlassianResource[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const found = collectResources(JSON.parse(trimmed) as unknown);
    if (found.length > 0) {
      return found;
    }
  } catch {
    // not JSON; fall through to text scan
  }
  // Text fallback: pair each UUID with a nearby https://*.atlassian.net URL.
  const uuids = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) ?? [];
  const urls = trimmed.match(/https:\/\/[a-z0-9.-]+\.atlassian\.net/gi) ?? [];
  return [...new Set(uuids)].map((id, i) => ({ id, url: urls[i] }));
}

/** Walks arbitrary JSON and collects objects that look like Atlassian sites (id/cloudId + url). */
function collectResources(node: unknown, depth = 0): AtlassianResource[] {
  if (depth > 4 || !node || typeof node !== 'object') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((n) => collectResources(n, depth + 1));
  }
  const o = node as Record<string, unknown>;
  if ((o.id ?? o.cloudId) != null && (o.url ?? o.siteUrl) != null) {
    const r = normalizeResource(o);
    return r.id ? [r] : [];
  }
  return Object.values(o).flatMap((v) => collectResources(v, depth + 1));
}

/** Describes response shape without leaking content (for diagnostics). */
export function describeResourcesResponse(rawText: string): string {
  return `${rawText.length} chars, starts with ${JSON.stringify(rawText.trim().slice(0, 1))}`;
}

function normalizeResource(entry: unknown): AtlassianResource {
  if (!entry || typeof entry !== 'object') {
    return { id: '' };
  }
  const o = entry as Record<string, unknown>;
  const id = String(o.id ?? o.cloudId ?? '');
  const url = o.url != null ? String(o.url) : o.siteUrl != null ? String(o.siteUrl) : undefined;
  const name = o.name != null ? String(o.name) : undefined;
  return { id, url, name };
}

export function pickCloudId(resources: AtlassianResource[], siteUrlSetting: string): string {
  const setting = siteUrlSetting.trim();
  if (setting) {
    const lower = setting.toLowerCase().replace(/\/$/, '');
    const match = resources.find((r) => {
      const idLower = r.id.toLowerCase();
      const urlLower = (r.url ?? '').toLowerCase().replace(/\/$/, '');
      return (
        idLower === lower ||
        urlLower === lower ||
        urlLower.includes(lower) ||
        lower.includes(urlLower)
      );
    });
    if (match) {
      return match.id;
    }
    if (/^[a-f0-9-]{36}$/i.test(setting)) {
      return setting;
    }
    // Atlassian MCP tools also accept the site hostname as cloudId.
    const host = setting.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (/^[a-z0-9-]+\.atlassian\.net$/i.test(host)) {
      return host;
    }
    throw new Error(`No accessible Atlassian site matches prHelper.jiraSiteUrl: ${setting}`);
  }
  if (resources.length === 0) {
    throw new Error('No accessible Atlassian sites for this token.');
  }
  return resources[0].id;
}

export function isLikelyAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('unauthorized') ||
    m.includes('forbidden') ||
    m.includes('invalid token') ||
    m.includes('not authenticated')
  );
}

export function buildIssueContext(issueKey: string, rawText: string): JiraIssueContext {
  const parsed = parseIssuePayload(rawText);
  const hasStructuredFields = Boolean(
    parsed.summary || parsed.description || parsed.status || parsed.comments.length > 0
  );
  return {
    key: parsed.key ?? issueKey,
    summary: parsed.summary,
    description: parsed.description,
    status: parsed.status,
    issueType: parsed.issueType,
    priority: parsed.priority,
    labels: parsed.labels,
    comments: parsed.comments,
    rawText,
    hasStructuredFields,
  };
}

function parseIssuePayload(rawText: string): {
  key?: string;
  summary?: string;
  description?: string;
  status?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  comments: { author: string; body: string }[];
} {
  const empty = { comments: [] as { author: string; body: string }[] };
  const trimmed = rawText.trim();
  if (!trimmed) {
    return empty;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const fields = (parsed.fields as Record<string, unknown> | undefined) ?? parsed;
    const key = parsed.key != null ? String(parsed.key) : undefined;
    return {
      key,
      summary: readStringField(fields, 'summary'),
      description: readDescription(fields.description),
      status: readNamedField(fields.status),
      issueType: readNamedField(fields.issuetype),
      priority: readNamedField(fields.priority),
      labels: readLabels(fields.labels),
      comments: readComments(fields.comment),
    };
  } catch {
    return {
      ...empty,
      description: trimmed.length > 0 ? trimmed : undefined,
    };
  }
}

function readStringField(fields: Record<string, unknown>, name: string): string | undefined {
  const v = fields[name];
  if (v == null) {
    return undefined;
  }
  if (typeof v === 'string') {
    return v;
  }
  return undefined;
}

function readNamedField(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'name' in value) {
    return String((value as { name: unknown }).name);
  }
  return undefined;
}

function readDescription(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  const fromAdf = adfToPlain(value);
  return fromAdf?.trim() || undefined;
}

function readLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const labels = value.map((l) => (typeof l === 'string' ? l : String(l))).filter(Boolean);
  return labels.length > 0 ? labels : undefined;
}

function readComments(commentField: unknown): { author: string; body: string }[] {
  if (!commentField || typeof commentField !== 'object') {
    return [];
  }
  const comments = (commentField as { comments?: unknown[] }).comments;
  if (!Array.isArray(comments)) {
    return [];
  }
  const out: { author: string; body: string }[] = [];
  for (const c of comments.slice(0, MAX_COMMENTS)) {
    if (!c || typeof c !== 'object') {
      continue;
    }
    const row = c as Record<string, unknown>;
    const authorObj = row.author as { displayName?: string } | undefined;
    const author = authorObj?.displayName ?? 'unknown';
    const bodyRaw = row.body;
    let body: string | undefined;
    if (typeof bodyRaw === 'string') {
      body = bodyRaw;
    } else {
      body = adfToPlain(bodyRaw);
    }
    if (!body?.trim()) {
      continue;
    }
    out.push({
      author,
      body: body.slice(0, MAX_COMMENT_BODY),
    });
  }
  return out;
}

export function adfToPlain(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (node.type === 'text' && typeof node.text === 'string') {
    return node.text;
  }
  if (Array.isArray(node.content)) {
    const parts = node.content.map((child) => adfToPlain(child)).filter(Boolean);
    return parts.join('');
  }
  return undefined;
}

export function issueContextLooksEmpty(ctx: JiraIssueContext): boolean {
  return !ctx.hasStructuredFields && ctx.rawText.trim().length < 20;
}
