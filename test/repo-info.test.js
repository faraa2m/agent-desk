import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoInfo, colorFor } from '../src/repo-info.js';

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'agent-desk-')));

test('colorFor is stable and returns #rrggbb', () => {
  assert.equal(colorFor('my-project'), colorFor('my-project'));
  assert.match(colorFor('my-project'), /^#[0-9a-f]{6}$/i);
});

test('colorFor palette has 8 distinct colors', () => {
  const colors = new Set();
  for (let i = 0; i < 2000; i++) colors.add(colorFor(`repo-${i}`));
  assert.equal(colors.size, 8);
});

test('repoInfo reads repo and branch from a git checkout', () => {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  assert.deepEqual(repoInfo(dir), { repo: basename(dir), branch: 'feat/x' });
});

test('repoInfo on a plain directory has an empty branch', () => {
  const dir = tempDir();
  assert.deepEqual(repoInfo(dir), { repo: basename(dir), branch: '' });
});

test('repoInfo does not throw for a missing directory', () => {
  const dir = join(tempDir(), 'missing');
  assert.deepEqual(repoInfo(dir), { repo: 'missing', branch: '' });
});
