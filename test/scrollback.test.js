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
