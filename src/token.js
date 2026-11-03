import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOKEN_FILE } from './config.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Returns the per-install token, creating it (32 random bytes, hex, mode 0600) when absent or invalid. */
export function loadOrCreateToken(file = TOKEN_FILE) {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(existing)) {
      chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    // Missing or unreadable: create a new one below.
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
