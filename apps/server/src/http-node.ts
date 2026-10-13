// A fetch handler behind node:http. This is all the Node server is: it turns
// each IncomingMessage into a Request, calls the handler, and writes the
// Response back, stream and all.
import http from 'node:http';
import { Readable } from 'node:stream';

export function serveFetch(handle: (request: Request) => Promise<Response>): http.Server {
  return http.createServer(async (req, res) => {
    // The upstream fetches are tied to the client: a closed connection aborts them.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) headers.append(name, one);
      }
      const method = req.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
        method,
        headers,
        signal: gone.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (method === 'HEAD' || !response.body) {
        await response.body?.cancel();
        res.end();
        return;
      }
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      // A mid-stream upstream failure (NFS hiccup, our own abort) must drop the
      // response, not crash the process via an unhandled 'error'.
      body.on('error', () => res.destroy());
      body.pipe(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('error');
    }
  });
}
