// A stand-in for api.discogs.com, for tests and headless verification.
//
// It answers the five endpoints the app calls with bodies shaped like the real
// API's (trimmed to the fields that are read), for one fictional band. Two
// query words reproduce Discogs pushing back: "ratelimit" answers 429 and
// "outage" answers 503. Point the server at it with DISCOGS_API_URL. Cover
// images are drawn by the same server, so a browser run shows real artwork.
import http from 'node:http';
import { once } from 'node:events';

const BAND = { id: 77, name: 'The Quiet Ferns (2)' };

/** The catalogue, with image URLs pointing back at the fake server. */
function catalogue(ART: string) {
const MASTERS: Record<number, Record<string, unknown>> = {
  501: {
    id: 501, title: 'Hollow Lanterns', year: 2019, main_release: 9001,
    artists: [{ ...BAND, anv: '', join: '' }], genres: ['Rock'], styles: ['Shoegaze', 'Dream Pop'],
    images: [{ type: 'primary', uri: `${ART}/hollow-lanterns.jpg`, uri150: `${ART}/hollow-lanterns-150.jpg` }],
    tracklist: [
      { position: '1', title: 'Moth Light', duration: '4:05', type_: 'track' },
      { position: '2', title: 'Undertow', duration: '5:12', type_: 'track' },
      { position: '3', title: 'Paper Boats', duration: '3:48', type_: 'track' },
      { position: '4', title: 'Lantern Song', duration: '6:01', type_: 'track' },
    ],
  },
  502: {
    id: 502, title: 'Second Bloom', year: 2022, main_release: 9003,
    artists: [{ ...BAND, anv: '', join: '' }], genres: ['Rock'], styles: ['Shoegaze'],
    images: [{ type: 'primary', uri: `${ART}/second-bloom.jpg` }],
    tracklist: [
      { position: '1', title: 'Green Again', duration: '3:30', type_: 'track' },
      { position: '2', title: 'Slow Rain', duration: '4:44', type_: 'track' },
    ],
  },
};

// Another band's album that credits a solo singer (91) on one track and a
// session player (92) on another: who a track credit puts in the library.
MASTERS[601] = {
  id: 601, title: 'Borrowed Light', year: 2021, main_release: 9601,
  artists: [{ id: 88, name: 'Night Lanterns', anv: '', join: '' }], genres: ['Rock'], styles: ['Post-Rock'],
  images: [{ type: 'primary', uri: `${ART}/borrowed-light.jpg` }],
  tracklist: [
    { position: '1', title: 'Low Beacon', duration: '4:10', type_: 'track' },
    { position: '2', title: 'Quill Song', duration: '3:55', type_: 'track', artists: [{ id: 91, name: 'Mara Quill', anv: '', join: '' }] },
    { position: '3', title: 'Brass Interlude', duration: '1:40', type_: 'track', artists: [{ id: 92, name: 'Session Horn', anv: '', join: '' }] },
    // A guest whose own album is on disk (see discogs-routes.test.ts).
    { position: '4', title: 'Harbour Hymn', duration: '2:20', type_: 'track', artists: [{ id: 93, name: 'Low Tide Choir', anv: '', join: '' }] },
  ],
};

const ARTISTS: Record<number, Record<string, unknown>> = {
  77: { id: 77, name: BAND.name, profile: 'A fictional band for tests.', images: [{ type: 'primary', uri: `${ART}/ferns.jpg` }] },
  88: { id: 88, name: 'Night Lanterns', profile: 'A fictional band for tests.', images: [] },
  91: { id: 91, name: 'Mara Quill', profile: 'A fictional singer for tests.', images: [{ type: 'primary', uri: `${ART}/mara-quill.jpg` }] },
  92: { id: 92, name: 'Session Horn', profile: 'A fictional session player for tests.', images: [] },
  93: { id: 93, name: 'Low Tide Choir', profile: 'A fictional choir for tests.', images: [] },
};

const RELEASES: Record<number, Record<string, unknown>> = {
  9001: { ...MASTERS[501], id: 9001, master_id: 501, released: '2019-04-12', labels: [{ name: 'Fern Records', catno: 'FERN-001' }], formats: [{ name: 'CD', qty: '1', descriptions: ['Album'] }] },
  9003: { ...MASTERS[502], id: 9003, master_id: 502, released: '2022-09-02', labels: [{ name: 'Fern Records', catno: 'FERN-007' }], formats: [{ name: 'CD', qty: '1', descriptions: ['Album'] }] },
  9002: {
    id: 9002, master_id: 0, title: 'Demo Tape', year: 2017, released: '2017-00-00',
    artists: [{ ...BAND, anv: '', join: '' }], genres: ['Rock'], styles: [],
    labels: [{ name: 'Not On Label', catno: 'none' }], formats: [{ name: 'Cassette', qty: '1', descriptions: ['EP'] }],
    images: [],
    tracklist: [{ position: 'A1', title: 'First Fern', duration: '2:58', type_: 'track' }, { position: 'B1', title: 'Basement', duration: '', type_: 'track' }],
  },
};

const hit = (type: string, id: number, title: string, extra: Record<string, unknown> = {}) => ({
  id, type, title, thumb: `${ART}/${id}-thumb.jpg`, cover_image: `${ART}/${id}.jpg`,
  resource_url: `https://api.discogs.com/${type}s/${id}`, uri: `/${type}/${id}`, ...extra,
});

function search(q: string, type: string): Record<string, unknown>[] {
  const term = q.toLowerCase();
  // The session player credited on one track of Borrowed Light.
  if (term.includes('session')) return type === 'artist' ? [hit('artist', 92, 'Session Horn')] : [];
  if (term.includes('choir')) return type === 'artist' ? [hit('artist', 93, 'Low Tide Choir')] : [];
  if (!['quiet', 'ferns', 'lantern', 'bloom'].some((word) => term.includes(word))) return [];
  if (type === 'artist') return [hit('artist', 77, BAND.name)];
  if (type === 'master') {
    return [
      hit('master', 501, `${BAND.name} - Hollow Lanterns`, { year: '2019', genre: ['Rock'], style: ['Shoegaze'], format: ['CD', 'Album'], master_id: 501 }),
      hit('master', 502, `${BAND.name} - Second Bloom`, { year: '2022', genre: ['Rock'], style: ['Shoegaze'], format: ['CD', 'Album'], master_id: 502 }),
    ];
  }
  return [
    hit('release', 9001, `${BAND.name} - Hollow Lanterns`, { year: '2019', master_id: 501, format: ['CD', 'Album'], label: ['Fern Records'], catno: 'FERN-001' }),
    hit('release', 9002, `${BAND.name} - Demo Tape`, { year: '2017', master_id: 0, format: ['Cassette', 'EP'], label: ['Not On Label'], catno: 'none', cover_image: '' }),
  ];
}

return { MASTERS, RELEASES, ARTISTS, search, ART };
}

const COLOURS = ['#2f6b4f', '#7a3e8e', '#b5652b', '#2b5d8f', '#8f2b45'];

/** A square cover with the image's name on it, for screenshots. */
function cover(name: string): string {
  const label = name.replace(/\.jpg$/, '').replace(/-/g, ' ');
  const colour = COLOURS[[...label].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % COLOURS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">`
    + `<rect width="300" height="300" fill="${colour}"/><circle cx="150" cy="130" r="70" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="6"/>`
    + `<text x="150" y="255" fill="#fff" font-family="sans-serif" font-size="22" text-anchor="middle">${label}</text></svg>`;
}

export interface FakeDiscogs {
  url: string;
  /** Every request, with the authorization header it carried. */
  requests: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

export async function startFakeDiscogs(): Promise<FakeDiscogs> {
  const requests: FakeDiscogs['requests'] = [];
  let data = catalogue('');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const { MASTERS, RELEASES, ARTISTS, search, ART } = data;
    if (url.pathname.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(cover(url.pathname.slice(5)));
      return;
    }
    requests.push({ path: url.pathname + url.search, authorization: req.headers.authorization });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('ratelimit')) return send(429, { message: 'You are making requests too quickly.' }, { 'retry-after': '7' });
    if (q.includes('outage')) return send(503, { message: 'Service Unavailable' });
    if (url.pathname === '/database/search') {
      const results = search(q, url.searchParams.get('type') ?? '');
      return send(200, { pagination: { page: 1, pages: 1, items: results.length, per_page: 20 }, results });
    }
    let match = /^\/masters\/(\d+)$/.exec(url.pathname);
    if (match) return MASTERS[Number(match[1])] ? send(200, MASTERS[Number(match[1])]) : send(404, { message: 'Master Release not found.' });
    match = /^\/releases\/(\d+)$/.exec(url.pathname);
    if (match) return RELEASES[Number(match[1])] ? send(200, RELEASES[Number(match[1])]) : send(404, { message: 'Release not found.' });
    match = /^\/artists\/(\d+)$/.exec(url.pathname);
    if (match) return ARTISTS[Number(match[1])] ? send(200, ARTISTS[Number(match[1])]) : send(404, { message: 'Artist not found.' });
    if (url.pathname === '/artists/77/releases') {
      return send(200, { pagination: { page: 1, pages: 1 }, releases: [
        { id: 502, type: 'master', main_release: 9003, title: 'Second Bloom', year: 2022, artist: BAND.name, role: 'Main', thumb: `${ART}/502-thumb.jpg` },
        { id: 501, type: 'master', main_release: 9001, title: 'Hollow Lanterns', year: 2019, artist: BAND.name, role: 'Main', thumb: `${ART}/501-thumb.jpg` },
        { id: 9002, type: 'release', title: 'Demo Tape', year: 2017, artist: BAND.name, role: 'Main', format: 'Cassette, EP', thumb: '' },
        { id: 4242, type: 'release', title: 'Friends Compilation', year: 2020, artist: 'Various', role: 'TrackAppearance' },
      ] });
    }
    match = /^\/artists\/(\d+)\/releases$/.exec(url.pathname);
    if (match && ARTISTS[Number(match[1])]) {
      // Mara Quill (91) sings on a lot of other people's records: more pages
      // than the app reads, every one of them guest spots.
      if (match[1] === '91') {
        const page = Number(url.searchParams.get('page') ?? 1);
        return send(200, { pagination: { page, pages: 9 }, releases: [
          { id: 7000 + page, type: 'release', title: `Guest Spot ${page}`, year: 2020, artist: 'Various', role: 'Appearance' },
        ] });
      }
      return send(200, { pagination: { page: 1, pages: 1 }, releases: [] });
    }
    return send(404, { message: 'The requested resource was not found.' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fake Discogs did not bind');
  data = catalogue(`http://127.0.0.1:${address.port}/img`);
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
