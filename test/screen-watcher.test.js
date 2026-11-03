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
  assert.equal(w.waiting, false);
  w.feed('1mproceed?\x1b[0m');
  // A leaked "[3" or "31m" fragment would break the phrase and leave waiting false.
  assert.equal(w.waiting, true);
});

test('split CSI parameters are not treated as visible text', () => {
  const w = new ScreenWatcher();
  w.feed('Enter to sel\x1b[3');
  w.feed('8;5;2mect');
  assert.equal(w.waiting, true);
});

test('OSC 9;4 progress sequences do not set waiting', () => {
  const a = new ScreenWatcher();
  a.feed('\x1b]9;4;1;50\x07');
  assert.equal(a.waiting, false);
  const b = new ScreenWatcher();
  b.feed('\x1b]9;4;0\x1b\\');
  assert.equal(b.waiting, false);
});

test('OSC 9 body that merely starts with 4 still notifies', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]9;44 files changed\x07');
  assert.equal(w.waiting, true);
});

test('only the last 4096 characters are kept', () => {
  const w = new ScreenWatcher();
  w.feed('Do you want to proceed?');
  w.feed('x'.repeat(5000));
  assert.equal(w.waiting, false);
});

// Claude Code positions words with cursor-movement sequences instead of
// spaces; these fragments are its real output.
test('workspace trust dialog laid out with cursor moves sets waiting', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n'
    + '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n\r\r\n'
    + '\x1b[2G\x1b[38;2;153;153;153mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n');
  assert.equal(w.waiting, true);
});

test('permission question laid out with cursor moves sets waiting', () => {
  const w = new ScreenWatcher();
  w.feed('\r\x1b[1C\x1b[1B\x1b[39mDo\x1b[5Gyou\x1b[9Gwant\x1b[14Gto\x1b[17Gcreate\x1b[24G\x1b[1mad-e2e-2.txt\x1b[22m?');
  assert.equal(w.waiting, true);
});

test('a bell records when it rang; userInput clears it', () => {
  const w = new ScreenWatcher();
  assert.equal(w.bellAt, null);
  const before = Date.now();
  w.feed('\x07');
  assert.ok(w.bellAt >= before && w.bellAt <= Date.now());
  w.userInput();
  assert.equal(w.bellAt, null);
});

test('ordinary output after a bell clears it', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]9;Claude needs your input\x07');
  assert.equal(w.waiting, true);
  w.feed('\x1b[2K\x1b[1G\x1b[38;5;174mWorking…\x1b[39m');
  assert.equal(w.waiting, false);
  assert.equal(w.bellAt, null);
});

test('text after the bell in the same chunk clears it; text before it does not', () => {
  const a = new ScreenWatcher();
  a.feed('done\x07');
  assert.equal(a.waiting, true);
  const b = new ScreenWatcher();
  b.feed('\x07Working…');
  assert.equal(b.waiting, false);
});

test('a prompt after a bell keeps waiting', () => {
  const w = new ScreenWatcher();
  w.feed('\x07');
  w.feed('\x1b[1mDo you want to proceed?\x1b[22m\r\n❯ 1. Yes\r\n');
  assert.equal(w.waiting, true);
  assert.notEqual(w.bellAt, null);
});

test('only escape sequences and whitespace after a bell keep waiting', () => {
  const w = new ScreenWatcher();
  w.feed('\x1b]777;notify;Claude;needs you\x07');
  w.feed('\x1b[?25l\x1b[2K\x1b[1A\x1b]0;title\x07\x1b[38;5;174m\r\n  \x1b[39m\x1b[?25h');
  assert.equal(w.waiting, true);
});
