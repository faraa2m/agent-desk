import { execFile, execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const CACHE_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const PALETTE = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
  '#61afef', '#c678dd', '#d19a66', '#7f8fa6',
];
const cache = new Map();

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

function gitAsync(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

function lookup(cwd) {
  let repo = basename(cwd);
  let branch = '';
  try {
    repo = basename(git(cwd, ['rev-parse', '--show-toplevel'])) || repo;
  } catch {}
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {}
  return { repo, branch };
}

async function refresh(cwd, hit) {
  hit.refreshing = true;
  const [top, branch] = await Promise.all([
    gitAsync(cwd, ['rev-parse', '--show-toplevel']),
    gitAsync(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  hit.value = { repo: (top && basename(top)) || basename(cwd), branch: branch ?? '' };
  hit.at = Date.now();
  hit.refreshing = false;
}

/**
 * Repo name and current branch for a directory; never throws. The first call
 * for a cwd looks it up synchronously; after that the cached value is returned
 * at once and refreshed in the background when older than 10 s, so polling
 * never blocks the event loop on git.
 */
export function repoInfo(cwd) {
  const hit = cache.get(cwd);
  if (!hit) {
    const value = lookup(cwd);
    cache.set(cwd, { at: Date.now(), value, refreshing: false });
    return { ...value };
  }
  if (!hit.refreshing && Date.now() - hit.at >= CACHE_MS) refresh(cwd, hit);
  return { ...hit.value };
}

/** Stable palette color for a repo name. */
export function colorFor(repo) {
  let h = 0;
  for (const ch of repo) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
