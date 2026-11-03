import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionMeta } from '../src/claude-meta.js';

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), 'claude-meta-'));
}

test('reads session metadata fields', () => {
  const dir = fixtureDir();
  writeFileSync(
    join(dir, '123.json'),
    JSON.stringify({ pid: 123, sessionId: 'abc', cwd: '/x', status: 'busy', name: 'n', extra: 1 }),
  );
  assert.deepEqual(readSessionMeta(123, dir), { sessionId: 'abc', status: 'busy', name: 'n', cwd: '/x' });
});

test('missing pid returns null', () => {
  assert.equal(readSessionMeta(999, fixtureDir()), null);
});

test('bad JSON returns null', () => {
  const dir = fixtureDir();
  writeFileSync(join(dir, '5.json'), '{not json');
  assert.equal(readSessionMeta(5, dir), null);
});
