import { readFileSync } from 'node:fs';

// Reads the team-lead ledger (one JSON object per line). Never throws: a
// missing or unreadable file yields [], and malformed lines are skipped.
export function readLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
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
