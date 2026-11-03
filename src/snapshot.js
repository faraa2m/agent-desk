import { LEDGER_FILE, POLL_MS } from './config.js';
import { readSessionMeta } from './claude-meta.js';
import { findEntry, readLedger } from './ledger.js';
import { colorFor, repoInfo } from './repo-info.js';
import { runScanner } from './scanner.js';
import { computeStatus, sortViews, WaitTracker } from './status.js';

const TEAM_LEAD = 'team-lead';
const QUESTION_MAX = 160;
const SCREEN_QUESTION = 'Waiting for your input';

function isTeamLead(rec) {
  return rec.agent === TEAM_LEAD || rec.name === TEAM_LEAD;
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line ? line.slice(0, QUESTION_MAX) : '';
}

/**
 * Combines the manager's records with session meta, scanner output and the
 * team-lead ledger into one sorted SessionView per record.
 */
export function buildSnapshot({
  records, liveFor, metaFor, scan, ledger, repoInfoFor, waitTracker, now, onSessionId = () => {},
}) {
  const live = new Map();
  for (const rec of records) {
    if (rec.endedAt == null) live.set(rec.id, liveFor(rec.id));
  }
  const teamLeadRunning = scan.some((e) => e.name === TEAM_LEAD)
    || records.some((rec) => rec.endedAt == null && isTeamLead(rec));

  const views = records.map((rec) => {
    const exited = rec.endedAt != null;
    const liveInfo = exited ? null : live.get(rec.id);
    const pid = liveInfo?.pid ?? rec.pid;
    const meta = !exited && pid != null ? metaFor(pid) : null;
    if (meta?.sessionId && meta.sessionId !== rec.claudeSessionId) onSessionId(rec.id, meta.sessionId);
    const sessionId = meta?.sessionId ?? rec.claudeSessionId;

    const entry = !exited && sessionId ? scan.find((e) => e.session_id === sessionId) : undefined;
    const scanWaiting = entry?.waiting === true;
    const screenWaiting = liveInfo?.screenWaiting === true;
    const waiting = !exited && (scanWaiting || screenWaiting);
    const key = scanWaiting ? entry.text_hash : 'screen';
    const waitingSince = waitTracker.update(rec.id, waiting, key, now);
    const ledgerEntry = scanWaiting ? findEntry(ledger, sessionId, entry.text_hash) : null;

    const status = computeStatus({
      exited,
      busy: meta?.status === 'busy',
      scanWaiting,
      screenWaiting,
      isTeamLeadSession: isTeamLead(rec),
      teamLeadRunning,
      ledgerEntry,
      waitingSince,
      now,
    });

    let question = null;
    if (waiting) question = (scanWaiting && firstLine(entry.question)) || SCREEN_QUESTION;
    const { repo, branch } = repoInfoFor(rec.cwd);

    return {
      id: rec.id,
      name: rec.name,
      cwd: rec.cwd,
      repo,
      branch,
      color: colorFor(repo),
      goal: rec.goal,
      status,
      question,
      pinned: isTeamLead(rec),
      waitingSince,
      endedAt: rec.endedAt,
      resumable: exited && !!sessionId,
    };
  });
  return sortViews(views);
}

/**
 * Rebuilds the snapshot every intervalMs (scanner included) and immediately,
 * without re-running the scanner, whenever the manager changes. A poll never
 * throws and never overlaps one still in flight.
 */
export function startPoller({
  manager,
  intervalMs = POLL_MS,
  onSnapshot,
  scan: runScan = runScanner,
  metaFor = readSessionMeta,
  repoInfoFor = repoInfo,
  readLedgerFn = () => readLedger(LEDGER_FILE),
  log = console.error,
}) {
  // Logs a source's error only when it differs from that source's previous one.
  const lastError = new Map();
  const report = (source, err) => {
    const message = `${source}: ${err?.message ?? err}`;
    if (lastError.get(source) === message) return;
    lastError.set(source, message);
    log(message);
  };
  const waitTracker = new WaitTracker();
  const subscribers = new Set(onSnapshot ? [onSnapshot] : []);
  let lastScan = [];
  let lastLedger = [];
  let current = [];
  let inFlight = false;
  let stopped = false;

  function rebuild() {
    if (stopped) return;
    const found = [];
    try {
      current = buildSnapshot({
        records: manager.list(),
        liveFor: (id) => manager.live(id),
        metaFor,
        scan: lastScan,
        ledger: lastLedger,
        repoInfoFor,
        waitTracker,
        now: Date.now(),
        onSessionId: (id, sid) => found.push([id, sid]),
      });
    } catch (err) {
      report('snapshot', err);
      return;
    }
    for (const cb of [...subscribers]) {
      try {
        cb(current);
      } catch (err) {
        report('snapshot subscriber', err);
      }
    }
    // Applied after publishing: each update emits 'change', which rebuilds again.
    for (const [id, sid] of found) {
      try {
        manager.setClaudeSessionId(id, sid);
      } catch {
        // The record was dismissed meanwhile.
      }
    }
  }

  async function poll() {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      try {
        const result = await runScan();
        lastScan = Array.isArray(result) ? result : [];
      } catch (err) {
        report('scanner', err);
        lastScan = [];
      }
      try {
        const entries = readLedgerFn();
        lastLedger = Array.isArray(entries) ? entries : [];
      } catch (err) {
        report('ledger', err);
        lastLedger = [];
      }
      rebuild();
    } finally {
      inFlight = false;
    }
  }

  const onChange = () => rebuild();
  manager.on('change', onChange);
  rebuild();
  poll();
  const timer = setInterval(poll, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      manager.off('change', onChange);
      subscribers.clear();
    },
    current: () => current,
    subscribe(cb) {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },
  };
}
