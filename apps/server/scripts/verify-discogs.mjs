// Drives Discogs search and "add to library" in a real browser against the
// real server, with a stand-in for api.discogs.com (src/fake-discogs.ts), so
// it needs no Discogs token and never touches Discogs. Screenshots and a
// results.json land in data/discogs-verification.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFakeDiscogs } from '../src/fake-discogs.ts';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'data', 'discogs-verification');
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(path.join(evidence, 'run-'));
const fixture = path.join(scratch, 'spotify.db');
copyFileSync(path.join(root, 'data', 'dev-fixture.db'), fixture);
const TOKEN = 'verification-token-not-real';

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function startServer(name, discogs) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SPOTIFY_DB: fixture, JELLYFIN_URL: '', LISTENBRAINZ_TOKEN: '',
    DISCOGS_TOKEN: '', DISCOGS_CONSUMER_KEY: '', DISCOGS_CONSUMER_SECRET: '', ...discogs };
  for (const store of ['LIKES', 'PLAYLISTS', 'PROVENANCE', 'APP_PLAYS', 'UPGRADES', 'DISCOGS', 'LYRICS']) env[`${store}_DB`] = path.join(scratch, `${name}-${store}.db`);
  const child = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/tracks')).ok) break; } catch { /* starting */ }
    if (i > 150 || child.exitCode !== null) throw new Error(log);
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, child, log: () => log };
}

/**
 * The Discogs section laid out cleanly: cards in a grid that do not overlap,
 * every action inside its card, and no control or title clipped. Returns a
 * short description of the layout for the evidence file.
 */
async function assertTidy(page, label) {
  const report = await page.locator('section.discogs').evaluate((section) => {
    const box = (el) => el.getBoundingClientRect();
    const problems = [];
    const cards = [...section.querySelectorAll('.discogs-card')].filter(card => card.offsetParent);
    cards.forEach((card, i) => {
      const a = box(card);
      cards.slice(i + 1).forEach((other) => {
        const b = box(other);
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`overlap: ${card.textContent} / ${other.textContent}`);
      });
      for (const control of card.querySelectorAll('button, a, b')) {
        const c = box(control);
        if (c.left < a.left - 1 || c.right > a.right + 1 || c.bottom > a.bottom + 1) problems.push(`outside card: ${control.textContent}`);
        if (control.scrollWidth > control.clientWidth + 1 && getComputedStyle(control).overflow !== 'visible') problems.push(`clipped: ${control.textContent}`);
      }
    });
    if (section.scrollWidth > section.clientWidth + 1) problems.push('section scrolls sideways');
    const widths = [...new Set(cards.map(card => Math.round(box(card).width)))];
    return { problems, cards: cards.length, widths, panels: section.querySelectorAll('.discogs-panel').length };
  });
  assert.deepEqual(report.problems, [], `${label}: ${report.problems.join('; ')}`);
  return `${label}: ${report.cards} cards ${report.widths.join('/')}px wide, ${report.panels} open panel(s), no overlap or clipping`;
}

const fake = await startFakeDiscogs();
const servers = [];
const checks = [];
let browser;
try {
  const live = await startServer('configured', { DISCOGS_TOKEN: TOKEN, DISCOGS_API_URL: fake.url });
  servers.push(live);
  browser = await chromium.launch();

  // Desktop width: the whole journey, from nothing to the album in the library.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const discogsCalls = [];
    page.on('request', r => { if (r.url().includes('/database/') || r.url().startsWith(fake.url + '/m')) discogsCalls.push(r.url()); });
    await page.goto(live.base + '/liked');
    await page.getByRole('heading', { name: 'Liked songs', exact: true }).waitFor();
    const input = page.getByRole('searchbox', { name: 'Search music' });
    await input.fill('Quiet Ferns');
    await page.getByText('No music found for "Quiet Ferns".').waitFor();
    await page.getByRole('button', { name: 'Search Discogs' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-1-offer-1440.png'), fullPage: true });

    await page.getByRole('button', { name: 'Search Discogs' }).click();
    await page.getByRole('button', { name: 'Add Hollow Lanterns to library' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add The Quiet Ferns to library' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Add Demo Tape to library' }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'discogs-2-results-1440.png'), fullPage: true });

    await page.getByRole('button', { name: 'Show tracks of Hollow Lanterns' }).click();
    const tracks = page.getByRole('region', { name: 'Tracks of Hollow Lanterns' });
    await tracks.getByText('Lantern Song').waitFor();
    assert.equal(await tracks.locator('li').count(), 4);
    await page.screenshot({ path: path.join(evidence, 'discogs-3-tracklist-1440.png'), fullPage: true });

    await page.getByRole('button', { name: 'Add Hollow Lanterns to library' }).click();
    await page.getByRole('link', { name: 'Open Hollow Lanterns in your library' }).waitFor();
    // The artist came in with the album, and the card says so after the refresh.
    await page.getByRole('link', { name: 'Open The Quiet Ferns in your library' }).waitFor();
    // Local results above update without a reload: the band and album are ours now.
    const results = page.locator('#search-results');
    await results.getByRole('link', { name: 'The Quiet Ferns', exact: true }).waitFor();
    await results.locator('.al-grid').getByRole('link', { name: 'Hollow Lanterns' }).waitFor();
    await results.getByRole('heading', { name: /^Songs/ }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-4-added-1440.png'), fullPage: true });
    // Covers come from Discogs' image host through the server's answers, and load.
    const section = page.locator('section.discogs');
    await page.waitForFunction(() => [...document.querySelectorAll('section.discogs img')].every(img => img.complete));
    assert(await section.evaluate(el => [...el.querySelectorAll('img')].every(img => img.naturalWidth > 0)), 'every Discogs cover loads');
    await section.screenshot({ path: path.join(evidence, 'discogs-4-added-section-1440.png') });
    checks.push(await assertTidy(page, 'Layout 1440px after add, tracklist open'));

    // The artist's discography on Discogs shows the added album as held.
    await page.getByRole('button', { name: 'Show albums by The Quiet Ferns' }).click();
    const discography = page.getByRole('region', { name: 'Albums by The Quiet Ferns' });
    await discography.getByRole('link', { name: 'Open Hollow Lanterns in your library' }).waitFor();
    await discography.getByRole('button', { name: 'Add Second Bloom to library' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-5-discography-1440.png'), fullPage: true });
    checks.push(await assertTidy(page, 'Layout 1440px with discography open'));

    await page.getByRole('link', { name: 'Open Hollow Lanterns in your library' }).first().click();
    await page.getByRole('heading', { name: 'Hollow Lanterns', exact: true }).waitFor();
    await page.getByText('Lantern Song').first().waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-6-album-page-1440.png'), fullPage: true });

    // In the library pages, by in-app navigation.
    await page.locator('#nav a[href="/artists"]').first().click();
    await page.getByRole('link', { name: 'The Quiet Ferns' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-7-artists-1440.png'), fullPage: true });
    await page.goto(live.base + '/albums');
    await page.getByRole('heading', { name: /^Saved/ }).waitFor();
    await page.locator('.al-grid').first().getByRole('link', { name: 'Hollow Lanterns' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-8-albums-1440.png'), fullPage: true });

    // Rate limiting is explained; local search still answers.
    await input.fill('ratelimit');
    await page.getByRole('button', { name: 'Search Discogs' }).click();
    await page.getByRole('alert').filter({ hasText: 'Discogs rate limit reached. Try again in 7 seconds. Your library search still works.' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-9-rate-limited-1440.png'), fullPage: true });
    await input.fill('outage');
    await page.getByRole('button', { name: 'Search Discogs' }).click();
    await page.getByRole('alert').filter({ hasText: 'Discogs is unavailable right now. Your library search still works.' }).waitFor();
    await input.fill('Hollow');
    await page.locator('#search-results .al-grid').getByRole('link', { name: 'Hollow Lanterns' }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    // The browser never talked to Discogs; the server did, with the token.
    assert.deepEqual(discogsCalls, []);
    assert(fake.requests.length > 0 && fake.requests.every(r => r.authorization === `Discogs token=${TOKEN}`));
    checks.push('Browser 1440px: no local result, Discogs offer, search, tracklist, add album (artist added with it), local search updates without reload, discography shows held album, album page, Artists and Albums pages, rate-limit and outage messages, local search still works, browser never calls Discogs');
    await page.close();
  }

  // Phone widths: layout and adding from an artist's discography.
  for (const width of [390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(live.base + '/liked');
    await page.getByRole('heading', { name: 'Liked songs', exact: true }).waitFor();
    // On a phone the field folds into a search button in the top bar.
    const toggle = page.locator('.search-toggle');
    if (await toggle.isVisible()) await toggle.click();
    const input = page.getByRole('searchbox', { name: 'Search music' });
    await input.fill('Ferns');
    await page.getByRole('button', { name: 'Search Discogs' }).click();
    await page.getByRole('link', { name: 'Open The Quiet Ferns in your library' }).waitFor();
    await page.getByRole('button', { name: 'Show tracks of Second Bloom' }).click();
    await page.getByRole('region', { name: 'Tracks of Second Bloom' }).getByText('Slow Rain').waitFor();
    if (width === 390) {
      await page.getByRole('button', { name: 'Add Second Bloom to library' }).click();
      await page.getByRole('link', { name: 'Open Second Bloom in your library' }).waitFor();
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}`);
    checks.push(await assertTidy(page, `Layout ${width}px`));
    await page.screenshot({ path: path.join(evidence, `discogs-phone-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    checks.push(`Browser ${width}px: Discogs results, tracklist${width === 390 ? ', add Second Bloom' : ''}, no horizontal scroll`);
    await page.close();
  }

  // The same data through the API: twice added is still once.
  const albums = await (await fetch(live.base + '/api/albums')).json();
  assert.equal(albums.filter(a => a.id === 'discogs-master:501').length, 1);
  assert.equal(albums.filter(a => a.id === 'discogs-master:502').length, 1);
  const again = await (await fetch(live.base + '/api/discogs/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'master', id: 501 }) })).json();
  assert.equal(again.added, false);
  const upgrades = await (await fetch(live.base + '/api/upgrades')).json();
  assert.deepEqual(upgrades.jobs, [], 'adding queued no downloads');
  checks.push('HTTP: each added album listed once, repeat add is a no-op, nothing queued for download');

  // A server with no Discogs credentials says so and keeps local search.
  const bare = await startServer('unconfigured', { DISCOGS_API_URL: fake.url });
  servers.push(bare);
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(bare.base + '/liked');
    const input = page.getByRole('searchbox', { name: 'Search music' });
    await input.fill('Hollow');
    await page.locator('#search-results .al-grid').getByRole('link', { name: 'Hollow Lanterns' }).waitFor();
    await page.getByRole('button', { name: 'Search Discogs' }).click();
    await page.getByRole('alert').filter({ hasText: 'Discogs is not configured on this server. Whoever runs the server can add a Discogs token to switch it on. Your library search still works.' }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'discogs-10-not-configured-1440.png'), fullPage: true });
    checks.push('Browser 1440px, no credentials: local search finds the added album, Discogs section explains it is not configured');
    await page.close();
  }
  for (const server of servers) assert(!server.log().includes(TOKEN), 'the token never reaches the server log');
  writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(checks.join('\n'));
} finally {
  await browser?.close();
  for (const server of servers) {
    server.child.kill();
    if (server.child.exitCode === null) await once(server.child, 'exit');
  }
  writeFileSync(path.join(evidence, 'server.log'), servers.map(s => s.log()).join('\n---\n'));
  await fake.close();
}
