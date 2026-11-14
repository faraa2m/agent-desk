import { readFileSync, statSync } from 'node:fs';

// path -> { mtimeMs, size, entries } from the last read of each ledger.
const cache = new Map();

// Reads the team-lead ledger (one JSON object per line). Never throws: a
// missing or unreadable file yields [], and malformed lines are skipped.
// The parsed entries are reused while the file's size and mtime are unchanged.
export function readLedger(path) {
  let stat;
  let text;
  try {
    stat = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entries;
    text = readFileSync(path, 'utf8');
  } catch {
    cache.delete(path);
    return [];
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    } catch {
      // skip malformed line
    }
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries;
}

// Returns the last entry for the session and prompt hash, or null.
export function findEntry(entries, sessionId, textHash) {
  if (textHash == null) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.session_id === sessionId && e.text_hash === textHash) return e;
  }
  return null;
}
