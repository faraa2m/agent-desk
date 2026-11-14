import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { LOG_FILE, PORT, SESSIONS_FILE, STATE_DIR, TOKEN_FILE, UPLOADS_DIR } from './config.js';
import { loadPtySpawn } from './pty.js';
import { createServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { startPoller } from './snapshot.js';
import { loadOrCreateToken } from './token.js';

const UPLOAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_SWEEP_MS = 6 * 60 * 60 * 1000;

function log(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Logging must never take the server down.
  }
}

// State files hold the token, session names and briefs: owner-only, even when
// the directory or log was created earlier with looser permissions.
function restrictState() {
  for (const [path, mode] of [[STATE_DIR, 0o700], [UPLOADS_DIR, 0o700], [LOG_FILE, 0o600], [SESSIONS_FILE, 0o600]]) {
    try {
      chmodSync(path, mode);
    } catch {
      // Not created yet.
    }
  }
}

/** Deletes uploaded copies older than `maxAgeMs`; returns how many were removed. */
export function sweepUploads(dir = UPLOADS_DIR, maxAgeMs = UPLOAD_MAX_AGE_MS, now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const stat = statSync(file);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        rmSync(file);
        removed += 1;
      }
    } catch {
      // Gone already or not removable.
    }
  }
  return removed;
}

/** Runs the agent-desk server in this process until SIGTERM or SIGINT. */
export async function serve() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  restrictState();
  const sweep = () => {
    const n = sweepUploads();
    if (n) log(`removed ${n} uploaded file(s) older than 7 days`);
  };
  sweep();
  setInterval(sweep, UPLOAD_SWEEP_MS).unref();
  const token = loadOrCreateToken(TOKEN_FILE);
  const spawn = await loadPtySpawn();
  const manager = new SessionManager({ stateFile: SESSIONS_FILE, spawn });
  const poller = startPoller({ manager, log });
  const server = createServer({ manager, poller, token, port: PORT, log });

  // Live sessions exist only inside this process, so one failed pty or
  // persistence callback must be logged rather than allowed to end them all.
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack ?? err}`));

  const shutdown = () => {
    poller.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await once(server, 'listening');
  } catch (err) {
    // The poller's timer would otherwise keep the process alive without a server.
    poller.stop();
    log(`listen failed: ${err.message}`);
    throw err;
  }
  log(`listening on 127.0.0.1:${PORT}`);
}
