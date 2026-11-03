const STATUS_LABEL = {
  'needs-you': 'NEEDS YOU',
  'team-lead': 'TEAM-LEAD HANDLING',
  working: 'WORKING',
  done: 'DONE',
  ended: 'ENDED',
};
const BACKOFF_MS = [1000, 2000, 5000];

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const headerEl = $('session-header');
const panesEl = $('panes');
const emptyEl = $('empty');
const connEl = $('conn');

// The ?key= sign-in link must not stay in the address bar or the history entry.
if (location.search) history.replaceState(null, '', location.pathname + location.hash);

let sessions = [];
let selectedId = location.hash.slice(1) || null;
let previousStatus = null;
let confirmingStop = false;
let editingGoal = false;
const terminals = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function backoff(attempt) {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

function wsUrl(path) {
  return `ws://${location.host}${path}`;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body.
  }
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json;
}

const sessionById = (id) => sessions.find((s) => s.id === id);
const where = (s) => [s.repo, s.branch].filter(Boolean).join(' · ') || s.cwd;

// ---------- terminals ----------

function sendResize(entry) {
  if (entry.ws?.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify({ type: 'resize', cols: entry.term.cols, rows: entry.term.rows }));
  }
}

function fitTerminal(entry) {
  if (!entry.pane.classList.contains('active')) return;
  try {
    entry.fit.fit();
  } catch {
    // Host not laid out yet.
  }
}

function setNotice(entry, text) {
  entry.notice.textContent = text ?? '';
  entry.notice.hidden = !text;
}

function connectTerminal(entry) {
  clearTimeout(entry.retryTimer);
  if (entry.ws) {
    entry.ws.onmessage = null;
    entry.ws.onclose = null;
    entry.ws.close();
  }
  // The server replays scrollback on every attach, so start from a clean buffer.
  entry.term.reset();
  // Queries in the replayed scrollback make xterm.js answer them; those
  // answers are stale and must not reach the live session.
  entry.replaying = true;
  let first = true;
  const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(entry.id)}`));
  ws.binaryType = 'arraybuffer';
  entry.ws = ws;
  ws.onopen = () => {
    entry.attempt = 0;
    setNotice(entry, '');
    sendResize(entry);
  };
  ws.onmessage = (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data);
    if (!first) {
      entry.term.write(data);
      return;
    }
    first = false;
    entry.term.write(data, () => {
      if (entry.ws === ws) entry.replaying = false;
    });
  };
  ws.onclose = (ev) => {
    if (entry.ws !== ws) return;
    if (ev.code === 4404) {
      setNotice(entry, 'Session not found');
      return;
    }
    const s = sessionById(entry.id);
    if (!s || s.status === 'ended') return;
    setNotice(entry, 'Terminal disconnected, reconnecting...');
    entry.retryTimer = setTimeout(() => connectTerminal(entry), backoff(entry.attempt++));
  };
}

function ensureTerminal(id) {
  let entry = terminals.get(id);
  if (entry) return entry;
  const host = el('div', { class: 'xterm-host' });
  const notice = el('div', { class: 'notice', hidden: '' });
  const pane = el('div', { class: 'pane active' }, host, notice);
  for (const other of terminals.values()) other.pane.classList.remove('active');
  panesEl.append(pane);
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: 'Menlo, Monaco, "SF Mono", Consolas, monospace',
    fontSize: 13,
    theme: { background: '#000000' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  entry = { id, term, fit, pane, notice, ws: null, attempt: 0, retryTimer: null, replaying: false };
  term.onData((data) => {
    if (entry.replaying) return;
    if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ type: 'input', data }));
  });
  term.onResize(() => sendResize(entry));
  terminals.set(id, entry);
  connectTerminal(entry);
  requestAnimationFrame(() => {
    fitTerminal(entry);
    sendResize(entry);
  });
  return entry;
}

function disposeTerminal(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  clearTimeout(entry.retryTimer);
  if (entry.ws) {
    entry.ws.onclose = null;
    entry.ws.close();
  }
  entry.term.dispose();
  entry.pane.remove();
  terminals.delete(id);
}

function showTerminal(id) {
  for (const [tid, entry] of terminals) entry.pane.classList.toggle('active', tid === id);
  if (!id || !sessionById(id)) return;
  const entry = ensureTerminal(id);
  entry.pane.classList.add('active');
  fitTerminal(entry);
  entry.term.focus();
}

// ---------- selection ----------

function select(id, { focus = true } = {}) {
  if (selectedId !== id) {
    selectedId = id;
    confirmingStop = false;
    editingGoal = false;
  }
  if (location.hash.slice(1) !== (id ?? '')) history.replaceState(null, '', id ? `#${id}` : location.pathname);
  renderList();
  renderHeader();
  emptyEl.hidden = Boolean(id && sessionById(id));
  if (focus) showTerminal(id);
  else for (const [tid, entry] of terminals) entry.pane.classList.toggle('active', tid === id);
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1) || null;
  if (id !== selectedId) select(id);
});

// ---------- list ----------

function renderEntry(s) {
  const children = [
    el('div', { class: 'top' },
      el('span', { class: `tag ${s.status}` }, STATUS_LABEL[s.status] ?? s.status),
      el('span', { class: 'name' }, s.name)),
  ];
  if (s.goal) children.push(el('div', { class: 'goal' }, s.goal));
  children.push(el('div', { class: 'where' }, where(s)));
  if (s.status === 'needs-you' && s.question) children.push(el('div', { class: 'question' }, s.question));
  if (s.status === 'ended') {
    const actions = el('div', { class: 'actions' });
    if (s.resumable) {
      actions.append(el('button', { type: 'button', onclick: (e) => { e.stopPropagation(); resume(s); } }, 'Resume'));
    }
    actions.append(el('button', { type: 'button', class: 'secondary', onclick: (e) => { e.stopPropagation(); dismiss(s); } }, 'Dismiss'));
    children.push(actions);
  }
  const li = el('li', { class: `entry ${s.status}${s.id === selectedId ? ' selected' : ''}`, 'data-id': s.id }, ...children);
  li.style.borderLeftColor = s.color;
  li.addEventListener('click', () => select(s.id));
  return li;
}

function renderList() {
  listEl.replaceChildren(...sessions.map(renderEntry));
}

// ---------- header ----------

function renderHeader() {
  const s = sessionById(selectedId);
  headerEl.hidden = !s;
  if (!s) {
    headerEl.replaceChildren();
    return;
  }
  headerEl.style.background = s.color;

  const ident = el('div', { class: 'ident' },
    el('div', { class: 'title' }, s.name),
    el('div', { class: 'where' }, where(s)));

  let goal;
  if (editingGoal) {
    goal = el('input', { class: 'goal-input', value: s.goal ?? '', placeholder: 'Goal' });
    goal.value = s.goal ?? '';
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      editingGoal = false;
      if (save && goal.value !== (s.goal ?? '')) {
        api('PATCH', `/api/sessions/${encodeURIComponent(s.id)}`, { goal: goal.value }).catch(showToast);
      }
      renderHeader();
    };
    goal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    goal.addEventListener('blur', () => finish(true));
    queueMicrotask(() => goal.focus());
  } else {
    goal = el('div', { class: `goal${s.goal ? '' : ' empty'}`, title: 'Click to edit the goal' }, s.goal || 'Set a goal');
    goal.addEventListener('click', () => {
      editingGoal = true;
      renderHeader();
    });
  }

  const controls = el('div', { class: 'controls' });
  if (s.status === 'ended') {
    if (s.resumable) controls.append(el('button', { type: 'button', onclick: () => resume(s) }, 'Resume'));
    controls.append(el('button', { type: 'button', onclick: () => dismiss(s) }, 'Dismiss'));
  } else if (confirmingStop) {
    controls.append(
      el('span', { class: 'confirm' }, `Stop ${s.name}?`),
      el('button', { type: 'button', onclick: () => { confirmingStop = false; stop(s); } }, 'Yes'),
      el('button', { type: 'button', onclick: () => { confirmingStop = false; renderHeader(); } }, 'No'));
  } else {
    controls.append(el('button', { type: 'button', onclick: () => { confirmingStop = true; renderHeader(); } }, 'Stop'));
  }
  headerEl.replaceChildren(ident, goal, controls);
}

// ---------- actions ----------

let toastTimer = null;
function showToast(err) {
  const entry = terminals.get(selectedId);
  const text = err?.message ?? String(err);
  if (entry) {
    setNotice(entry, text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setNotice(entry, ''), 5000);
  } else {
    emptyEl.textContent = text;
  }
}

const idPath = (s) => `/api/sessions/${encodeURIComponent(s.id)}`;
const stop = (s) => api('POST', `${idPath(s)}/stop`).catch(showToast);
const dismiss = (s) => api('POST', `${idPath(s)}/dismiss`).catch(showToast);
async function resume(s) {
  try {
    await api('POST', `${idPath(s)}/resume`);
  } catch (err) {
    showToast(err);
  }
}

// ---------- snapshots ----------

function notify(s) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(s.name, { body: s.question ?? '', tag: s.id });
  n.onclick = () => {
    window.focus();
    select(s.id);
    n.close();
  };
}

function applySnapshot(next) {
  const prev = previousStatus;
  previousStatus = new Map(next.map((s) => [s.id, s.status]));
  sessions = next;
  renderTeamLeadButton();

  const needs = next.filter((s) => s.status === 'needs-you').length;
  document.title = needs > 0 ? `(${needs}) agent-desk` : 'agent-desk';

  if (prev) {
    for (const s of next) {
      if (s.status === 'needs-you' && prev.get(s.id) !== 'needs-you') notify(s);
    }
  }

  for (const id of [...terminals.keys()]) {
    const s = sessionById(id);
    if (!s) {
      disposeTerminal(id);
    } else if (prev?.get(id) === 'ended' && s.status !== 'ended') {
      const entry = terminals.get(id);
      entry.attempt = 0;
      connectTerminal(entry);
    }
  }

  if (selectedId && !sessionById(selectedId)) {
    select(null);
    return;
  }
  const typing = editingGoal && document.activeElement?.classList.contains('goal-input');
  renderList();
  if (!typing) renderHeader();
  emptyEl.hidden = Boolean(selectedId && sessionById(selectedId));
  const entry = selectedId && terminals.get(selectedId);
  if (entry) {
    const s = sessionById(selectedId);
    if (s.status === 'ended') setNotice(entry, `${s.name} has ended${s.resumable ? '. Use Resume to continue it.' : '.'}`);
    else if (entry.notice.textContent.endsWith('Resume to continue it.') || entry.notice.textContent.endsWith('has ended.')) setNotice(entry, '');
  } else if (selectedId && !terminals.has(selectedId)) {
    showTerminal(selectedId);
  }
}

let eventsAttempt = 0;
function connectEvents() {
  const ws = new WebSocket(wsUrl('/ws/events'));
  ws.onopen = () => {
    eventsAttempt = 0;
    connEl.hidden = true;
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg?.type === 'snapshot' && Array.isArray(msg.sessions)) applySnapshot(msg.sessions);
  };
  ws.onclose = () => {
    connEl.hidden = false;
    setTimeout(connectEvents, backoff(eventsAttempt++));
  };
}

// ---------- new session form ----------

const form = $('new-form');
const formError = $('nf-error');

$('new-btn').addEventListener('click', () => {
  form.hidden = !form.hidden;
  if (!form.hidden) $('nf-name').focus();
});
$('nf-cancel').addEventListener('click', () => {
  form.hidden = true;
  formError.hidden = true;
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.hidden = true;
  $('nf-submit').disabled = true;
  try {
    const rec = await api('POST', '/api/sessions', {
      name: $('nf-name').value.trim(),
      cwd: $('nf-cwd').value.trim(),
      agent: $('nf-agent').value.trim(),
      brief: $('nf-brief').value,
    });
    form.reset();
    form.hidden = true;
    if (rec?.id) {
      if (!sessionById(rec.id)) sessions = [...sessions, { ...rec, status: 'working', color: rec.color ?? '#3b82f6' }];
      select(rec.id);
    }
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    $('nf-submit').disabled = false;
  }
});

// ---------- team-lead button ----------

const tlBtn = $('tl-btn');
const TEAM_LEAD_BODY = { name: 'team-lead', agent: 'team-lead', cwd: '~/Documents/dev', brief: 'Start your loop.' };
const teamLeadSession = () => sessions.find((s) => s.pinned);

function renderTeamLeadButton() {
  const tl = teamLeadSession();
  const live = Boolean(tl) && tl.status !== 'ended';
  tlBtn.disabled = live;
  tlBtn.textContent = live ? 'team-lead running' : tl?.resumable ? '↻ Resume team-lead' : '▶ Start team-lead';
}

tlBtn.addEventListener('click', async () => {
  const tl = teamLeadSession();
  if (tl && tl.status !== 'ended') return;
  tlBtn.disabled = true;
  try {
    if (tl?.resumable) {
      await api('POST', `${idPath(tl)}/resume`);
      select(tl.id);
      return;
    }
    if (tl) await api('POST', `${idPath(tl)}/dismiss`);
    const rec = await api('POST', '/api/sessions', TEAM_LEAD_BODY);
    if (rec?.id) {
      if (!sessionById(rec.id)) sessions = [...sessions, { ...rec, status: 'working', color: rec.color ?? '#3b82f6' }];
      select(rec.id);
    }
  } catch (err) {
    showToast(err);
  } finally {
    renderTeamLeadButton();
  }
});

// ---------- page-level ----------

let askedPermission = false;
document.addEventListener('click', () => {
  if (askedPermission || !('Notification' in window)) return;
  askedPermission = true;
  if (Notification.permission === 'default') Notification.requestPermission();
});

window.addEventListener('resize', () => {
  const entry = terminals.get(selectedId);
  if (entry) fitTerminal(entry);
});
new ResizeObserver(() => {
  const entry = terminals.get(selectedId);
  if (entry) fitTerminal(entry);
}).observe(panesEl);

connectEvents();
