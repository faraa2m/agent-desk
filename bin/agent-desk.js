#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_FILE, PORT, STATE_DIR, TOKEN_FILE } from '../src/config.js';

const SELF = fileURLToPath(import.meta.url);
const BASE = `http://127.0.0.1:${PORT}`;
const EXIT_UNREACHABLE = 3;
const TIMEOUT_MS = Number(process.env.AGENT_DESK_TIMEOUT_MS) || 5000;
// Connect errors that mean no server is listening, so nothing was sent.
const NOT_LISTENING = new Set(['ECONNREFUSED', 'ENOENT', 'EADDRNOTAVAIL']);
const NO_ANSWER = 'agent-desk did not answer in time; the session may have started — check agent-desk';

/** Nothing is listening, so the request never reached agent-desk. */
class Unreachable extends Error {}
/** The request may have reached agent-desk, which gave no usable answer. */
class NoAnswer extends Error {}

function connectCode(err) {
  for (let e = err; e; e = e.cause) {
    if (e.code) return e.code;
    if (Array.isArray(e.errors)) return e.errors.map((x) => x?.code).find(Boolean);
  }
  return undefined;
}

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

async function api(method, path, token, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (NOT_LISTENING.has(connectCode(err))) throw new Unreachable();
    throw new NoAnswer(err.name === 'TimeoutError' ? NO_ANSWER : `agent-desk request failed: ${err.message}`);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body.
  }
  return { ok: res.ok, status: res.status, json };
}

async function healthy() {
  try {
    return (await api('GET', '/api/health')).ok;
  } catch {
    return false;
  }
}

async function open() {
  if (!(await healthy())) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const fd = openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    closeSync(fd);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await healthy())) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await healthy())) {
      console.error(`agent-desk did not start; see ${LOG_FILE}`);
      return 1;
    }
  }
  const token = readToken();
  if (!token) {
    console.error('agent-desk token not found');
    return 1;
  }
  // The keyed URL goes only to the browser; the terminal never shows the token.
  console.log(`Opening agent-desk at ${BASE}/`);
  execFileSync('/usr/bin/open', [`${BASE}/?key=${token}`]);
  return 0;
}

function parseLaunch(args) {
  const rest = [];
  let agent = null;
  let model = null;
  let briefFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') agent = args[++i];
    else if (args[i] === '--model') model = args[++i];
    else if (args[i] === '--brief-file') briefFile = args[++i];
    else rest.push(args[i]);
  }
  const [name, dir, ...words] = rest;
  return { name, dir, agent, model, briefFile, words };
}

async function launch(args) {
  const { name, dir, agent, model, briefFile, words } = parseLaunch(args);
  if (!name || !dir) {
    console.error('usage: agent-desk launch <name> <dir> [--agent <a>] [--model <m>] (--brief-file <path> | <brief...>)');
    return 2;
  }
  let brief = words.join(' ');
  if (briefFile) {
    try {
      brief = readFileSync(briefFile, 'utf8');
    } catch (err) {
      console.error(`cannot read brief file: ${err.message}`);
      return 2;
    }
  }
  const token = readToken();
  let res;
  try {
    res = await api('POST', '/api/sessions', token, { name, cwd: resolve(dir), agent: agent ?? undefined, model: model ?? undefined, brief });
  } catch (err) {
    if (err instanceof Unreachable) return EXIT_UNREACHABLE;
    // Exit 1, not 3, so launch-session does not start the same session elsewhere.
    if (err instanceof NoAnswer) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  if (!res.ok) {
    console.error(res.json?.error ?? `agent-desk returned HTTP ${res.status}`);
    return 1;
  }
  console.log(`launched '${name}' in agent-desk`);
  return 0;
}

async function status() {
  let res;
  try {
    res = await api('GET', '/api/sessions', readToken());
  } catch (err) {
    if (err instanceof Unreachable) {
      console.error('agent-desk is not running');
      return EXIT_UNREACHABLE;
    }
    throw err;
  }
  if (!res.ok || !Array.isArray(res.json)) {
    console.error(res.json?.error ?? `agent-desk returned HTTP ${res.status}`);
    return 1;
  }
  for (const s of res.json) {
    const where = [s.repo, s.branch].filter(Boolean).join('·') || s.cwd;
    console.log([String(s.status).toUpperCase(), s.name, where, s.goal ?? ''].join('  ').trimEnd());
  }
  return 0;
}

async function main([cmd = 'open', ...args]) {
  switch (cmd) {
    case 'open': return open();
    case 'serve': {
      const { serve } = await import('../src/serve.js');
      await serve();
      return null; // The server keeps the process alive.
    }
    case 'launch': return launch(args);
    case 'status': return status();
    case 'install-login': {
      const { installLogin } = await import('../src/launchd.js');
      console.log(`installed ${installLogin()}`);
      return 0;
    }
    case 'uninstall-login': {
      const { uninstallLogin } = await import('../src/launchd.js');
      uninstallLogin();
      console.log('uninstalled');
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\ncommands: open, serve, launch, status, install-login, uninstall-login`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => { if (code !== null) process.exitCode = code; },
  (err) => { console.error(err.message); process.exitCode = 1; },
);
