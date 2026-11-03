import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_FILE } from './config.js';

export const LABEL = 'com.agent-desk.server';
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-desk.js');

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The LaunchAgent plist that runs `agent-desk serve` at login and keeps it alive. */
export function plistFor({ nodePath, scriptPath, pathEnv, home, logPath }) {
  const s = (v) => `<string>${xmlEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${s(nodePath)}
    ${s(scriptPath)}
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s(pathEnv)}
    <key>HOME</key>
    ${s(home)}
  </dict>
  <key>StandardOutPath</key>
  ${s(logPath)}
  <key>StandardErrorPath</key>
  ${s(logPath)}
</dict>
</plist>
`;
}

function defaults(opts) {
  const home = opts.home ?? homedir();
  return {
    home,
    uid: opts.uid ?? process.getuid(),
    run: opts.run ?? ((cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })),
    plistFile: opts.plistFile ?? join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    linkFile: opts.linkFile ?? join(home, '.claude', 'bin', 'agent-desk'),
    scriptPath: opts.scriptPath ?? SCRIPT_PATH,
    nodePath: opts.nodePath ?? process.execPath,
    pathEnv: opts.pathEnv ?? process.env.PATH ?? '',
    logPath: opts.logPath ?? LOG_FILE,
  };
}

function bootout(run, uid, plistFile) {
  try {
    run('launchctl', ['bootout', `gui/${uid}`, plistFile]);
  } catch {
    // Not loaded.
  }
}

function ensureLink(linkFile, target) {
  let stat = null;
  try {
    stat = lstatSync(linkFile);
  } catch {
    // Absent.
  }
  if (stat?.isSymbolicLink() && readlinkSync(linkFile) === target) return;
  if (stat && !stat.isSymbolicLink()) return; // A real file is never replaced.
  mkdirSync(dirname(linkFile), { recursive: true });
  if (stat) rmSync(linkFile);
  symlinkSync(target, linkFile);
}

/** Writes the plist, links the command into ~/.claude/bin and (re)loads the agent. */
export function installLogin(opts = {}) {
  const d = defaults(opts);
  mkdirSync(dirname(d.plistFile), { recursive: true });
  mkdirSync(dirname(d.logPath), { recursive: true, mode: 0o700 });
  writeFileSync(d.plistFile, plistFor({
    nodePath: d.nodePath, scriptPath: d.scriptPath, pathEnv: d.pathEnv, home: d.home, logPath: d.logPath,
  }));
  ensureLink(d.linkFile, d.scriptPath);
  bootout(d.run, d.uid, d.plistFile);
  d.run('launchctl', ['bootstrap', `gui/${d.uid}`, d.plistFile]);
  return d.plistFile;
}

/** Unloads the agent and deletes its plist. The command symlink stays. */
export function uninstallLogin(opts = {}) {
  const d = defaults(opts);
  bootout(d.run, d.uid, d.plistFile);
  if (existsSync(d.plistFile)) rmSync(d.plistFile);
}
