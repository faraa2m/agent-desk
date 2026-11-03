import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPtySpawn } from '../src/pty.js';

test('loadPtySpawn returns a spawn that runs a real process in a pty', async () => {
  const spawn = await loadPtySpawn();
  const pty = spawn('/bin/echo', ['hi'], { name: 'xterm-256color', cols: 80, rows: 24 });
  let out = '';
  pty.onData((d) => { out += d; });
  const exitCode = await new Promise((resolve) => {
    pty.onExit(({ exitCode: code }) => resolve(code));
  });
  assert.match(out, /hi/);
  assert.equal(exitCode, 0);
});
