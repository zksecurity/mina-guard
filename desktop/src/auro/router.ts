import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveRequest, rejectRequest, getPayload } from '../ipc.js';

const pageHtml = readFileSync(join(import.meta.dirname, 'page.html'), 'utf-8');

function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * Handles /auro/* requests. Returns true if handled, false to pass through.
 */
export function handleAuroRoute(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/auro/')) return false;

  if (req.method === 'GET' && url.pathname === '/auro/payload') {
    const id = url.searchParams.get('id');
    if (!id) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id' }));
      return true;
    }
    const payload = getPayload(id);
    if (payload === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request not found' }));
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
  }

  if (req.method === 'GET' && url.pathname !== '/auro/callback') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageHtml);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auro/callback') {
    readBody(req).then((body) => {
      const data = JSON.parse(body) as { id: string; result?: unknown; error?: string };

      if (data.error) {
        rejectRequest(data.id, data.error);
      } else {
        resolveRequest(data.id, data.result);
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((err) => {
      console.error('[auro] callback error:', err);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid callback' }));
    });
    return true;
  }

  return false;
}
