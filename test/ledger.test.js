import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLedger, findEntry } from '../src/ledger.js';

test('readLedger returns [] for a missing file', () => {
  assert.deepEqual(readLedger(join(tmpdir(), 'agent-desk-no-such-ledger.jsonl')), []);
});

test('readLedger skips bad lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'ledger.jsonl');
  writeFileSync(file, '{"id":1}\nnot json\n\n{"id":2}\n');
  assert.deepEqual(readLedger(file), [{ id: 1 }, { id: 2 }]);
});

test('readLedger skips lines that are not objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'ledger.jsonl');
  writeFileSync(file, '42\nnull\n{"id":3}\n');
  assert.deepEqual(readLedger(file), [{ id: 3 }]);
});

test('findEntry picks the last of two matches', () => {
  const entries = [
    { id: 1, session_id: 's', text_hash: 'h' },
    { id: 2, session_id: 's', text_hash: 'other' },
    { id: 3, session_id: 's', text_hash: 'h' },
  ];
  assert.equal(findEntry(entries, 's', 'h').id, 3);
});

test('findEntry returns null for a null hash or no match', () => {
  const entries = [{ id: 1, session_id: 's', text_hash: 'h' }];
  assert.equal(findEntry(entries, 's', null), null);
  assert.equal(findEntry(entries, 'x', 'h'), null);
});
