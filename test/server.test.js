import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, readFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import WebSocket from 'ws';
import { SessionManager } from '../src/session-manager.js';
import { createServer } from '../src/server.js';
import { makeFakeSpawn } from './helpers/fake-pty.js';

const TOKEN = 'a'.repeat(64);
let server;
let port;
let manager;
let fake;
let dir;
let snapshotSubs;
let snapshot;
let snapshotFails = false;
const found = {};
const sockets = [];
const logLines = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'srv-'));
  fake = makeFakeSpawn();
  manager = new SessionManager({ stateFile: join(dir, 'state', 'sessions.json'), spawn: fake.spawn });
  snapshotSubs = new Set();
  snapshot = [{ id: 'view-1', name: 'v' }];
  const poller = {
    current: () => { if (snapshotFails) throw new Error('boom'); return snapshot; },
    subscribe: (cb) => { snapshotSubs.add(cb); return () => snapshotSubs.delete(cb); },
  };
  server = createServer({ manager, poller, token: TOKEN, port: 0, uploadsDir: relative(process.cwd(), join(dir, 'uploads')), find: async (name) => found[name] ?? [], log: (line) => logLines.push(line) });
  await once(server, 'listening');
  port = server.address().port;
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  await new Promise((r) => server.close(r));
});

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (Buffer.isBuffer(body)) req.end(body);
    else if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

function connect(path, headers = { cookie: `ad_key=${TOKEN}` }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  sockets.push(ws);
  return ws;
}

function nextMessage(ws, pred = () => true) {
  return new Promise((resolve) => {
    const onMsg = (data) => {
      const text = data.toString();
      if (pred(text)) { ws.off('message', onMsg); resolve(text); }
    };
    ws.on('message', onMsg);
  });
}

function rejection(ws) {
  return new Promise((resolve) => {
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('error', () => resolve('error'));
  });
}

test('health needs no token', async () => {
  const res = await request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test('sessions without a token or with a wrong one is 401', async () => {
  assert.equal((await request('/api/sessions')).status, 401);
  assert.equal((await request('/api/sessions', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401);
  assert.equal((await request('/api/sessions', { headers: { authorization: 'Bearer short' } })).status, 401);
  assert.equal((await request('/api/sessions', { headers: { cookie: 'ad_key=nope' } })).status, 401);
  assert.equal((await request('/')).status, 401);
});

test('?key= authenticates and sets the cookie; the cookie and bearer token work', async () => {
  const res = await request(`/api/sessions?key=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, snapshot);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^ad_key=${TOKEN}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.equal((await request('/api/sessions', { headers: { cookie: `other=1; ad_key=${TOKEN}` } })).status, 200);
  assert.equal((await request('/api/sessions', { headers: auth })).status, 200);
});

test('GET /?key= sets a long-lived cookie and redirects to / without the key', async () => {
  const res = await request(`/?key=${TOKEN}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  assert.equal(res.headers['cache-control'], 'no-store');
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^ad_key=${TOKEN};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=34560000/);
  assert.equal(res.text, '');
  const page = await request('/', { headers: { cookie: `ad_key=${TOKEN}` } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
});

test('GET / without a token is a 401 HTML page with no token or session data; the API stays JSON', async () => {
  const res = await request('/', { headers: { cookie: 'ad_key=nope' } });
  assert.equal(res.status, 401);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.text, /Run <code>agent-desk<\/code> in a terminal/);
  assert.ok(!res.text.includes(TOKEN));
  assert.ok(!res.text.includes('view-1'));
  assert.equal(res.headers['set-cookie'], undefined);
  const api = await request('/api/sessions');
  assert.equal(api.status, 401);
  assert.deepEqual(api.json, { error: 'Unauthorized' });
});

test('a foreign Host or Origin is 403 even with a valid token', async () => {
  const res = await request('/api/sessions', { headers: { ...auth, host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
  assert.equal((await request('/api/health', { headers: { host: `localhost:${port}` } })).status, 200);
  assert.equal((await request('/api/health', { headers: { host: `127.0.0.1:${port + 1}` } })).status, 403);
  const cross = await request('/api/sessions', { method: 'POST', headers: { ...auth, origin: 'http://evil.example' }, body: { name: 'x', cwd: dir } });
  assert.equal(cross.status, 403);
  assert.equal(fake.calls.length, 0);
});

test('static paths cannot escape public/ and vendor serves only known files', async () => {
  for (const p of ['/static/../src/token.js', '/static/..%2fsrc%2ftoken.js', '/static/%2e%2e/package.json', '/vendor/../package.json', '/vendor/xterm.mjs', '/static/%00']) {
    assert.equal((await request(p, { headers: auth })).status, 404, p);
  }
  const js = await request('/vendor/xterm.js', { headers: auth });
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  const css = await request('/vendor/xterm.css', { headers: auth });
  assert.match(css.headers['content-type'], /text\/css/);
  assert.equal((await request('/vendor/addon-fit.js', { headers: auth })).status, 200);
  assert.equal((await request('/vendor/xterm.js')).status, 401);
});

test('API errors map to status codes; bad JSON is 400', async () => {
  let res = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: '', cwd: dir } });
  assert.equal(res.status, 400);
  assert.ok(res.json.error);
  res = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'x', cwd: join(dir, 'missing') } });
  assert.equal(res.status, 400);
  res = await request('/api/sessions', { method: 'POST', headers: auth, body: '{not json' });
  assert.equal(res.status, 400);
  res = await request('/api/sessions/nope/stop', { method: 'POST', headers: auth });
  assert.equal(res.status, 404);
  res = await request('/api/sessions/nope', { method: 'PATCH', headers: auth, body: { goal: 'g' } });
  assert.equal(res.status, 404);
  res = await request('/api/nothing', { headers: auth });
  assert.equal(res.status, 404);
});

test('a WebSocket from a foreign Origin, without a token, or with a foreign Host is rejected', async () => {
  const evil = connect('/ws/events', { cookie: `ad_key=${TOKEN}`, origin: 'http://evil.example' });
  assert.equal(await rejection(evil), 403);
  const anon = connect('/ws/events', {});
  assert.equal(await rejection(anon), 401);
  const host = connect('/ws/events', { cookie: `ad_key=${TOKEN}`, host: `evil.example:${port}` });
  assert.equal(await rejection(host), 403);
});

test('/ws/events sends the snapshot on connect and on every update', async () => {
  const ws = connect('/ws/events', { cookie: `ad_key=${TOKEN}`, origin: `http://localhost:${port}` });
  const first = JSON.parse(await nextMessage(ws));
  assert.deepEqual(first, { type: 'snapshot', sessions: snapshot });
  const next = nextMessage(ws);
  for (const cb of snapshotSubs) cb([{ id: 'view-2' }]);
  assert.deepEqual(JSON.parse(await next), { type: 'snapshot', sessions: [{ id: 'view-2' }] });
  ws.close();
});

test('/ws/term always sends the scrollback first, even when it is empty', async () => {
  const res = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'fresh', cwd: dir } });
  const ws = connect(`/ws/term/${res.json.id}`);
  assert.equal(await nextMessage(ws), '');
  const live = nextMessage(ws);
  fake.calls.at(-1).pty.emit('live');
  assert.equal(await live, 'live');
  ws.close();
  fake.calls.at(-1).pty.exit(0);
});

test('/ws/term for an unknown id closes with 4404', async () => {
  const ws = connect('/ws/term/nope');
  const [code] = await once(ws, 'close');
  assert.equal(code, 4404);
});

test('two terminal clients share a session; input and resize reach the pty; one closing leaves the other', async () => {
  const res = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'shared', cwd: dir } });
  assert.equal(res.status, 201);
  const { id } = res.json;
  const pty = fake.calls.at(-1).pty;
  assert.equal(pty.pid, res.json.pid);
  pty.emit('before ');

  const dup = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'shared', cwd: dir } });
  assert.equal(dup.status, 409);

  const a = connect(`/ws/term/${id}`);
  const b = connect(`/ws/term/${id}`);
  const [sa, sb] = await Promise.all([nextMessage(a), nextMessage(b)]);
  assert.equal(sa, 'before ');
  assert.equal(sb, 'before ');

  const ga = nextMessage(a);
  const gb = nextMessage(b);
  pty.emit('hello');
  assert.deepEqual(await Promise.all([ga, gb]), ['hello', 'hello']);

  a.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
  b.send('not json');
  b.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
  b.send(JSON.stringify({ type: 'input', data: 'y' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pty.written, ['ls\r', 'y']);
  assert.deepEqual(pty.resized, [90, 20]);

  a.close();
  await once(a, 'close');
  const gb2 = nextMessage(b);
  pty.emit('still here');
  assert.equal(await gb2, 'still here');

  const patched = await request(`/api/sessions/${id}`, { method: 'PATCH', headers: auth, body: { goal: 'new goal' } });
  assert.equal(patched.status, 200);
  assert.equal(manager.get(id).goal, 'new goal');

  assert.equal((await request(`/api/sessions/${id}/dismiss`, { method: 'POST', headers: auth })).status, 409);
  assert.equal((await request(`/api/sessions/${id}/stop`, { method: 'POST', headers: auth })).status, 200);
  assert.equal(pty.killed, 'SIGTERM');
  pty.exit(0);
  assert.equal((await request(`/api/sessions/${id}/resume`, { method: 'POST', headers: auth })).status, 409);
  assert.equal((await request(`/api/sessions/${id}/dismiss`, { method: 'POST', headers: auth })).status, 200);
  assert.equal(manager.get(id), null);
  b.close();
});

test('a 500 error log carries the path but never the token from the query string', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => { logged.push(a.join(' ')); });
  snapshotFails = true;
  try {
    const res = await request(`/api/sessions?key=${TOKEN}`);
    assert.equal(res.status, 500);
  } finally {
    snapshotFails = false;
  }
  const text = logged.join('\n');
  assert.match(text, /GET \/api\/sessions/);
  assert.ok(!text.includes(TOKEN));
});

test('mutating API calls are logged with the session name and result, never the token', async () => {
  logLines.length = 0;
  const res = await request(`/api/sessions?key=${TOKEN}`, {
    method: 'POST', headers: auth, body: { name: 'logged-one', cwd: dir, brief: 'secret brief text' },
  });
  assert.equal(res.status, 201);
  const { id } = res.json;
  await request(`/api/sessions/${id}`, { method: 'PATCH', headers: auth, body: { goal: 'g' } });
  await request(`/api/sessions/${id}/stop`, { method: 'POST', headers: auth });
  fake.calls.at(-1).pty.exit(0);
  await request(`/api/sessions/${id}/dismiss`, { method: 'POST', headers: auth });
  await request('/api/sessions/nope/resume', { method: 'POST', headers: auth });
  await request('/api/sessions', { method: 'POST', body: { name: 'anon', cwd: dir } });
  await request('/api/sessions', { headers: auth });
  const text = logLines.join('\n');
  assert.equal(logLines.length, 6, text);
  assert.match(logLines[0], new RegExp(`^POST /api/sessions id=${id} name="logged-one" -> 201$`));
  assert.match(logLines[1], new RegExp(`^PATCH /api/sessions/${id} id=${id} name="logged-one" -> 200$`));
  assert.match(logLines[2], new RegExp(`^POST /api/sessions/${id}/stop id=${id} name="logged-one" -> 200$`));
  assert.match(logLines[3], new RegExp(`^POST /api/sessions/${id}/dismiss id=${id} name="logged-one" -> 200$`));
  assert.match(logLines[4], /^POST \/api\/sessions\/nope\/resume id=nope -> 404$/);
  assert.match(logLines[5], /^POST \/api\/sessions -> 401$/);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('key='));
  assert.ok(!text.includes('secret brief'));
});

test('POST /api/upload saves a file for a live session under a sanitized name and returns its private path', async () => {
  const created = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'upload-one', cwd: dir } });
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const res = await request(`/api/upload?session=${created.json.id}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('../../my report (1).pdf') },
    body: data,
  });
  assert.equal(res.status, 201);
  assert.equal(isAbsolute(res.json.path), true);
  assert.match(res.json.path, /uploads\/\d+-[0-9a-f]{8}-my_report__1_.pdf$/);
  assert.deepEqual(readFileSync(res.json.path), data);
  assert.equal(statSync(res.json.path).mode & 0o777, 0o600);
});

test('POST /api/upload falls back to a generic name when none or a hostile one is given', async () => {
  const created = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'upload-name', cwd: dir } });
  const up = (name) => request(`/api/upload?session=${created.json.id}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/octet-stream', ...(name === undefined ? {} : { 'x-file-name': name }) },
    body: Buffer.from('x'),
  });
  assert.match((await up()).json.path, /-file$/);
  assert.match((await up('%E0%A4%A')).json.path, /-file$/);
  assert.match((await up('..')).json.path, /-file$/);
  assert.match((await up('.env')).json.path, /-env$/);
});

test('POST /api/upload needs the token, a known session and a body', async () => {
  const created = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'upload-two', cwd: dir } });
  const data = Buffer.from([1, 2, 3]);
  const post = (query, headers, body = data) => request(`/api/upload${query}`, { method: 'POST', headers, body });
  assert.equal((await post(`?session=${created.json.id}`, {})).status, 401);
  assert.equal((await post('?session=nope', auth)).status, 404);
  assert.equal((await post('', auth)).status, 404);
  assert.equal((await post(`?session=${created.json.id}`, auth, Buffer.alloc(0))).status, 400);
});

test('POST /api/upload refuses a file over the size limit', async () => {
  const created = await request('/api/sessions', { method: 'POST', headers: auth, body: { name: 'upload-big', cwd: dir } });
  const res = await request(`/api/upload?session=${created.json.id}`, {
    method: 'POST',
    headers: auth,
    body: Buffer.alloc(50 * 1024 * 1024 + 1),
  }).catch((err) => ({ status: err.code }));
  assert.ok(res.status === 413 || res.status === 'ECONNRESET' || res.status === 'EPIPE', String(res.status));
});

test('POST /api/locate returns the original path only when size and modified time match', async () => {
  const real = join(dir, 'notes.txt');
  writeFileSync(real, 'hello');
  const when = new Date('2026-01-02T03:04:05Z');
  utimesSync(real, when, when);
  const other = join(dir, 'other', 'notes.txt');
  found['notes.txt'] = [other, real, join(dir, 'uploads', 'notes.txt')];
  const ask = (body, headers = auth) => request('/api/locate', { method: 'POST', headers, body });
  const good = { name: 'notes.txt', size: 5, lastModified: when.getTime() };
  assert.deepEqual((await ask(good)).json, { path: real });
  assert.deepEqual((await ask({ ...good, size: 6 })).json, { path: null });
  assert.deepEqual((await ask({ ...good, lastModified: when.getTime() + 60000 })).json, { path: null });
  assert.deepEqual((await ask({ ...good, name: 'missing.txt' })).json, { path: null });
  assert.equal((await ask({ ...good, name: '../notes.txt' })).status, 400);
  assert.equal((await ask({ name: 'notes.txt' })).status, 400);
  assert.equal((await ask(good, {})).status, 401);
});

test('POST /api/locate falls back to upload when matching originals are ambiguous', async () => {
  const firstDir = join(dir, 'first');
  const secondDir = join(dir, 'second');
  mkdirSync(firstDir);
  mkdirSync(secondDir);
  const first = join(firstDir, 'ambiguous.txt');
  const second = join(secondDir, 'ambiguous.txt');
  writeFileSync(first, 'hello');
  writeFileSync(second, 'WRONG');
  const when = new Date('2026-01-02T03:04:05Z');
  utimesSync(first, when, when);
  utimesSync(second, when, new Date(when.getTime() + 1000));
  found['ambiguous.txt'] = [first, second];
  const res = await request('/api/locate', {
    method: 'POST', headers: auth,
    body: { name: 'ambiguous.txt', size: 5, lastModified: when.getTime() },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { path: null });
});
