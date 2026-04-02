/**
 * GitHub Issues + PRs knowledge connector.
 *
 * Fetches:
 *   - Issues assigned to the authenticated user (all repos or one specific repo)
 *   - Open PRs authored by or assigned to the user
 *
 * Separate from github.ts which fetches file contents.
 * Requires GITHUB_TOKEN (personal access token with repo scope) or config.secrets.GITHUB_TOKEN.
 *
 * Config example:
 *   { type: 'github-issues', name: 'My GitHub issues', refreshHours: 2 }
 *   { type: 'github-issues', name: 'argos PRs', owner: 'acme', repo: 'argos', refreshHours: 1 }
 */

import { createLogger } from '../../logger.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:github-issues');

interface GhIssue {
  number:      number;
  title:       string;
  html_url:    string;
  state:       string;
  body?:       string | null;
  labels:      Array<{ name: string }>;
  assignees:   Array<{ login: string }>;
  pull_request?: object;
  updated_at:  string;
  repository?: { full_name: string };
}

export async function fetchGitHubIssues(opts: {
  owner?:      string;
  repo?:       string;
  name:        string;
  refreshDays?: number;
}): Promise<KnowledgeDocument | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log.warn('GitHub issues connector: GITHUB_TOKEN not set — skipping');
    return null;
  }

  const headers: Record<string, string> = {
    'Authorization': `token ${token}`,
    'Accept':        'application/vnd.github.v3+json',
    'User-Agent':    'Argos/1.0',
  };

  const parts: string[] = [`# ${opts.name}\n`];

  try {
    // ── Assigned issues ────────────────────────────────────────────────────
    const issuesUrl = opts.owner && opts.repo
      ? `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues?state=open&assignee=@me&per_page=50`
      : 'https://api.github.com/issues?state=open&filter=assigned&per_page=50';

    const issuesRes = await fetch(issuesUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (issuesRes.ok) {
      const issues = await issuesRes.json() as GhIssue[];
      const realIssues = issues.filter(i => !i.pull_request);

      if (realIssues.length) {
        parts.push(`## Assigned Issues (${realIssues.length})\n`);
        for (const i of realIssues) {
          const repo  = i.repository?.full_name ?? `${opts.owner}/${opts.repo}`;
          const labels = i.labels.map(l => l.name).join(', ');
          parts.push(
            `### #${i.number} — ${i.title}`,
            `Repo: ${repo} | Updated: ${i.updated_at.slice(0, 10)}${labels ? ` | Labels: ${labels}` : ''}`,
            `URL: ${i.html_url}`,
            i.body ? i.body.slice(0, 500) : '',
            '',
          );
        }
      }
    }

    // ── Open PRs ───────────────────────────────────────────────────────────
    const prsUrl = opts.owner && opts.repo
      ? `https://api.github.com/repos/${opts.owner}/${opts.repo}/pulls?state=open&per_page=30`
      : 'https://api.github.com/search/issues?q=is:pr+is:open+involves:@me&per_page=30';

    const prsRes = await fetch(prsUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (prsRes.ok) {
      const prsData = await prsRes.json() as GhIssue[] | { items: GhIssue[] };
      const prs = Array.isArray(prsData) ? prsData : prsData.items;

      if (prs.length) {
        parts.push(`## Open Pull Requests (${prs.length})\n`);
        for (const pr of prs) {
          const repo  = pr.repository?.full_name ?? `${opts.owner}/${opts.repo}`;
          const labels = pr.labels.map(l => l.name).join(', ');
          parts.push(
            `### #${pr.number} — ${pr.title}`,
            `Repo: ${repo} | Updated: ${pr.updated_at.slice(0, 10)}${labels ? ` | Labels: ${labels}` : ''}`,
            `URL: ${pr.html_url}`,
            '',
          );
        }
      }
    }

    const fullText = parts.join('\n');
    if (fullText.trim() === `# ${opts.name}`) {
      log.debug('GitHub issues: no assigned issues or open PRs found');
      return null;
    }

    const isLarge = fullText.length > 8000;
    log.info(`GitHub issues "${opts.name}": fetched (${fullText.length} chars)`);

    return {
      key:      `github-issues:${opts.owner ?? 'me'}${opts.repo ? '/' + opts.repo : ''}`,
      name:     opts.name,
      content:  isLarge ? fullText.slice(0, 4000) + '\n\n[…full content indexed in vector store]' : fullText,
      tags:     ['github', 'issues', 'prs', 'tasks'],
      fullText: isLarge ? fullText : undefined,
    };
  } catch (e) {
    log.warn(`GitHub issues fetch failed: ${e}`);
    return null;
  }
}
