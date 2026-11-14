import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepUploads } from '../src/serve.js';

test('sweepUploads removes only files older than the limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uploads-'));
  const old = join(dir, 'old.png');
  const fresh = join(dir, 'fresh.png');
  writeFileSync(old, 'o');
  writeFileSync(fresh, 'f');
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  assert.equal(sweepUploads(dir, 7 * 24 * 60 * 60 * 1000), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test('sweepUploads tolerates a missing directory', () => {
  assert.equal(sweepUploads(join(tmpdir(), 'agent-desk-no-such-uploads')), 0);
});
