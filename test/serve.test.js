import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-desk.js');

function startServe(home, port) {
  return spawn(process.execPath, [CLI, 'serve'], {
    env: { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_PORT: String(port) },
    stdio: 'ignore',
  });
}

async function waitForLog(home, text) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(join(home, 'server.log'), 'utf8').includes(text)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`log never contained ${text}`);
}

test('serve exits non-zero when the port is already taken', async () => {
  const holder = net.createServer().listen(0, '127.0.0.1');
  await once(holder, 'listening');
  const home = mkdtempSync(join(tmpdir(), 'serve-'));
  const child = startServe(home, holder.address().port);
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  holder.close();
  assert.equal(signal, null);
  assert.notEqual(code, 0);
});

test('serve exits 0 on SIGTERM', async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  const home = mkdtempSync(join(tmpdir(), 'serve-'));
  const child = startServe(home, port);
  try {
    await waitForLog(home, 'listening on');
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    child.kill('SIGKILL');
  }
});
