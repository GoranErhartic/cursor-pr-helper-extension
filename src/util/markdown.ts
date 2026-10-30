import { Marked } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SAFE_URL = /^https?:\/\//i;

const safeMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Untrusted input: never pass raw HTML through.
    html(html: string): string {
      return escapeHtml(html);
    },
    link(href: string, title: string | null | undefined, text: string): string {
      if (!SAFE_URL.test(href)) {
        return text;
      }
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t}>${text}</a>`;
    },
    image(href: string, _title: string | null, text: string): string {
      if (!SAFE_URL.test(href)) {
        return escapeHtml(text);
      }
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`;
    },
  },
});

/** Renders untrusted GitHub markdown (PR body, comments) to safe HTML. */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) {
    return '';
  }
  return safeMarked.parse(markdown, { async: false }) as string;
}
