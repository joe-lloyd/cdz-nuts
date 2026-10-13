// The node:http adapter, Reply, and the UI manifest: the thin pieces both hosts
// stand on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { serveFetch } from './http-node.ts';
import { Reply } from './reply.ts';
import { makeUi } from './ui.ts';
import { nodeUi } from './ui-node.ts';

async function listen(handle: (request: Request) => Promise<Response>) {
  const server = serveFetch(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('the adapter passes method, path, headers and body in, and status, headers and body out', async () => {
  const seen: { method: string; url: string; range: string | null; body: string }[] = [];
  const { base, close } = await listen(async (request) => {
    seen.push({ method: request.method, url: new URL(request.url).pathname + new URL(request.url).search, range: request.headers.get('range'), body: await request.text() });
    return new Response('hello', { status: 201, headers: { 'x-answer': 'yes', 'content-type': 'text/plain' } });
  });
  try {
    const response = await fetch(`${base}/a/b?c=d%20e`, { method: 'POST', body: 'payload', headers: { range: 'bytes=1-2' } });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-answer'), 'yes');
    assert.equal(await response.text(), 'hello');
    assert.deepEqual(seen, [{ method: 'POST', url: '/a/b?c=d%20e', range: 'bytes=1-2', body: 'payload' }]);
  } finally {
    await close();
  }
});

test('HEAD answers the headers and no body, and a streamed body arrives whole', async () => {
  const big = 'x'.repeat(3_000_000);
  const { base, close } = await listen(async (request) => (request.method === 'HEAD'
    ? new Response(null, { headers: { 'content-length': String(big.length) } })
    : new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big.slice(0, 1_000_000))); c.enqueue(new TextEncoder().encode(big.slice(1_000_000))); c.close(); } }))));
  try {
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(big.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await (await fetch(`${base}/`)).text()).length, big.length);
  } finally {
    await close();
  }
});

test('a client that goes away aborts the request signal, so an upstream fetch can stop', async () => {
  let aborted!: () => void;
  const gone = new Promise<void>((resolve) => { aborted = resolve; });
  const { base, close } = await listen(async (request) => {
    request.signal.addEventListener('abort', () => aborted());
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('first')); } }));
  });
  try {
    const controller = new AbortController();
    const response = await fetch(`${base}/`, { signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await Promise.race([gone, new Promise((_, reject) => setTimeout(() => reject(new Error('the signal never aborted')), 3_000))]);
  } finally {
    await close();
  }
});

test('a handler that throws gets a 500 and the server keeps answering', async () => {
  let calls = 0;
  const { base, close } = await listen(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return new Response('fine'); });
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal((await fetch(`${base}/`)).status, 500);
    assert.equal(await (await fetch(`${base}/`)).text(), 'fine');
  } finally {
    console.error = log;
    await close();
  }
});

test('Reply keeps the writeHead/end shape and gives a length like node does; no body for 204', async () => {
  const text = new Reply().writeHead(404, { 'content-type': 'text/plain' }).end('café');
  const response = text.response();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-length'), '5', 'bytes, not characters');
  assert.equal(await response.text(), 'café');
  assert.equal(new Reply().writeHead(204).end().response().body, null);
  assert.throws(() => new Reply().response(), /no route ended/);
  assert.throws(() => new Reply().end('a').end('b'), /already ended/);
  const stream = new ReadableStream();
  assert.equal(new Reply().writeHead(206, { 'content-length': '9' }).stream(stream).response().headers.get('content-length'), '9');
});

test('the UI digest is the sha256 of every file the manifest names, in basename order, each preceded by its name', async () => {
  const ui = await nodeUi();
  const dir = path.join(import.meta.dirname, '..', '..', '..', 'packages', 'ui');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'routes.json'), 'utf8')) as { document: { file: string }; static: Record<string, { file: string }> };
  const files = [manifest.document.file, ...Object.values(manifest.static).map((e) => e.file)]
    .map((file) => [path.basename(file), file] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  for (const [name, file] of files) { hash.update(name); hash.update(readFileSync(path.join(dir, file))); }
  assert.equal(await ui.digest(), hash.digest('hex'));
});

test('the UI serves a manifest from any reader, and says which url is the document', async () => {
  const ui = makeUi(
    { document: { urls: ['/', '/index.html'], file: 'public/index.html', type: 'text/html', cacheControl: 'no-cache' }, static: { '/app.js': { file: 'public/app.js', type: 'text/javascript', cacheControl: 'no-cache' } } },
    async (file) => (file === 'public/missing.js' ? null : new TextEncoder().encode(`bytes of ${file}`)),
  );
  assert.deepEqual([...ui.documentUrls], ['/', '/index.html']);
  assert.equal(new TextDecoder().decode((await ui.asset('/app.js')!.read())!), 'bytes of public/app.js');
  assert.equal(ui.asset('/constructor'), undefined, 'inherited object keys are not assets');
  assert.equal(ui.asset('/nope.js'), undefined);
});
