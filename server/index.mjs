#!/usr/bin/env node
/**
 * FiberLens reference sync server (zero dependencies).
 *
 *   FIBERLENS_TOKEN=secret PORT=8787 node server/index.mjs
 *
 * Stores an append-only change log (JSON lines) and serves it back by cursor.
 * Payloads may be end-to-end encrypted by the clients (field `enc`); the server never
 * needs to read them. Put it behind HTTPS (nginx/Caddy) in production.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = +(process.env.PORT ?? 8787);
const TOKEN = process.env.FIBERLENS_TOKEN ?? '';
const DATA = process.env.FIBERLENS_DATA ?? path.resolve('fiberlens-sync-data');
const LOG = path.join(DATA, 'changes.jsonl');
const MAX_BODY = 512 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

/** in-memory index rebuilt from the log at start */
let changes = [];
let seq = 0;
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line); changes.push(c); seq = Math.max(seq, c.seq); } catch { /* skip corrupt line */ }
  }
}
console.log(`FiberLens sync: ${changes.length} changes loaded, seq=${seq}`);

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.url === '/health') return send(res, 200, { ok: true, seq, changes: changes.length });
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
  try {
    if (req.method === 'POST' && req.url === '/sync/push') {
      const { changes: incoming = [] } = await readBody(req);
      const out = fs.createWriteStream(LOG, { flags: 'a' });
      for (const c of incoming) {
        if (!c || typeof c.table !== 'string' || typeof c.rowId !== 'string') continue;
        const row = { ...c, seq: ++seq, receivedAt: Date.now() };
        changes.push(row);
        out.write(JSON.stringify(row) + '\n');
      }
      out.end();
      return send(res, 200, { ok: true, seq });
    }
    if (req.method === 'POST' && req.url === '/sync/pull') {
      const { since, projectIds = [] } = await readBody(req);
      const from = +(since ?? 0) || 0;
      const allow = new Set(projectIds);
      // latest change per (table,rowId) after the cursor
      const latest = new Map();
      for (const c of changes) {
        if (c.seq <= from) continue;
        if (c.projectId && allow.size && !allow.has(c.projectId) && c.table !== 'projects') continue;
        latest.set(`${c.table}|${c.rowId}`, c);
      }
      return send(res, 200, { changes: [...latest.values()].sort((a, b) => a.seq - b.seq), cursor: String(seq) });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`FiberLens sync server on :${PORT}${TOKEN ? ' (token required)' : ' (NO TOKEN — development only)'}`));
