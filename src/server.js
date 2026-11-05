import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT, UPLOADS_DIR } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const VENDOR_FILES = {
  'xterm.js': join(ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  'xterm.css': join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  'addon-fit.js': join(ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const BODY_MAX = 1024 * 1024;
const UPLOAD_MAX = 50 * 1024 * 1024;
const UPLOAD_NAME_MAX = 80;
const LOCATE_TIMEOUT_MS = 3000;
const LOCATE_MTIME_SLACK_MS = 2000;
const COOKIE = 'ad_key';
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const SIGN_IN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>agent-desk</title></head>
<body>
<h1>agent-desk</h1>
<p>This browser is not signed in. Run <code>agent-desk</code> in a terminal to open it.</p>
</body>
</html>
`;
const ERROR_STATUS = {
  BAD_NAME: 400,
  NO_DIR: 400,
  NAME_TAKEN: 409,
  NOT_FOUND: 404,
  STILL_LIVE: 409,
  NOT_ENDED: 409,
  NO_CLAUDE_SESSION: 409,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function tokenMatches(candidate, token) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function bearer(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? ''));
  return m ? m[1] : null;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendFile(res, file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// Resolves a request path under public/, or null when it would escape it.
function publicPath(rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = resolve(PUBLIC_DIR, `.${sep}${decoded}`);
  return file.startsWith(PUBLIC_DIR + sep) ? file : null;
}

// A safe single path segment for an uploaded file: no directories, no spaces
// or shell-significant characters, so the typed path needs no quoting.
function uploadName(header) {
  let raw = '';
  try {
    raw = decodeURIComponent(String(header ?? ''));
  } catch {
    raw = '';
  }
  const base = raw.split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (base || 'file').slice(-UPLOAD_NAME_MAX);
}

// Paths Spotlight knows with exactly this file name; empty when Spotlight is
// unavailable or slow.
function spotlightFind(name) {
  return new Promise((resolveFind) => {
    execFile('mdfind', ['-name', name], { timeout: LOCATE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      resolveFind(err ? [] : String(out).split('\n').filter(Boolean));
    });
  });
}

function readUpload(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > UPLOAD_MAX) {
        reject(new HttpError(413, 'File too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolveBody({});
        return;
      }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolveBody(value);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

// One server-log line for a call that changes sessions. The query string
// (which may hold the token) and request bodies are never included.
function auditLine(method, pathname, { id, name }, status) {
  const parts = [method, pathname];
  if (id) parts.push(`id=${id}`);
  if (name !== undefined) parts.push(`name=${JSON.stringify(String(name))}`);
  return `${parts.join(' ')} -> ${status}`;
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * HTTP API, static page and WebSockets for agent-desk, bound to 127.0.0.1.
 * Every request needs a local Host header and, when it carries an Origin, a
 * local Origin. Every request except GET /api/health needs the token (query
 * `key`, `ad_key` cookie or bearer). Calls that change sessions are logged
 * through `log`.
 */
export function createServer({ manager, poller, token, port = PORT, uploadsDir = UPLOADS_DIR, find = spotlightFind, log = console.error }) {
  uploadsDir = resolve(uploadsDir);
  const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_MAX });
  const eventClients = new Set();

  const server = http.createServer((req, res) => {
    const pathname = parseUrl(req)?.pathname;
    const mutating = (req.method === 'POST' || req.method === 'PATCH') && pathname?.startsWith('/api/sessions');
    const audit = {};
    if (mutating) res.on('finish', () => log(auditLine(req.method, pathname, audit, res.statusCode)));
    handle(req, res, audit).catch((err) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(`server: ${req.method} ${parseUrl(req)?.pathname ?? '-'}: ${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.destroy();
    });
  });

  function boundPort() {
    return server.address()?.port;
  }

  function hostAllowed(host) {
    const p = boundPort();
    return host === `127.0.0.1:${p}` || host === `localhost:${p}`;
  }

  function originAllowed(origin) {
    if (origin === undefined) return true;
    const p = boundPort();
    return origin === `http://127.0.0.1:${p}` || origin === `http://localhost:${p}`;
  }

  // Returns 'query' when the token came from ?key=, true for cookie/bearer, false otherwise.
  function authenticate(req, url) {
    if (tokenMatches(url.searchParams.get('key'), token)) return 'query';
    if (tokenMatches(cookieValue(req.headers.cookie, COOKIE), token)) return true;
    return tokenMatches(bearer(req.headers.authorization), token);
  }

  function parseUrl(req) {
    try {
      return new URL(req.url, 'http://localhost');
    } catch {
      return null;
    }
  }

  function apiError(err) {
    const status = ERROR_STATUS[err?.code];
    if (status) return new HttpError(status, err.message);
    return err;
  }

  // Fills `audit` with the id and name of the session a call acts on.
  async function handle(req, res, audit) {
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      throw new HttpError(403, 'Forbidden');
    }
    const url = parseUrl(req);
    if (!url) throw new HttpError(400, 'Bad request');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const auth = authenticate(req, url);
    if (!auth) {
      if (req.method === 'GET' && path === '/') return sendHtml(res, 401, SIGN_IN_PAGE);
      throw new HttpError(401, 'Unauthorized');
    }
    if (auth === 'query') {
      res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
      // Redirect so the token leaves the address bar and the history entry.
      if (req.method === 'GET' && path === '/') {
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'content-length': 0 });
        res.end();
        return;
      }
    }

    if (req.method === 'GET') {
      if (path === '/') return sendFile(res, join(PUBLIC_DIR, 'index.html'));
      if (path.startsWith('/static/')) {
        const file = publicPath(path.slice('/static/'.length));
        if (!file) throw new HttpError(404, 'Not found');
        return sendFile(res, file);
      }
      if (path.startsWith('/vendor/')) {
        const file = Object.hasOwn(VENDOR_FILES, path.slice('/vendor/'.length))
          ? VENDOR_FILES[path.slice('/vendor/'.length)]
          : null;
        if (!file) throw new HttpError(404, 'Not found');
        return sendFile(res, file);
      }
      if (path === '/api/sessions') return sendJson(res, 200, poller.current());
    }

    if (path === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.name === 'string') audit.name = body.name;
      let rec;
      try {
        rec = manager.start({
          name: body.name,
          cwd: body.cwd,
          agent: typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : null,
          model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
          brief: typeof body.brief === 'string' ? body.brief : '',
        });
      } catch (err) {
        throw apiError(err);
      }
      audit.id = rec.id;
      return sendJson(res, 201, rec);
    }

    // A browser never exposes a dropped file's real path, so find the original
    // by name, then keep only a file whose size and modified time match.
    if (path === '/api/locate' && req.method === 'POST') {
      const body = await readBody(req);
      const { name, size, lastModified } = body;
      if (typeof name !== 'string' || !name || name !== basename(name) || !Number.isFinite(size) || !Number.isFinite(lastModified)) {
        throw new HttpError(400, 'name, size and lastModified are required');
      }
      const matches = [];
      for (const candidate of await find(name)) {
        if (basename(candidate) !== name || candidate.startsWith(uploadsDir + sep)) continue;
        let stat;
        try {
          stat = statSync(candidate);
        } catch {
          continue;
        }
        if (stat.isFile() && stat.size === size && Math.abs(stat.mtimeMs - lastModified) <= LOCATE_MTIME_SLACK_MS) {
          matches.push({ candidate, mtimeMs: stat.mtimeMs });
        }
      }
      return sendJson(res, 200, { path: matches.length === 1 ? matches[0].candidate : null });
    }

    if (path === '/api/upload' && req.method === 'POST') {
      const id = url.searchParams.get('session');
      if (!id || !manager.get(id)) throw new HttpError(404, 'Session not found');
      const name = uploadName(req.headers['x-file-name']);
      const data = await readUpload(req);
      if (data.length === 0) throw new HttpError(400, 'Empty file');
      mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
      const file = join(uploadsDir, `${Date.now()}-${randomBytes(4).toString('hex')}-${name}`);
      writeFileSync(file, data, { mode: 0o600 });
      return sendJson(res, 201, { path: file });
    }

    const action = /^\/api\/sessions\/([^/]+)\/(stop|resume|dismiss)$/.exec(path);
    if (action && req.method === 'POST') {
      const [, id, verb] = action;
      audit.id = id;
      const name = manager.get(id)?.name;
      if (name !== undefined) audit.name = name;
      let result;
      try {
        if (verb === 'stop') manager.stop(id);
        else if (verb === 'resume') result = manager.resume(id);
        else manager.dismiss(id);
      } catch (err) {
        throw apiError(err);
      }
      return sendJson(res, 200, result ?? { ok: true });
    }

    const one = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (one && req.method === 'PATCH') {
      audit.id = one[1];
      const name = manager.get(one[1])?.name;
      if (name !== undefined) audit.name = name;
      const body = await readBody(req);
      try {
        manager.setGoal(one[1], typeof body.goal === 'string' ? body.goal : '');
      } catch (err) {
        throw apiError(err);
      }
      return sendJson(res, 200, manager.get(one[1]));
    }

    throw new HttpError(404, 'Not found');
  }

  function attachEvents(ws) {
    eventClients.add(ws);
    ws.on('close', () => eventClients.delete(ws));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'snapshot', sessions: poller.current() }));
  }

  function attachTerm(ws, id) {
    ws.on('error', () => {});
    let attachment;
    try {
      attachment = manager.attach(id, (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
    } catch {
      ws.close(4404, 'No such session');
      return;
    }
    ws.on('close', () => attachment.detach());
    // The first message is always the scrollback, empty or not, so the client
    // knows where the replay ends.
    ws.send(attachment.scrollback);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type === 'input' && typeof msg.data === 'string') {
        manager.write(id, msg.data);
      } else if (msg?.type === 'resize') {
        const { cols, rows } = msg;
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) {
          manager.resize(id, cols, rows);
        }
      }
    });
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const url = parseUrl(req);
    if (!url) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!authenticate(req, url)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const term = /^\/ws\/term\/([^/]+)$/.exec(url.pathname);
    if (url.pathname !== '/ws/events' && !term) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (term) attachTerm(ws, term[1]);
      else attachEvents(ws);
    });
  });

  const unsubscribe = poller.subscribe?.((sessions) => {
    const msg = JSON.stringify({ type: 'snapshot', sessions });
    for (const ws of eventClients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  });

  // Upgraded sockets keep an http.Server open, so close() ends them first.
  const closeHttp = server.close.bind(server);
  server.close = (cb) => {
    unsubscribe?.();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return closeHttp(cb);
  };

  server.listen(port, '127.0.0.1');
  return server;
}
