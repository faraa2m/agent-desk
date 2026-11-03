import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/session-manager.js';
import { makeFakeSpawn } from './helpers/fake-pty.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  const stateFile = join(dir, 'state', 'sessions.json');
  const fake = makeFakeSpawn();
  const mk = () => new SessionManager({ stateFile, spawn: fake.spawn });
  return { dir, stateFile, fake, mk, mgr: mk() };
}

test('start passes args exactly and a hostile brief stays one argv element', () => {
  const { dir, fake, mgr } = setup();
  const brief = 'it\'s "$(rm -rf ~)"\nline2';
  const rec = mgr.start({ name: 'my session', cwd: dir, agent: 'reviewer', brief });
  const call = fake.calls[0];
  assert.equal(call.file, 'claude');
  assert.deepEqual(call.args, ['-n', 'my session', '--agent', 'reviewer', brief]);
  assert.equal(call.opts.cwd, dir);
  assert.equal(call.opts.cols, 120);
  assert.equal(call.opts.rows, 40);
  assert.equal(call.opts.env.TERM, 'xterm-256color');
  assert.equal(call.opts.env.COLORTERM, 'truecolor');
  assert.match(rec.id, /^[0-9a-f]{8}$/);
  assert.equal(rec.goal, 'it\'s "$(rm -rf ~)"');
  assert.equal(rec.pid, call.pty.pid);
  assert.equal(rec.endedAt, null);
});

test('start without agent or brief passes only the name; goal is cut to 120 chars', () => {
  const { dir, fake, mgr } = setup();
  mgr.start({ name: 'a', cwd: dir });
  assert.deepEqual(fake.calls[0].args, ['-n', 'a']);
  const rec = mgr.start({ name: 'b', cwd: dir, brief: `\n\n${'x'.repeat(200)}\nrest` });
  assert.equal(rec.goal, 'x'.repeat(120));
});

test('start validates name, directory and uniqueness among live sessions', () => {
  const { dir, fake, mgr } = setup();
  assert.throws(() => mgr.start({ name: '', cwd: dir }), { code: 'BAD_NAME' });
  assert.throws(() => mgr.start({ name: 'x', cwd: join(dir, 'missing') }), { code: 'NO_DIR' });
  mgr.start({ name: 'dup', cwd: dir });
  assert.throws(() => mgr.start({ name: 'dup', cwd: dir }), { code: 'NAME_TAKEN' });
  fake.calls[0].pty.exit(0);
  assert.doesNotThrow(() => mgr.start({ name: 'dup', cwd: dir }));
});

test('~/ paths expand', () => {
  const { fake, mgr } = setup();
  mgr.start({ name: 'home', cwd: '~' });
  assert.equal(fake.calls[0].opts.cwd, homedir());
});

test('output reaches every attachment and the scrollback; late attach replays', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 's', cwd: dir });
  const a = [];
  const b = [];
  const attA = mgr.attach(id, (d) => a.push(d));
  mgr.attach(id, (d) => b.push(d));
  fake.calls[0].pty.emit('hello ');
  assert.deepEqual(a, ['hello ']);
  assert.deepEqual(b, ['hello ']);
  const late = mgr.attach(id, () => {});
  assert.equal(late.scrollback, 'hello ');
  attA.detach();
  fake.calls[0].pty.emit('more');
  assert.deepEqual(a, ['hello ']);
  assert.deepEqual(b, ['hello ', 'more']);
});

test('write forwards to the pty and resize applies', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 's', cwd: dir });
  mgr.write(id, 'ls\r');
  mgr.resize(id, 100, 30);
  assert.deepEqual(fake.calls[0].pty.written, ['ls\r']);
  assert.deepEqual(fake.calls[0].pty.resized, [100, 30]);
  assert.equal(mgr.live(id).screenWaiting, false);
  fake.calls[0].pty.emit('Do you want to proceed?\n');
  assert.equal(mgr.live(id).screenWaiting, true);
  mgr.write(id, 'y');
  assert.equal(mgr.live(id).screenWaiting, false);
});

test('exit records endedAt and exitCode, emits change; dismiss removes ended only', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 's', cwd: dir });
  let changes = 0;
  mgr.on('change', () => { changes += 1; });
  assert.throws(() => mgr.dismiss(id));
  fake.calls[0].pty.exit(3);
  const rec = mgr.get(id);
  assert.equal(rec.exitCode, 3);
  assert.equal(typeof rec.endedAt, 'number');
  assert.equal(rec.pid, null);
  assert.equal(mgr.live(id), null);
  assert.ok(changes >= 1);
  mgr.dismiss(id);
  assert.equal(mgr.get(id), null);
  assert.deepEqual(mgr.list(), []);
});

test('stop sends SIGTERM to live sessions and is a no-op on ended ones', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 's', cwd: dir });
  mgr.stop(id);
  assert.equal(fake.calls[0].pty.killed, 'SIGTERM');
  assert.equal(mgr.get(id).endedAt, null);
  fake.calls[0].pty.exit(0);
  fake.calls[0].pty.killed = null;
  mgr.stop(id);
  assert.equal(fake.calls[0].pty.killed, null);
});

test('list returns plain copies; setGoal and setClaudeSessionId update and persist', () => {
  const { dir, stateFile, mgr } = setup();
  const { id } = mgr.start({ name: 's', cwd: dir });
  mgr.list()[0].goal = 'tampered';
  assert.equal(mgr.get(id).goal, '');
  mgr.setGoal(id, 'ship it');
  mgr.setClaudeSessionId(id, 'sid-1');
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved[0].goal, 'ship it');
  assert.equal(saved[0].claudeSessionId, 'sid-1');
  assert.deepEqual(Object.keys(saved[0]).sort(), [
    'agent', 'claudeSessionId', 'createdAt', 'cwd', 'endedAt', 'exitCode', 'goal', 'id', 'name', 'pid',
  ]);
});

test('a new manager sees old live records as ended; resume spawns --resume', () => {
  const { dir, fake, mk, mgr } = setup();
  const { id } = mgr.start({ name: 'old', cwd: dir });
  mgr.setClaudeSessionId(id, 'sid-9');

  const mgr2 = mk();
  const rec = mgr2.get(id);
  assert.equal(typeof rec.endedAt, 'number');
  assert.equal(mgr2.live(id), null);

  const resumed = mgr2.resume(id);
  const call = fake.calls[1];
  assert.deepEqual(call.args, ['--resume', 'sid-9', '-n', 'old']);
  assert.equal(call.opts.cwd, dir);
  assert.equal(resumed.endedAt, null);
  assert.equal(resumed.pid, call.pty.pid);
  assert.ok(mgr2.live(id));
});

test('resume refuses live records and records without a claude session id', () => {
  const { dir, fake, mk, mgr } = setup();
  const { id } = mgr.start({ name: 'x', cwd: dir });
  assert.throws(() => mgr.resume(id));
  fake.calls[0].pty.exit(0);
  assert.throws(() => mgr.resume(id));
});

test('attachments made while ended keep receiving output after resume', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 'x', cwd: dir });
  mgr.setClaudeSessionId(id, 'sid');
  fake.calls[0].pty.emit('first ');
  fake.calls[0].pty.exit(0);
  const got = [];
  const att = mgr.attach(id, (d) => got.push(d));
  assert.equal(att.scrollback, 'first ');
  mgr.resume(id);
  fake.calls[1].pty.emit('second');
  assert.deepEqual(got, ['second']);
  att.detach();
});

test('a stale exit from a previous pty does not end the resumed session', () => {
  const { dir, fake, mgr } = setup();
  const { id } = mgr.start({ name: 'x', cwd: dir });
  mgr.setClaudeSessionId(id, 'sid');
  fake.calls[0].pty.exit(0);
  mgr.resume(id);
  fake.calls[0].pty.exit(1);
  assert.equal(mgr.get(id).endedAt, null);
});

test('unknown ids throw or return null as documented', () => {
  const { mgr } = setup();
  assert.equal(mgr.get('nope'), null);
  assert.equal(mgr.live('nope'), null);
  assert.throws(() => mgr.attach('nope', () => {}));
  assert.throws(() => mgr.stop('nope'));
});

test('corrupt state file is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-'));
  mkdirSync(join(dir, 's'));
  const stateFile = join(dir, 's', 'sessions.json');
  const fake = makeFakeSpawn();
  const mgr = new SessionManager({ stateFile, spawn: fake.spawn });
  assert.deepEqual(mgr.list(), []);
});
