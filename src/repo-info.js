import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const CACHE_MS = 10_000;
const PALETTE = [
  '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
  '#61afef', '#c678dd', '#d19a66', '#7f8fa6',
];
const cache = new Map();

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
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

/** Repo name and current branch for a directory; never throws. Cached for 10 s per cwd. */
export function repoInfo(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value };
  const value = lookup(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return { ...value };
}

/** Stable palette color for a repo name. */
export function colorFor(repo) {
  let h = 0;
  for (const ch of repo) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
