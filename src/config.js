import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export const PORT = Number(process.env.AGENT_DESK_PORT) || 47321;
export const STATE_DIR = expandHome(process.env.AGENT_DESK_HOME || '~/.agent-desk');
export const TOKEN_FILE = join(STATE_DIR, 'token');
export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json');
export const UPLOADS_DIR = join(STATE_DIR, 'uploads');
export const LOG_FILE = join(STATE_DIR, 'server.log');
export const CLAUDE_SESSIONS_DIR = expandHome('~/.claude/sessions');
export const SCANNER_SCRIPT = expandHome('~/.claude/skills/team-lead/scripts/scan_sessions.py');
export const AGENTS_DIR = expandHome('~/.claude/agents');
export const LEDGER_FILE = expandHome('~/.claude/team-lead/ledger.jsonl');
export const GRACE_MS = 120000;
export const POLL_MS = 3000;
