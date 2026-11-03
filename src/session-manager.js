import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expandHome } from './config.js';
import { Scrollback } from './scrollback.js';
import { ScreenWatcher } from './screen-watcher.js';

const COLS = 120;
const ROWS = 40;
const GOAL_MAX = 120;
// Reports a terminal sends on its own rather than from a keystroke: focus
// in/out, OSC replies (e.g. background colour), DCS replies, device
// attributes and cursor position.
const TERMINAL_REPORTS = new RegExp(
  [
    '\\x1b\\[[IO]',
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    '\\x1bP[^\\x1b]*\\x1b\\\\',
    '\\x1b\\[[?>][0-9;]*c',
    '\\x1b\\[[0-9]+;[0-9]+R',
  ].join('|'),
  'g',
);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function firstLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line ? line.slice(0, GOAL_MAX) : '';
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Owns one pseudo-terminal per Claude Code session and the persisted record
 * of every session. Ended sessions stay listed until dismissed and can be
 * resumed in place. Emits 'change' whenever a record changes.
 *
 * Attachments belong to the session, not to a particular pty: a listener
 * attached to an ended session keeps receiving output after resume.
 */
export class SessionManager extends EventEmitter {
  #stateFile;
  #spawn;
  #claudeBin;
  #records = new Map();
  #live = new Map(); // id -> {pty, watcher}
  #scrollbacks = new Map();
  #listeners = new Map();

  constructor({ stateFile, spawn, claudeBin = 'claude' }) {
    super();
    this.#stateFile = stateFile;
    this.#spawn = spawn;
    this.#claudeBin = claudeBin;
    this.#load();
  }

  #load() {
    let saved;
    try {
      saved = JSON.parse(readFileSync(this.#stateFile, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;
    const now = Date.now();
    for (const rec of saved) {
      if (!rec || typeof rec.id !== 'string') continue;
      // A record without endedAt was running when the previous server died.
      this.#records.set(rec.id, {
        id: rec.id,
        name: rec.name ?? '',
        cwd: rec.cwd ?? '',
        agent: rec.agent ?? null,
        goal: rec.goal ?? '',
        claudeSessionId: rec.claudeSessionId ?? null,
        pid: null,
        createdAt: rec.createdAt ?? now,
        endedAt: rec.endedAt ?? now,
        exitCode: rec.exitCode ?? null,
      });
    }
  }

  #persist() {
    const dir = dirname(this.#stateFile);
    const tmp = join(dir, `.sessions.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.list(), null, 2));
    renameSync(tmp, this.#stateFile);
  }

  #changed() {
    this.#persist();
    this.emit('change');
  }

  #require(id) {
    const rec = this.#records.get(id);
    if (!rec) throw fail('NOT_FOUND', `No session ${id}`);
    return rec;
  }

  #launch(rec, args) {
    const pty = this.#spawn(this.#claudeBin, args, {
      cwd: rec.cwd,
      cols: COLS,
      rows: ROWS,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      name: 'xterm-256color',
    });
    const watcher = new ScreenWatcher();
    const entry = { pty, watcher };
    this.#live.set(rec.id, entry);
    rec.pid = pty.pid;
    rec.endedAt = null;
    rec.exitCode = null;

    pty.onData((chunk) => {
      if (this.#live.get(rec.id) !== entry) return;
      watcher.feed(chunk);
      this.#scrollbacks.get(rec.id).append(chunk);
      for (const cb of [...(this.#listeners.get(rec.id) ?? [])]) {
        try {
          cb(chunk);
        } catch {
          // A failing listener must not affect the others or the pty.
        }
      }
    });
    pty.onExit(({ exitCode } = {}) => {
      if (this.#live.get(rec.id) !== entry) return;
      this.#live.delete(rec.id);
      rec.pid = null;
      rec.endedAt = Date.now();
      rec.exitCode = exitCode ?? null;
      this.#changed();
    });
  }

  start({ name, cwd, agent = null, brief = '' }) {
    if (typeof name !== 'string' || name.trim() === '') throw fail('BAD_NAME', 'Name is required');
    const dir = expandHome(cwd ?? '');
    if (!cwd || !isDirectory(dir)) throw fail('NO_DIR', `Not a directory: ${cwd}`);
    for (const [id] of this.#live) {
      if (this.#records.get(id).name === name) throw fail('NAME_TAKEN', `A live session is named ${name}`);
    }
    const rec = {
      id: randomBytes(4).toString('hex'),
      name,
      cwd: dir,
      agent,
      goal: firstLine(brief),
      claudeSessionId: null,
      pid: null,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
    this.#records.set(rec.id, rec);
    this.#scrollbacks.set(rec.id, new Scrollback());
    const args = ['-n', name, ...(agent ? ['--agent', agent] : []), ...(brief ? [brief] : [])];
    try {
      this.#launch(rec, args);
    } catch (err) {
      this.#records.delete(rec.id);
      this.#scrollbacks.delete(rec.id);
      throw err;
    }
    this.#changed();
    return { ...rec };
  }

  resume(id) {
    const rec = this.#require(id);
    if (rec.endedAt === null) throw fail('NOT_ENDED', 'Session is still running');
    if (!rec.claudeSessionId) throw fail('NO_CLAUDE_SESSION', 'Session has no Claude session id to resume');
    for (const [otherId] of this.#live) {
      if (this.#records.get(otherId).name === rec.name) throw fail('NAME_TAKEN', `A live session is named ${rec.name}`);
    }
    if (!isDirectory(rec.cwd)) throw fail('NO_DIR', `Not a directory: ${rec.cwd}`);
    if (!this.#scrollbacks.has(id)) this.#scrollbacks.set(id, new Scrollback());
    this.#launch(rec, ['--resume', rec.claudeSessionId, '-n', rec.name]);
    this.#changed();
    return { ...rec };
  }

  stop(id) {
    const rec = this.#require(id);
    if (rec.endedAt !== null) return;
    this.#live.get(id)?.pty.kill('SIGTERM');
  }

  dismiss(id) {
    const rec = this.#require(id);
    if (rec.endedAt === null) throw fail('STILL_LIVE', 'Cannot dismiss a live session');
    this.#records.delete(id);
    this.#scrollbacks.delete(id);
    this.#listeners.delete(id);
    this.#changed();
  }

  setGoal(id, goal) {
    this.#require(id).goal = String(goal ?? '');
    this.#changed();
  }

  setClaudeSessionId(id, sid) {
    this.#require(id).claudeSessionId = sid;
    this.#changed();
  }

  write(id, data) {
    const entry = this.#live.get(id);
    if (!entry) return;
    // Opening or focusing a session's terminal makes it send reports; those
    // alone do not answer a prompt.
    if (String(data).replace(TERMINAL_REPORTS, '') !== '') entry.watcher.userInput();
    entry.pty.write(data);
  }

  resize(id, cols, rows) {
    this.#live.get(id)?.pty.resize(cols, rows);
  }

  attach(id, onData) {
    this.#require(id);
    const scrollback = this.#scrollbacks.get(id)?.toString() ?? '';
    let set = this.#listeners.get(id);
    if (!set) this.#listeners.set(id, (set = new Set()));
    // Wrap so the same callback attached twice yields independent attachments.
    const listener = (chunk) => onData(chunk);
    set.add(listener);
    return { scrollback, detach: () => { this.#listeners.get(id)?.delete(listener); } };
  }

  get(id) {
    const rec = this.#records.get(id);
    return rec ? { ...rec } : null;
  }

  list() {
    return [...this.#records.values()].map((rec) => ({ ...rec }));
  }

  live(id) {
    const entry = this.#live.get(id);
    if (!entry) return null;
    return { pid: entry.pty.pid, screenWaiting: entry.watcher.waiting };
  }
}
