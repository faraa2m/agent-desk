import { appendFileSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { LOG_FILE, PORT, SESSIONS_FILE, STATE_DIR, TOKEN_FILE } from './config.js';
import { loadPtySpawn } from './pty.js';
import { createServer } from './server.js';
import { SessionManager } from './session-manager.js';
import { startPoller } from './snapshot.js';
import { loadOrCreateToken } from './token.js';

function log(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never take the server down.
  }
}

/** Runs the agent-desk server in this process until SIGTERM or SIGINT. */
export async function serve() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
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
