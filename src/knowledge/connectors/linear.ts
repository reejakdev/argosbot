/**
 * Linear knowledge connector.
 *
 * Fetches open/in-progress issues + active projects for a team.
 * Uses the Linear GraphQL API — no SDK, plain fetch.
 *
 * Requires: config.linear.apiKey + knowledge source with type='linear' + teamId.
 *
 * Refresh default: every 6h (issues change frequently vs Notion pages).
 */

import { createLogger } from '../../logger.js';
import type { KnowledgeDocument } from '../types.js';
import type { Config } from '../../config/schema.js';

const log = createLogger('linear');

const LINEAR_API = 'https://api.linear.app/graphql';

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const ISSUES_QUERY = `
  query TeamIssues($teamId: String!) {
    team(id: $teamId) {
      name
      issues(
        filter: { state: { type: { in: ["unstarted", "started"] } } }
        orderBy: updatedAt
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          description
          priority
          state  { name type }
          assignee { name }
          createdAt
          updatedAt
        }
      }
      projects(first: 20) {
        nodes {
          id
          name
          description
          state
          progress
        }
      }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function priorityLabel(p: number): string {
  return ['None', 'Urgent', 'High', 'Medium', 'Low'][p] ?? 'None';
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export async function fetchLinear(
  opts: { teamId: string; name: string; refreshDays: number },
  config: Config,
): Promise<KnowledgeDocument | null> {
  const apiKey = config.linear?.apiKey;
  if (!apiKey) {
    log.warn('Linear apiKey not configured — skipping');
    return null;
  }

  let data: Record<string, unknown>;
  try {
    const res = await fetch(LINEAR_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': apiKey,   // Linear accepts raw key or "Bearer <key>"
      },
      body: JSON.stringify({ query: ISSUES_QUERY, variables: { teamId: opts.teamId } }),
    });

    if (!res.ok) {
      log.warn(`Linear API error ${res.status} for team ${opts.teamId}`);
      return null;
    }

    const json = await res.json() as { data?: { team?: unknown }; errors?: unknown[] };
    if (json.errors?.length) {
      log.warn('Linear GraphQL errors', json.errors);
      return null;
    }
    data = (json.data ?? {}) as Record<string, unknown>;
  } catch (e) {
    log.warn(`Linear fetch failed: ${e}`);
    return null;
  }

  const team = data.team as {
    name: string;
    issues: { nodes: Array<{
      id: string; identifier: string; title: string; description?: string;
      priority: number; state: { name: string; type: string };
      assignee?: { name: string }; createdAt: string; updatedAt: string;
    }> };
    projects: { nodes: Array<{
      id: string; name: string; description?: string; state: string; progress: number;
    }> };
  } | null;

  if (!team) {
    log.warn(`Linear team ${opts.teamId} not found`);
    return null;
  }

  // ─── Format readable content ───────────────────────────────────────────────
  const lines: string[] = [`# Linear — ${team.name}\n`];

  // Active projects
  const activeProjects = team.projects.nodes.filter(p => p.state !== 'completed' && p.state !== 'cancelled');
  if (activeProjects.length) {
    lines.push('## Active Projects\n');
    for (const p of activeProjects) {
      const pct = Math.round(p.progress * 100);
      lines.push(`- **${p.name}** [${p.state}, ${pct}%]${p.description ? ` — ${p.description.slice(0, 120)}` : ''}`);
    }
    lines.push('');
  }

  // Open issues
  if (team.issues.nodes.length) {
    lines.push('## Open Issues\n');
    for (const issue of team.issues.nodes) {
      const assignee  = issue.assignee?.name ?? 'unassigned';
      const priority  = priorityLabel(issue.priority);
      const updatedAt = new Date(issue.updatedAt).toLocaleDateString();
      lines.push(`- [${issue.identifier}] **${issue.title}** — ${issue.state.name} | ${priority} | ${assignee} | updated ${updatedAt}`);
      if (issue.description) {
        lines.push(`  ${issue.description.slice(0, 200).replace(/\n/g, ' ')}`);
      }
    }
    lines.push('');
  } else {
    lines.push('No open issues.\n');
  }

  const content = lines.join('\n').slice(0, 8000);

  log.info(`Linear: fetched ${team.issues.nodes.length} issues + ${activeProjects.length} projects for ${team.name}`);

  return {
    key:     `linear:${opts.teamId}`,
    name:    opts.name,
    content,
    tags:    ['linear', 'issues', team.name.toLowerCase()],
  };
}
