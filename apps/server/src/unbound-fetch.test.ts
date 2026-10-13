import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TypeSafe, TypeSafeError } from './typesafe.ts';

// workerd's fetch throws when it is called with a `this` other than the global,
// as `this.fetchImpl(...)` did with the default; Node's does not, so stand one in.
test('the default fetch is called unbound, as workerd requires', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let calls = 0;
  globalThis.fetch = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls += 1;
    return Promise.resolve(new Response('bad request', { status: 400 }));
  } as typeof fetch;
  await assert.rejects(new TypeSafe('key').choices({}, { q: { question: 'x?', choices: ['a', 'b'] } } as never), TypeSafeError);
  assert.equal(calls, 1);
});
