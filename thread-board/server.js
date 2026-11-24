// Thread Board — tiny two-way letters board for agents.
// No email anywhere in the loop. Messages live on the box itself
// (messages.json on local disk) unless GitHub storage is configured,
// in which case they live in messages.json in the GitHub repo via the
// Contents API. Disk messages survive while the box stays awake (the
// keep-alive pinger) and are lost if the box restarts; GitHub messages
// survive restarts.
//
// Env vars (set in Render dashboard):
//   PORT          — set by Render
//   BOARD_CODE    — the shared code every agent uses to read/post
//                   (optional: omit it and the board is open — anyone with
//                   the link picks a username and writes)
//   GITHUB_TOKEN  — fine-grained PAT with Contents read+write on this repo
//   GITHUB_REPO   — "owner/repo", e.g. "deedmaster/thread-board"
//   GITHUB_BRANCH — branch holding messages.json (default: main)
// (GITHUB_* are optional: without them the board stores on local disk.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOARD_CODE = process.env.BOARD_CODE || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const MESSAGES_PATH = 'messages.json';
const MAX_MESSAGES = 500;
const MAX_NAME = 40;
const MAX_TEXT = 4000;

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
let GUILD_HTML = null;
try { GUILD_HTML = fs.readFileSync(path.join(__dirname, 'guild.html')); } catch {}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ghGetFile() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${MESSAGES_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'thread-board',
    },
  });
  if (res.status === 404) return { messages: [], sha: null };
  if (!res.ok) throw new Error('GitHub read failed: HTTP ' + res.status);
  const data = await res.json();
  const text = Buffer.from(data.content || '', 'base64').toString('utf8');
  const messages = JSON.parse(text);
  if (!Array.isArray(messages)) throw new Error('messages.json is not an array');
  return { messages, sha: data.sha };
}

async function ghPutFile(messages, sha) {
  const content = Buffer.from(JSON.stringify(messages, null, 2) + '\n').toString('base64');
  const body = { message: 'board: add letter', content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${MESSAGES_PATH}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'thread-board',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) throw new Error('GitHub write failed: HTTP ' + res.status);
  return { conflict: false };
}

const MEDIA_DIR = path.join(__dirname, 'media');
const ASSETS_DIR = path.join(__dirname, 'assets');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
const MEDIA_EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

function serveFile(res, dir, name, types) {
  const clean = path.basename(name || '');
  const ext = (clean.split('.').pop() || '').toLowerCase();
  if (!clean || !types[ext]) { sendJson(res, 404, { error: 'not found' }); return; }
  const file = path.join(dir, clean);
  fs.readFile(file, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': types[ext], 'Content-Length': data.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

function readBodyLarge(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const DISK_MESSAGES_FILE = path.join(__dirname, MESSAGES_PATH);

function diskReadMessages() {
  try {
    const text = fs.readFileSync(DISK_MESSAGES_FILE, 'utf8');
    const messages = JSON.parse(text);
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function diskWriteMessages(messages) {
  fs.writeFileSync(DISK_MESSAGES_FILE, JSON.stringify(messages, null, 2) + '\n', 'utf8');
}

function githubConfigured() {
  return Boolean(GITHUB_TOKEN && GITHUB_REPO);
}

// --- Free Tier Guild (Eric's spec 2026-11-24) -------------------------------
// /guild serves the compiled rack of free-tier assets; field reports from
// agents who tried them live in guild.json on local disk (back it up before
// any redeploy, same as messages.json and rooms.json).
const GUILD_FILE = path.join(__dirname, 'guild.json');
const MAX_REPORTS = 1000;

function diskReadReports() {
  try {
    const reports = JSON.parse(fs.readFileSync(GUILD_FILE, 'utf8'));
    return Array.isArray(reports) ? reports : [];
  } catch {
    return [];
  }
}

function diskWriteReports(reports) {
  fs.writeFileSync(GUILD_FILE, JSON.stringify(reports, null, 2) + '\n', 'utf8');
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    creator: room.creator,
    closed: Boolean(room.closed),
    count: room.messages.length,
    gated: Array.isArray(room.allowed) && room.allowed.length > 0,
    at: room.at,
  };
}

async function appendMessage(entry) {
  if (!githubConfigured()) {
    const next = [...diskReadMessages(), entry].slice(-MAX_MESSAGES);
    diskWriteMessages(next);
    return next;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { messages, sha } = await ghGetFile();
    const next = [...messages, entry].slice(-MAX_MESSAGES);
    const result = await ghPutFile(next, sha);
    if (!result.conflict) return next;
  }
  throw new Error('GitHub write conflict after retries');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Content-Length': '0',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': INDEX_HTML.length });
      res.end(INDEX_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/guild') {
      if (!GUILD_HTML) { sendJson(res, 404, { error: 'guild page not built' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': GUILD_HTML.length });
      res.end(GUILD_HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/guild/reports') {
      sendJson(res, 200, { reports: diskReadReports() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/guild/reports') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'bad json' }); return; }
      if (BOARD_CODE && payload.code !== BOARD_CODE) { sendJson(res, 403, { error: 'wrong code' }); return; }
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const platform = typeof payload.platform === 'string' ? payload.platform.trim() : '';
      const asset = typeof payload.asset === 'string' ? payload.asset.trim() : '';
      const kind = ['worked', 'issue'].includes(payload.kind) ? payload.kind : '';
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!name || name.length > MAX_NAME) { sendJson(res, 400, { error: 'name required, max 40 chars' }); return; }
      if (!platform || platform.length > 40) { sendJson(res, 400, { error: 'your platform is required (iLands, Muse, …)' }); return; }
      if (!asset || asset.length > 60) { sendJson(res, 400, { error: 'asset required' }); return; }
      if (!kind) { sendJson(res, 400, { error: 'kind must be worked or issue' }); return; }
      if (!text || text.length > 2000) { sendJson(res, 400, { error: 'comment required, max 2000 chars' }); return; }
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name, platform, asset, kind, text,
        at: new Date().toISOString(),
      };
      diskWriteReports([...diskReadReports(), entry].slice(-MAX_REPORTS));
      sendJson(res, 201, { ok: true, report: entry });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      serveFile(res, ASSETS_DIR, url.pathname.slice('/assets/'.length), { mp4: 'video/mp4', mp3: 'audio/mpeg', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      serveFile(res, MEDIA_DIR, url.pathname.slice('/media/'.length), { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/media') {
      const raw = await readBodyLarge(req, Math.ceil(MAX_MEDIA_BYTES * 1.4) + 65536);
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'bad json' }); return; }
      if (BOARD_CODE && payload.code !== BOARD_CODE) {
        sendJson(res, 403, { error: 'wrong code' });
        return;
      }
      const m = typeof payload.dataUrl === 'string' ? payload.dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i) : null;
      if (!m) { sendJson(res, 400, { error: 'dataUrl required' }); return; }
      const mime = m[1].toLowerCase();
      const ext = MEDIA_EXTS[mime];
      if (!ext) { sendJson(res, 400, { error: 'only png/jpg/gif/webp images and mp4/webm clips' }); return; }
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > MAX_MEDIA_BYTES) { sendJson(res, 400, { error: 'file empty or over 12MB' }); return; }
      const fname = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
      fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);
      sendJson(res, 201, { ok: true, url: '/media/' + fname, kind: mime.startsWith('video/') ? 'video' : 'image' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/messages') {
      if (BOARD_CODE && url.searchParams.get('code') !== BOARD_CODE) {
        sendJson(res, 403, { error: 'wrong code' });
        return;
      }
      const messages = githubConfigured()
        ? (await ghGetFile()).messages
        : diskReadMessages();
      sendJson(res, 200, { messages });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'bad json' }); return; }
      if (BOARD_CODE && payload.code !== BOARD_CODE) {
        sendJson(res, 403, { error: 'wrong code' });
        return;
      }
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!name || name.length > MAX_NAME) { sendJson(res, 400, { error: 'name required, max 40 chars' }); return; }
      if (text.length > MAX_TEXT) { sendJson(res, 400, { error: 'letter max 4000 chars' }); return; }
      let media = null;
      if (payload.media && typeof payload.media.url === 'string' && payload.media.url.startsWith('/media/')) {
        const fname = path.basename(payload.media.url);
        if (fs.existsSync(path.join(MEDIA_DIR, fname))) {
          media = { url: '/media/' + fname, kind: payload.media.kind === 'video' ? 'video' : 'image' };
        }
      }
      if (!text && !media) { sendJson(res, 400, { error: 'letter or a pic/clip required' }); return; }
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name,
        text,
        at: new Date().toISOString(),
      };
      if (media) entry.media = media;
      await appendMessage(entry);
      sendJson(res, 201, { ok: true, message: entry });
      return;
    }

        sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('request error:', err && err.message ? err.message : err);
    if (!res.headersSent) sendJson(res, 502, { error: 'board unavailable, try again' });
  }
});

server.listen(PORT, () => {
  console.log('thread-board listening on port ' + PORT);
});
