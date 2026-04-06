/**
 * fetch_url skill — fetch and extract readable text from any public URL.
 * Strips HTML, returns clean plain text.
 */

import { registerSkill } from '../registry.js';

registerSkill({
  name: 'fetch_url',
  description: 'Fetch and extract text content from any public URL',
  tool: {
    name: 'fetch_url',
    description:
      'Fetch a URL and return its readable text content (HTML stripped). Useful for reading docs, articles, pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
        max_chars: {
          type: 'string',
          description: 'Maximum characters to return (default: 5000)',
        },
      },
      required: ['url'],
    },
  },
  handler: async (input) => {
    const url = String(input.url ?? '').trim();
    const maxChars = Math.min(Number(input.max_chars ?? 5000), 20_000);

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: false, output: 'URL must start with http:// or https://' };
    }

    // SSRF guard — block localhost, private IPs, cloud metadata endpoints
    try {
      const parsed = new URL(url);
      const h = parsed.hostname.toLowerCase();
      if (
        h === 'localhost' ||
        h === '0.0.0.0' ||
        h === '::1' ||
        h.endsWith('.localhost') ||
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        /^169\.254\./.test(h) ||
        h === '169.254.169.254' ||
        h === 'metadata.google.internal' ||
        h === '100.100.100.200'
      ) {
        return { success: false, output: `Security: blocked private/internal network (${h})` };
      }
    } catch {
      return { success: false, output: 'Invalid URL' };
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Argos/1.0 (AI assistant; research purposes)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { success: false, output: `HTTP ${res.status}: ${res.statusText}` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();

    let clean: string;
    if (contentType.includes('text/html')) {
      clean = stripHtml(text);
    } else {
      // Plain text / JSON / markdown — return as-is
      clean = text;
    }

    // Collapse blank lines, trim
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    if (clean.length === 0) {
      return { success: false, output: 'Page returned no readable content' };
    }

    const truncated = clean.length > maxChars;
    const output = truncated
      ? clean.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars]`
      : clean;

    return { success: true, output, data: { url, chars: clean.length, truncated } };
  },
});

// ─── HTML stripper ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return (
    html
      // Remove <script> and <style> blocks entirely
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      // Convert block elements to newlines
      .replace(
        /<\/(p|div|h[1-6]|li|tr|blockquote|pre|article|section|header|footer|main|nav|aside)>/gi,
        '\n',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      // Strip all remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode common HTML entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Normalize whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
  );
}
