// The routes were written against node's ServerResponse: writeHead(status,
// headers), then end(body). Reply keeps that shape for them and turns it into a
// fetch Response, which is what both hosts want. A body that is already a
// stream (the audio from Jellyfin) goes through whole, never chunk by chunk
// in JavaScript, because in workerd touching the chunks costs memory.

export class Reply {
  #status = 200;
  #headers = new Headers();
  #body: string | Uint8Array | ReadableStream | null = null;
  #ended = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.#status = status;
    for (const [name, value] of Object.entries(headers)) this.#headers.set(name, value);
    return this;
  }

  end(body?: string | Uint8Array): this {
    if (this.#ended) throw new Error('the response was already ended');
    if (body !== undefined) {
      this.#body = body;
      // What node does for end(chunk), so a client sees a length and not chunked framing.
      if (!this.#headers.has('content-length')) {
        this.#headers.set('content-length', String(typeof body === 'string' ? new TextEncoder().encode(body).length : body.byteLength));
      }
    }
    this.#ended = true;
    return this;
  }

  /** Answers with a stream the caller does not read. */
  stream(body: ReadableStream | null): this {
    this.#body = body;
    this.#ended = true;
    return this;
  }

  get ended(): boolean {
    return this.#ended;
  }

  response(): Response {
    if (!this.#ended) throw new Error('no route ended the response');
    const empty = this.#status === 204 || this.#status === 304;
    return new Response(empty ? null : this.#body, { status: this.#status, headers: this.#headers });
  }
}
