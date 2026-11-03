import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { PORT } from './config.js';

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

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * HTTP API, static page and WebSockets for agent-desk, bound to 127.0.0.1.
 * Every request needs a local Host header and, when it carries an Origin, a
 * local Origin. Every request except GET /api/health needs the token (query
 * `key`, `ad_key` cookie or bearer).
 */
export function createServer({ manager, poller, token, port = PORT }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: BODY_MAX });
  const eventClients = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
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

  async function handle(req, res) {
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
      let rec;
      try {
        rec = manager.start({
          name: body.name,
          cwd: body.cwd,
          agent: typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : null,
          brief: typeof body.brief === 'string' ? body.brief : '',
        });
      } catch (err) {
        throw apiError(err);
      }
      return sendJson(res, 201, rec);
    }

    const action = /^\/api\/sessions\/([^/]+)\/(stop|resume|dismiss)$/.exec(path);
    if (action && req.method === 'POST') {
      const [, id, verb] = action;
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
    if (attachment.scrollback) ws.send(attachment.scrollback);
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
