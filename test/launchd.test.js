import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLogin, plistFor, uninstallLogin } from '../src/launchd.js';

const args = {
  nodePath: '/opt/node/bin/node',
  scriptPath: '/repo/bin/agent-desk.js',
  pathEnv: '/opt/node/bin:/usr/bin & co',
  home: '/Users/x',
  logPath: '/Users/x/.agent-desk/server.log',
};

test('plistFor contains the label, serve argument, PATH and KeepAlive', () => {
  const plist = plistFor(args);
  assert.match(plist, /com\.agent-desk\.server/);
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /\/opt\/node\/bin:\/usr\/bin &amp; co/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
});

test('plistFor output is a valid plist', () => {
  execFileSync('plutil', ['-lint', '-'], { input: plistFor(args) });
});

function tempEnv() {
  const home = mkdtempSync(join(tmpdir(), 'launchd-'));
  const calls = [];
  const run = (cmd, a) => { calls.push([cmd, ...a]); };
  return {
    home, calls,
    opts: { home, uid: 501, run, scriptPath: '/repo/bin/agent-desk.js', nodePath: '/n', pathEnv: '/p', logPath: join(home, 'log') },
  };
}

test('installLogin writes the plist, links the command and bootstraps after a bootout', () => {
  const { home, calls, opts } = tempEnv();
  const plist = installLogin(opts);
  assert.equal(plist, join(home, 'Library', 'LaunchAgents', 'com.agent-desk.server.plist'));
  assert.match(readFileSync(plist, 'utf8'), /<string>\/repo\/bin\/agent-desk\.js<\/string>/);
  assert.equal(readlinkSync(join(home, '.claude', 'bin', 'agent-desk')), '/repo/bin/agent-desk.js');
  assert.deepEqual(calls, [
    ['launchctl', 'bootout', 'gui/501', plist],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  installLogin(opts); // Existing link already points at the script.
  assert.ok(lstatSync(join(home, '.claude', 'bin', 'agent-desk')).isSymbolicLink());
});

test('installLogin tolerates bootout failing when the agent is not loaded', () => {
  const { opts } = tempEnv();
  opts.run = (cmd, a) => { if (a[0] === 'bootout') throw new Error('not loaded'); };
  installLogin(opts);
});

test('uninstallLogin boots out and deletes the plist', () => {
  const { calls, opts } = tempEnv();
  const plist = installLogin(opts);
  calls.length = 0;
  uninstallLogin(opts);
  assert.deepEqual(calls, [['launchctl', 'bootout', 'gui/501', plist]]);
  assert.equal(existsSync(plist), false);
});
