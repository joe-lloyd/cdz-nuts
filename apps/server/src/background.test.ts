import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackground } from './background.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a job first runs after its delay, then every period, and a one-off job runs once', async () => {
  const ran: string[] = [];
  const bg = createBackground([
    { name: 'drain', firstAfterMs: 10_000, everyMs: 300_000, run: () => { ran.push('drain'); } },
    { name: 'index', firstAfterMs: 0, everyMs: null, run: () => { ran.push('index'); } },
  ], 1_000);
  bg.tick(1_000); await settle();
  assert.deepEqual(ran, ['index']);
  bg.tick(10_999); await settle();
  assert.deepEqual(ran, ['index']);
  bg.tick(11_000); await settle();
  bg.tick(12_000); await settle();
  assert.deepEqual(ran, ['index', 'drain']);
  bg.tick(311_000); await settle();
  assert.deepEqual(ran, ['index', 'drain', 'drain']);
});

test('a job that is still running is not started again, and one that throws does not stop the rest', async () => {
  let release!: () => void;
  const ran: string[] = [];
  const bg = createBackground([
    { name: 'slow', firstAfterMs: 0, everyMs: 1_000, run: () => new Promise<void>((r) => { ran.push('slow'); release = r; }) },
    { name: 'broken', firstAfterMs: 0, everyMs: 1_000, run: () => { ran.push('broken'); throw new Error('no'); } },
  ], 0);
  const errors: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    bg.tick(0); await settle();
    bg.tick(5_000); await settle();
    assert.deepEqual(ran, ['slow', 'broken', 'broken'], 'slow is still running at 5 s, broken ran again');
    release(); await settle();
    bg.tick(10_000); await settle();
    assert.deepEqual(ran, ['slow', 'broken', 'broken', 'slow', 'broken']);
    assert.equal(errors.length, 3);
  } finally {
    console.error = log;
  }
});
