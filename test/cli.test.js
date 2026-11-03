import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/session-manager.js';
import { createServer } from '../src/server.js';
import { makeFakeSpawn } from './helpers/fake-pty.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-desk.js');
const TOKEN = 'b'.repeat(64);
let home;
let server;
let port;
let closedPort;
let fake;
let workDir;

function run(args, p = port, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, AGENT_DESK_HOME: home, AGENT_DESK_PORT: String(p), ...extraEnv },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port: p } = s.address();
  await new Promise((r) => s.close(r));
  return p;
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'cli-'));
  workDir = mkdtempSync(join(tmpdir(), 'cli-work-'));
  writeFileSync(join(home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  fake = makeFakeSpawn();
  const manager = new SessionManager({ stateFile: join(home, 'sessions.json'), spawn: fake.spawn });
  const poller = { current: () => [
    { status: 'needs-you', name: 'alpha', repo: 'r', branch: 'main', goal: 'ship it', cwd: '/x' },
    { status: 'ended', name: 'beta', repo: null, branch: null, goal: '', cwd: '/y' },
  ], subscribe: () => () => {} };
  port = await freePort();
  closedPort = await freePort();
  server = createServer({ manager, poller, token: TOKEN, port });
  await once(server, 'listening');
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('launch against a closed port exits 3 with no output', async () => {
  const r = await run(['launch', 'n', workDir, 'hi'], closedPort);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('launch to a server that accepts but never answers exits 1, not 3', async () => {
  const held = [];
  const silent = net.createServer((sock) => { held.push(sock); sock.resume(); }).listen(0, '127.0.0.1');
  await once(silent, 'listening');
  try {
    const r = await run(['launch', 'n', workDir, 'hi'], silent.address().port, { AGENT_DESK_TIMEOUT_MS: '300' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /agent-desk did not answer in time; the session may have started — check agent-desk/);
    assert.ok(held.length >= 1, 'the request reached the server');
  } finally {
    for (const sock of held) sock.destroy();
    await new Promise((r) => silent.close(r));
  }
});

test('launch passes the brief file contents as the last claude argument', async () => {
  const briefFile = join(home, 'brief.txt');
  const brief = 'line one "quoted" $(nope)\nline two\n';
  writeFileSync(briefFile, brief);
  const r = await run(['launch', 'my task', workDir, '--agent', 'reviewer', '--brief-file', briefFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "launched 'my task' in agent-desk");
  const call = fake.calls.at(-1);
  assert.equal(call.args.at(-1), brief);
  assert.ok(call.args.includes('reviewer'));
});

test('launch reports an API error on stderr with exit 1', async () => {
  const r = await run(['launch', 'x', join(workDir, 'missing'), 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Not a directory/);
});

test('status prints one line per session and never the token', async () => {
  const r = await run(['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'NEEDS-YOU  alpha  r·main  ship it\nENDED  beta  /y\n');
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
});

test('unknown command exits 2', async () => {
  assert.equal((await run(['bogus'])).code, 2);
});
