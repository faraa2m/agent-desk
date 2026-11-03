import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenWatcher, stripAnsi, detectPrompt } from '../src/screen-watcher.js';

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('stripAnsi removes OSC sequences with BEL and ST terminators', () => {
  assert.equal(stripAnsi('a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c'), 'abc');
});

test('detectPrompt matches the known prompt shapes', () => {
  assert.equal(detectPrompt('Do you want to proceed?'), true);
  assert.equal(detectPrompt('Do you want to make this edit to a.js?'), true);
  assert.equal(detectPrompt('Esc to cancel · Enter to select'), true);
  assert.equal(detectPrompt('❯ 1. Yes'), true);
  assert.equal(detectPrompt('Running tests…'), false);
});

test('prompt with colour codes mixed in sets waiting; userInput clears it', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b[1mDo you \x1b[0mwant to proceed?\r\n\x1b[36m❯ 1.\x1b[0m Yes');
  assert.equal(w.waiting, true);
  w.userInput();
  assert.equal(w.waiting, false);
});

test('prompt split across chunks is detected', () => {
  const w = new ScreenWatcher();
  w.feed('Do you want');
  assert.equal(w.waiting, false);
  w.feed(' to proceed?');
  assert.equal(w.waiting, true);
});

test('OSC 9 notification sets waiting and userInput clears it', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]9;Claude needs your input\x07');
  assert.equal(w.waiting, true);
  w.userInput();
  assert.equal(w.waiting, false);
});

test('OSC 777 notify sets waiting, with either terminator', () => {
  const a = new ScreenWatcher();
  a.feed('\x1b]777;notify;Claude;needs you\x07');
  assert.equal(a.waiting, true);
  const b = new ScreenWatcher();
  b.feed('\x1b]777;notify;Claude;needs you\x1b\\');
  assert.equal(b.waiting, true);
});

test('OSC 9 terminated by ST counts', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]9;hello\x1b\\');
  assert.equal(w.waiting, true);
});

test('bare BEL sets waiting', () => {
  const w = new ScreenWatcher();
  w.feed('done\x07');
  assert.equal(w.waiting, true);
});

test('BEL terminating a window-title OSC is not a bell', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]0;title\x07');
  assert.equal(w.waiting, false);
});

test('ordinary output is not waiting', () => {
  const w = new ScreenWatcher();
  w.feed('Running tests…');
  assert.equal(w.waiting, false);
});

test('OSC 9 split across chunks is parsed once complete', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]9;Claude nee');
  assert.equal(w.waiting, false);
  w.feed('ds your input\x07');
  assert.equal(w.waiting, true);
});

test('window-title OSC split across chunks does not ring the bell', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]0;ti');
  w.feed('tle\x07');
  assert.equal(w.waiting, false);
});

test('split ESC ] introducer and split ST terminator', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b');
  w.feed(']9;hi\x1b');
  assert.equal(w.waiting, false);
  w.feed('\\');
  assert.equal(w.waiting, true);
});

test('split CSI sequence does not leak into text', () => {
  const w = new ScreenWatcher();
  w.feed('Do you want to \x1b[3');
  w.feed('1mproceed?\x1b[0m');
  assert.equal(w.waiting, true);
});

test('only the last 4096 characters are kept', () => {
  const w = new ScreenWatcher();
  w.feed('Do you want to proceed?');
  w.feed('x'.repeat(5000));
  assert.equal(w.waiting, false);
});
