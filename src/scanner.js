import { execFile } from 'node:child_process';
import { SCANNER_SCRIPT } from './config.js';

const loggedErrors = new Set();

function logOnce(message) {
  if (loggedErrors.has(message)) return;
  loggedErrors.add(message);
  console.error(`scanner: ${message}`);
}

export function parseScanOutput(stdout) {
  const entries = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    } catch {
      // Lines that are not JSON objects are skipped.
    }
  }
  return entries;
}

export function runScanner(script = SCANNER_SCRIPT, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-I', script],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          logOnce(error.message);
          resolve([]);
          return;
        }
        resolve(parseScanOutput(stdout));
      },
    );
  });
}
