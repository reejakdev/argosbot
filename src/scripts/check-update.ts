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
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateInfo {
  current: string;       // local version e.g. "0.1.0"
  latest: string;        // latest release tag e.g. "v0.2.0"
  latestVersion: string; // tag without "v" prefix e.g. "0.2.0"
  releaseUrl: string;    // GitHub release page URL
  changelog: string;     // release notes (markdown)
  publishedAt: string;   // ISO date
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

    // Fetch latest release from GitHub API
    const res = await fetch(RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `argos/${pkg.version}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 404) {
      // No releases yet — not an error, just nothing to update to
      return result;
    }
    if (!res.ok) {
      result.error = `GitHub API ${res.status}`;
      return result;
    }

    const data = (await res.json()) as {
      tag_name: string;
      html_url: string;
      body?: string;
      published_at: string;
      draft: boolean;
      prerelease: boolean;
    };

    if (data.draft || data.prerelease) {
      // Skip drafts and prereleases
      return result;
    }

    result.latest = data.tag_name;
    result.latestVersion = data.tag_name.replace(/^v/, '');
    result.releaseUrl = data.html_url;
    result.changelog = data.body ?? '';
    result.publishedAt = data.published_at;
    result.hasUpdate = isNewer(result.current, result.latestVersion);
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
