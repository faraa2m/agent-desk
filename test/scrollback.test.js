import test from 'node:test';
import assert from 'node:assert/strict';
import { Scrollback } from '../src/scrollback.js';

test('drops the oldest data past maxBytes', () => {
  const s = new Scrollback(10);
  s.append('abcdef');
  s.append('ghijkl');
  assert.equal(s.toString(), 'cdefghijkl');
});

test('keeps everything under the limit', () => {
  const s = new Scrollback(10);
  s.append('abc');
  assert.equal(s.toString(), 'abc');
});

test('many small appends keep only the newest maxBytes', () => {
  const s = new Scrollback(10);
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') s.append(ch);
  assert.equal(s.toString(), 'qrstuvwxyz');
  s.append('0123');
  assert.equal(s.toString(), 'uvwxyz0123');
});

test('a chunk larger than maxBytes keeps its tail', () => {
  const s = new Scrollback(4);
  s.append('ab');
  s.append('cdefgh');
  assert.equal(s.toString(), 'efgh');
});

test('a zero limit keeps nothing and never throws', () => {
  const s = new Scrollback(0);
  s.append('x');
  s.append('yz');
  assert.equal(s.toString(), '');
});
