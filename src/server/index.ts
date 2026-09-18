/**
 * Static file server for the game + the /api/decide endpoint that fronts Jev.
 *
 * The API key never leaves this process; the browser only ever sees decisions.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRequest, interpret } from '../shared/brain.js';
import type { DecideBody, DecideResult, HealthInfo, Snapshot } from '../shared/protocol.js';
import { createBackend, type JevBackend } from './jev.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const VERSION = '1.0.0';
const MAX_BODY = 256 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isSnapshot(value: unknown): value is Snapshot {
  return !!value && typeof value === 'object' && Array.isArray((value as Snapshot).targets);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, rel === '/' || rel === '' ? 'index.html' : rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${rel}\n\nDid you run "npm run build"?`);
  }
}

async function handleDecide(backend: JevBackend, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: DecideBody;
  try {
    body = JSON.parse(await readBody(req)) as DecideBody;
  } catch (err) {
    sendJson(res, 400, { error: `bad request body: ${(err as Error).message}` });
    return;
  }
  if (!isSnapshot(body.snapshot)) {
    sendJson(res, 422, { error: 'snapshot missing or malformed' });
    return;
  }

  const request = buildRequest(body.snapshot, backend.model);
  const { response, source, latencyMs, degraded } = await backend.call(request);
  const decision = interpret(
    body.snapshot,
    response,
    { source, latencyMs, snapshotAt: body.snapshotAt ?? 0 },
    body.policy ?? {},
  );
  if (degraded) decision.note = decision.note ? `${decision.note}; ${degraded}` : degraded;

  const result: DecideResult = { decision, request, response };
  sendJson(res, 200, result);
}

async function main(): Promise<void> {
  const backend = await createBackend();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health') {
      const health: HealthInfo = { source: backend.source, model: backend.model, version: VERSION };
      sendJson(res, 200, health);
      return;
    }

    if (url.pathname === '/api/decide') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      handleDecide(backend, req, res).catch((err: unknown) => {
        console.error('[decide]', err);
        sendJson(res, 500, { error: String(err) });
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    void serveStatic(req, res, url.pathname);
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  jev-fps  ->  http://${HOST}:${PORT}`);
    console.log(`  brain    ->  ${backend.source === 'jev' ? `Jev (${backend.model})` : 'local simulator (set TYPESAFE_API_KEY for the real thing)'}\n`);
  });
}

void main();
