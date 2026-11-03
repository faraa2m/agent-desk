import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, sortViews, WaitTracker } from '../src/status.js';

const now = 1_000_000;
const base = {
  exited: false, busy: false, scanWaiting: false, screenWaiting: false,
  isTeamLeadSession: false, teamLeadRunning: true, ledgerEntry: null,
  waitingSince: now, now,
};
const st = (o) => computeStatus({ ...base, ...o });
const sent = { sent: true, category: 'continue-obvious', confidence: 'high' };

test('exited is ended', () => {
  assert.equal(st({ exited: true, scanWaiting: true, busy: true }), 'ended');
});

test('not waiting: busy is working, idle is done', () => {
  assert.equal(st({ busy: true }), 'working');
  assert.equal(st({ busy: false }), 'done');
});

test('screen-only waiting while busy is not working', () => {
  assert.notEqual(st({ screenWaiting: true, busy: true }), 'working');
});

test('team-lead session or team-lead not running needs you', () => {
  assert.equal(st({ scanWaiting: true, isTeamLeadSession: true }), 'needs-you');
  assert.equal(st({ scanWaiting: true, teamLeadRunning: false }), 'needs-you');
});

test('sent, non-escalated, confident entry is team-lead', () => {
  assert.equal(st({ scanWaiting: true, ledgerEntry: sent }), 'team-lead');
});

test('escalated entry needs you', () => {
  assert.equal(st({ scanWaiting: true, ledgerEntry: { ...sent, category: 'escalate' } }), 'needs-you');
});

test('low-confidence entry needs you', () => {
  assert.equal(st({ scanWaiting: true, ledgerEntry: { ...sent, confidence: 'low' } }), 'needs-you');
});

test('unsent shadow proposal needs you', () => {
  assert.equal(st({ screenWaiting: true, ledgerEntry: { ...sent, sent: false } }), 'needs-you');
});

test('no entry: team-lead within grace, needs-you after', () => {
  assert.equal(st({ scanWaiting: true, waitingSince: now - 119000 }), 'team-lead');
  assert.equal(st({ scanWaiting: true, waitingSince: now - 121000 }), 'needs-you');
});

test('WaitTracker keeps start time for the same key and resets on a new key', () => {
  const t = new WaitTracker();
  assert.equal(t.update('a', true, 'k1', 100), 100);
  assert.equal(t.update('a', true, 'k1', 200), 100);
  assert.equal(t.update('a', true, 'k2', 300), 300);
});

test('WaitTracker returns null and forgets when not waiting', () => {
  const t = new WaitTracker();
  t.update('a', true, 'k1', 100);
  assert.equal(t.update('a', false, 'k1', 200), null);
  assert.equal(t.update('a', true, 'k1', 300), 300);
});

test('sortViews puts a pinned done view above a needs-you one', () => {
  const out = sortViews([
    { name: 'a', pinned: false, status: 'needs-you', waitingSince: 1 },
    { name: 'b', pinned: true, status: 'done', waitingSince: null },
  ]);
  assert.deepEqual(out.map((v) => v.name), ['b', 'a']);
});

test('sortViews orders by status, then oldest wait, then name, without mutating', () => {
  const views = [
    { name: 'z', pinned: false, status: 'ended', waitingSince: null },
    { name: 'w', pinned: false, status: 'working', waitingSince: null },
    { name: 'n2', pinned: false, status: 'needs-you', waitingSince: 50 },
    { name: 'n1', pinned: false, status: 'needs-you', waitingSince: 10 },
    { name: 'n0', pinned: false, status: 'needs-you', waitingSince: null },
    { name: 't', pinned: false, status: 'team-lead', waitingSince: 5 },
    { name: 'd', pinned: false, status: 'done', waitingSince: null },
    { name: 'a', pinned: false, status: 'done', waitingSince: null },
  ];
  const copy = [...views];
  const out = sortViews(views);
  assert.deepEqual(out.map((v) => v.name), ['n1', 'n2', 'n0', 't', 'w', 'a', 'd', 'z']);
  assert.deepEqual(views, copy);
  assert.notEqual(out, views);
});
