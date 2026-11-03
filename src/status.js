import { GRACE_MS } from './config.js';

const STATUS_ORDER = ['needs-you', 'team-lead', 'working', 'done', 'ended'];

function rank(status) {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}

export function computeStatus({
  exited, busy, scanWaiting, screenWaiting, isTeamLeadSession,
  teamLeadRunning, ledgerEntry, waitingSince, now,
}) {
  if (exited) return 'ended';
  if (!(scanWaiting || screenWaiting)) return busy ? 'working' : 'done';
  if (isTeamLeadSession || !teamLeadRunning) return 'needs-you';
  if (ledgerEntry) {
    const handled = ledgerEntry.sent === true
      && ledgerEntry.category !== 'escalate'
      && ledgerEntry.confidence !== 'low';
    return handled ? 'team-lead' : 'needs-you';
  }
  return now - (waitingSince ?? now) < GRACE_MS ? 'team-lead' : 'needs-you';
}

// Pinned first, then status order, then oldest wait first (views without a
// wait time last), then name. Returns a new array.
export function sortViews(views) {
  return [...views].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus) return byStatus;
    const aw = a.waitingSince;
    const bw = b.waitingSince;
    if (aw != null && bw != null && aw !== bw) return aw - bw;
    if ((aw == null) !== (bw == null)) return aw == null ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// Tracks when each session's current wait began. A new key (a different
// prompt) restarts the clock.
export class WaitTracker {
  #waits = new Map();

  update(id, waiting, key, now) {
    if (!waiting) {
      this.#waits.delete(id);
      return null;
    }
    const prev = this.#waits.get(id);
    if (prev && prev.key === key) return prev.since;
    this.#waits.set(id, { key, since: now });
    return now;
  }
}
