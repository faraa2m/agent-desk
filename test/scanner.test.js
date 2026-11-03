import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScanOutput, runScanner } from '../src/scanner.js';

test('parseScanOutput keeps good lines and skips garbage', () => {
  const out = '{"name":"a","waiting":true}\nnot json\n\n{"name":"b","waiting":false}\n';
  const entries = parseScanOutput(out);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'a');
  assert.equal(entries[1].name, 'b');
});

test('runScanner resolves [] for a missing script', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await runScanner('/nonexistent.py'), []);
  } finally {
    console.error = origError;
  }
});

test('runScanner parses output of a fixture script', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scanner-'));
  const script = join(dir, 'scan.py');
  writeFileSync(script, 'print(\'{"name":"a","waiting":true}\')\n');
  const entries = await runScanner(script);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'a');
  assert.equal(entries[0].waiting, true);
});
