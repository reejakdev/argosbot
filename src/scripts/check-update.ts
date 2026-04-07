/**
 * Check for available Argos updates via GitHub Releases API.
 * Compares local package.json version with the latest published GitHub release.
 *
 * No git clone required, no auth, cacheable via GitHub CDN.
 * Standard pattern used by Bitwarden, Signal, Cursor, etc.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const GITHUB_REPO = 'reejakdev/argosbot'; // owner/repo
const TAGS_URL = `https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=30`;

export interface UpdateInfo {
  current: string;       // local version e.g. "0.1.0"
  latest: string;        // latest tag name e.g. "v0.2.0"
  latestVersion: string; // tag without "v" prefix e.g. "0.2.0"
  releaseUrl: string;    // GitHub tag page URL
  changelog: string;     // commit message of the tagged commit
  publishedAt: string;   // ISO date of the tagged commit
  hasUpdate: boolean;
  error?: string;
}

/** Semver comparison: returns true if latest > current */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(current);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(latest);
  if (b1 !== a1) return b1 > a1;
  if (b2 !== a2) return b2 > a2;
  return b3 > a3;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const result: UpdateInfo = {
    current: '',
    latest: '',
    latestVersion: '',
    releaseUrl: '',
    changelog: '',
    publishedAt: '',
    hasUpdate: false,
  };

  try {
    // Read local version from package.json
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
    };
    result.current = pkg.version;

    // Fetch tags from GitHub API
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': `argos/${pkg.version}`,
    };
    const res = await fetch(TAGS_URL, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 404) {
      return result;
    }
    if (!res.ok) {
      result.error = `GitHub API ${res.status}`;
      return result;
    }

    const tags = (await res.json()) as Array<{
      name: string;
      commit: { sha: string; url: string };
    }>;

    // Filter to vX.Y.Z tags only and pick the highest semver
    const semverTags = tags
      .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t.name))
      .sort((a, b) => (isNewer(a.name, b.name) ? 1 : -1));

    const top = semverTags[0];
    if (!top) {
      // No semver tags published yet
      return result;
    }

    result.latest = top.name;
    result.latestVersion = top.name.replace(/^v/, '');
    result.releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${top.name}`;
    result.hasUpdate = isNewer(result.current, result.latestVersion);

    // Fetch commit details for changelog + date
    try {
      const commitRes = await fetch(top.commit.url, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (commitRes.ok) {
        const commit = (await commitRes.json()) as {
          commit: { message: string; author: { date: string } };
        };
        result.changelog = commit.commit.message;
        result.publishedAt = commit.commit.author.date;
      }
    } catch {
      /* non-fatal */
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  checkForUpdate().then((info) => {
    if (info.error) {
      console.error(`❌ Update check failed: ${info.error}`);
      process.exit(1);
    }
    console.log(`Current:  v${info.current}`);
    if (info.latest) {
      console.log(`Latest:   ${info.latest}  (${new Date(info.publishedAt).toLocaleDateString()})`);
    }
    if (info.hasUpdate) {
      console.log(`\n🆕 Update available — ${info.releaseUrl}`);
      console.log(`\nChangelog:\n${info.changelog.slice(0, 500)}`);
      console.log(`\nUpdate: cd ${REPO_ROOT} && git pull && npm install && npm run build && argos restart`);
    } else if (!info.latest) {
      console.log(`\nℹ️  No releases published yet`);
    } else {
      console.log(`\n✅ Up to date`);
    }
    process.exit(0);
  });
}
