import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgents } from '../src/agents.js';

test('listAgents reads name and description from frontmatter, sorted, skipping non-markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  writeFileSync(join(dir, 'team-lead.md'), '---\nname: team-lead\ndescription: Triages sessions.\n---\nbody');
  writeFileSync(join(dir, 'merge-lead.md'), '---\nname: "merge-lead"\ndescription: Merges and deploys.\n---\n');
  writeFileSync(join(dir, 'bare.md'), 'no frontmatter');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  mkdirSync(join(dir, 'sub'));
  assert.deepEqual(listAgents(dir), [
    { name: 'bare', description: '' },
    { name: 'merge-lead', description: 'Merges and deploys.' },
    { name: 'team-lead', description: 'Triages sessions.' },
  ]);
});

test('listAgents returns an empty list for a missing directory', () => {
  assert.deepEqual(listAgents(join(tmpdir(), 'no-such-agents-dir-xyz')), []);
});
