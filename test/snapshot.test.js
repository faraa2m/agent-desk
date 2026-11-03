import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, startPoller } from '../src/snapshot.js';
import { loadOrCreateToken } from '../src/token.js';
import { WaitTracker } from '../src/status.js';
import { SessionManager } from '../src/session-manager.js';
import { makeFakeSpawn } from './helpers/fake-pty.js';
import { GRACE_MS } from '../src/config.js';

const NOW = 1_000_000;

function record(over = {}) {
  return {
    id: 'r1', name: 'worker', cwd: '/w', agent: null, goal: 'do it',
    claudeSessionId: null, pid: 501, createdAt: 0, endedAt: null, exitCode: null,
    ...over,
  };
}

function input(over = {}) {
  return {
    records: [record()],
    liveFor: (id) => (id === 'r1' ? { pid: 501, screenWaiting: false } : null),
    metaFor: (pid) => (pid === 501 ? { sessionId: 'sid-1', status: 'idle', name: 'worker', cwd: '/w' } : null),
    scan: [{ name: 'worker', session_id: 'sid-1', status: 'waiting', waiting: true, text_hash: 'h1', question: 'Proceed with the deploy?\nmore detail' }],
    ledger: [],
    repoInfoFor: (cwd) => ({ repo: `repo-of${cwd}`, branch: 'main' }),
    waitTracker: new WaitTracker(),
    now: NOW,
    onSessionId: () => {},
    ...over,
  };
}

test('a waiting session with no team-lead running needs you; repo info and color come from the stub', () => {
  const [view] = buildSnapshot(input());
  assert.equal(view.status, 'needs-you');
  assert.equal(view.question, 'Proceed with the deploy?');
  assert.equal(view.repo, 'repo-of/w');
  assert.equal(view.branch, 'main');
  assert.match(view.color, /^#[0-9a-f]{6}$/);
  assert.equal(view.waitingSince, NOW);
  assert.equal(view.pinned, false);
  assert.equal(view.resumable, false);
  assert.deepEqual(Object.keys(view).sort(), [
    'branch', 'color', 'cwd', 'endedAt', 'goal', 'id', 'name', 'pinned',
    'question', 'repo', 'resumable', 'status', 'waitingSince',
  ]);
});

test('a fresh wait is team-lead handling when a team-lead scan entry exists, then needs you after the grace period', () => {
  const tracker = new WaitTracker();
  const scan = [
    ...input().scan,
    { name: 'team-lead', session_id: 'sid-tl', status: 'busy', waiting: false },
  ];
  const [view] = buildSnapshot(input({ scan, waitTracker: tracker }));
  assert.equal(view.status, 'team-lead');
  const [later] = buildSnapshot(input({ scan, waitTracker: tracker, now: NOW + GRACE_MS + 1 }));
  assert.equal(later.status, 'needs-you');
  assert.equal(later.waitingSince, NOW);
});

test('a live team-lead record counts as running and is pinned first', () => {
  const records = [record(), record({ id: 'tl', name: 'team-lead', pid: 777 })];
  const views = buildSnapshot(input({
    records,
    liveFor: (id) => ({ pid: id === 'tl' ? 777 : 501, screenWaiting: false }),
  }));
  assert.deepEqual(views.map((v) => v.id), ['tl', 'r1']);
  assert.equal(views[0].pinned, true);
  assert.equal(views[1].status, 'team-lead');
});

test('screen-only waiting uses the generic question; not waiting has no question', () => {
  const [view] = buildSnapshot(input({ scan: [], liveFor: () => ({ pid: 501, screenWaiting: true }) }));
  assert.equal(view.status, 'needs-you');
  assert.equal(view.question, 'Waiting for your input');
  const [idle] = buildSnapshot(input({ scan: [] }));
  assert.equal(idle.status, 'done');
  assert.equal(idle.question, null);
  assert.equal(idle.waitingSince, null);
  const [busy] = buildSnapshot(input({ scan: [], metaFor: () => ({ sessionId: 'sid-1', status: 'busy' }) }));
  assert.equal(busy.status, 'working');
});

test('the session file reporting waiting needs you without a scan entry or screen signal', () => {
  const waitingMeta = (pid) => (pid === 501 ? { sessionId: 'sid-1', status: 'waiting', name: 'worker', cwd: '/w' } : null);
  const [view] = buildSnapshot(input({ scan: [], metaFor: waitingMeta }));
  assert.equal(view.status, 'needs-you');
  assert.equal(view.question, 'Waiting for your input');
  assert.equal(view.waitingSince, NOW);
});

test('the session file reporting idle with no waiting signal is done', () => {
  const [view] = buildSnapshot(input({ scan: [] }));
  assert.equal(view.status, 'done');
});

test('long questions are cut to 160 characters', () => {
  const scan = [{ session_id: 'sid-1', waiting: true, text_hash: 'h', question: 'q'.repeat(300) }];
  const [view] = buildSnapshot(input({ scan }));
  assert.equal(view.question, 'q'.repeat(160));
});

test('a handled ledger entry keeps the wait with team-lead past the grace period', () => {
  const scan = [...input().scan, { name: 'team-lead', session_id: 'tl', waiting: false }];
  const ledger = [{ session_id: 'sid-1', text_hash: 'h1', sent: true, category: 'answer', confidence: 'high' }];
  const tracker = new WaitTracker();
  tracker.update('r1', true, 'h1', 0);
  const [view] = buildSnapshot(input({ scan, ledger, waitTracker: tracker }));
  assert.equal(view.status, 'team-lead');
});

test('ended records are ended and resumable only with a claude session id', () => {
  const records = [
    record({ id: 'a', name: 'a', pid: null, endedAt: 5, claudeSessionId: 'sid-a' }),
    record({ id: 'b', name: 'b', pid: null, endedAt: 6 }),
  ];
  const views = buildSnapshot(input({ records, liveFor: () => null, metaFor: () => null }));
  assert.deepEqual(views.map((v) => [v.id, v.status, v.resumable, v.endedAt]), [
    ['a', 'ended', true, 5],
    ['b', 'ended', false, 6],
  ]);
});

test('onSessionId fires when meta reports a session id the record lacks', () => {
  const seen = [];
  buildSnapshot(input({ onSessionId: (id, sid) => seen.push([id, sid]) }));
  assert.deepEqual(seen, [['r1', 'sid-1']]);
  seen.length = 0;
  buildSnapshot(input({ records: [record({ claudeSessionId: 'sid-1' })], onSessionId: (id, sid) => seen.push([id, sid]) }));
  assert.deepEqual(seen, []);
});

test('missing meta and empty scan still produce a view', () => {
  const [view] = buildSnapshot(input({ metaFor: () => null, scan: [] }));
  assert.equal(view.status, 'done');
});

test('loadOrCreateToken creates a 0600 hex token and reuses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tok-'));
  const file = join(dir, 'nested', 'token');
  const t = loadOrCreateToken(file);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8').trim(), t);
  assert.equal(loadOrCreateToken(file), t);
});

function managerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'poll-'));
  const fake = makeFakeSpawn();
  const manager = new SessionManager({ stateFile: join(dir, 's', 'sessions.json'), spawn: fake.spawn });
  return { dir, fake, manager };
}

test('startPoller polls, stores session ids, rebuilds on change and never overlaps', async () => {
  const { dir, manager } = managerFixture();
  const { id } = manager.start({ name: 'p', cwd: dir });
  let scans = 0;
  let release;
  const snapshots = [];
  const poller = startPoller({
    manager,
    intervalMs: 5,
    onSnapshot: (s) => snapshots.push(s),
    scan: () => { scans += 1; return new Promise((r) => { release = () => r([]); }); },
    metaFor: () => ({ sessionId: 'sid-p', status: 'busy' }),
    repoInfoFor: () => ({ repo: 'r', branch: 'b' }),
    readLedgerFn: () => [],
  });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(scans, 1, 'a scan in flight blocks the next tick');
    release();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(manager.get(id).claudeSessionId, 'sid-p');
    assert.equal(poller.current()[0].status, 'working');

    manager.start({ name: 'q', cwd: dir });
    assert.equal(poller.current().length, 2, 'a manager change rebuilds at once');
    assert.ok(snapshots.length >= 2);
  } finally {
    poller.stop();
    release?.();
  }
});

test('startPoller survives a throwing scanner and subscribers', async () => {
  const { dir, manager } = managerFixture();
  manager.start({ name: 'p', cwd: dir });
  const logged = [];
  const poller = startPoller({
    manager,
    intervalMs: 5,
    onSnapshot: () => { throw new Error('subscriber boom'); },
    scan: async () => { throw new Error('scan boom'); },
    metaFor: () => null,
    repoInfoFor: () => ({ repo: 'r', branch: '' }),
    readLedgerFn: () => { throw new Error('ledger boom'); },
    log: (m) => logged.push(m),
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(poller.current().length, 1);
    assert.deepEqual(logged.sort(), ['ledger: ledger boom', 'scanner: scan boom', 'snapshot subscriber: subscriber boom']);
    const got = [];
    const unsubscribe = poller.subscribe((s) => got.push(s));
    manager.start({ name: 'q', cwd: dir });
    assert.equal(got.at(-1).length, 2);
    unsubscribe();
  } finally {
    poller.stop();
  }
});
