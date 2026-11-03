import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SESSIONS_DIR } from './config.js';

export function readSessionMeta(pid, dir = CLAUDE_SESSIONS_DIR) {
  try {
    const data = JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8'));
    if (!data || typeof data !== 'object') return null;
    const { sessionId, status, name, cwd } = data;
    return { sessionId, status, name, cwd };
  } catch {
    return null;
  }
}
