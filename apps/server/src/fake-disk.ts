// A stand-in for workerd's disk binding over a real folder, speaking the same
// HTTP: GET on a folder lists { name, type }, GET on a file streams it with
// Content-Length and Last-Modified, HEAD reads the same headers, PUT writes
// (creating folders), and names starting with a dot are refused. The tests
// run the file code against it, and the local differential run serves it over
// HTTP so a Worker can bind to it.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Fetcher } from './files.ts';

export function fakeDisk(root: string, options: { readOnly?: boolean } = {}): Fetcher {
  return {
    async fetch(input, init = {}) {
      const url = new URL(input);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.some((part) => part.startsWith('.') || part === '..')) return new Response('refused', { status: 403 });
      const target = path.join(root, ...parts);
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        if (options.readOnly) return new Response('read only', { status: 403 });
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, new Uint8Array(await new Response(init.body as ConstructorParameters<typeof Response>[0]).arrayBuffer()));
        return new Response(null, { status: 204 });
      }
      let info;
      try {
        info = statSync(target);
      } catch {
        return new Response('Not Found', { status: 404 });
      }
      const modified = { 'last-modified': info.mtime.toUTCString() };
      if (info.isDirectory()) {
        const entries = readdirSync(target, { withFileTypes: true })
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
        return new Response(method === 'HEAD' ? null : JSON.stringify(entries), { headers: { 'content-type': 'application/json', ...modified } });
      }
      const headers = { 'content-length': String(info.size), 'content-type': 'application/octet-stream', ...modified };
      return new Response(method === 'HEAD' ? null : readFileSync(target), { headers });
    },
  };
}
