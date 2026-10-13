// Spotify tokens for the exporter. The token handling is portable: where the
// tokens are kept is a TokenStore (a file in Node, the Worker's own files
// folder in workerd), and the interactive PKCE sign-in, which needs a browser
// and a loopback port, is an Authorizer that only the Node entry provides.

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const SCOPES = [
  'user-library-read',
  'user-follow-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
  'user-read-recently-played',
].join(' ');

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(tokens: TokenSet): Promise<void>;
}

/** Signs in through the user's browser. Absent where nobody can click: the Worker. */
export type Authorizer = (clientId: string) => Promise<TokenSet>;

export async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    access_token: body.access_token,
    // Spotify may rotate the refresh token; fall back to the one we sent.
    refresh_token: body.refresh_token ?? params.refresh_token ?? '',
    expires_at: Date.now() + body.expires_in * 1000,
  };
}

let cached: TokenSet | null = null;
let clientId = '';
let store: TokenStore | null = null;
let authorizer: Authorizer | undefined;

export function configureAuth(options: { clientId: string; store: TokenStore; authorize?: Authorizer }): void {
  clientId = options.clientId;
  store = options.store;
  authorizer = options.authorize;
  cached = null;
}

export async function initAuth(): Promise<void> {
  if (!store || !clientId) throw new Error('Spotify is not configured: SPOTIFY_CLIENT_ID and a token store are required');
  cached = await store.load();
  if (!cached) {
    if (!authorizer) throw new Error('No Spotify tokens are stored, and this host cannot sign in. Run the export once where a browser is available and import its tokens.');
    cached = await authorizer(clientId);
    await store.save(cached);
    console.log('Authorized. Tokens saved to tokens.json (gitignored).');
  }
}

export async function getAccessToken(): Promise<string> {
  if (!cached || !store) throw new Error('initAuth() was not called');
  if (Date.now() > cached.expires_at - 60_000) {
    try {
      cached = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: cached.refresh_token,
        client_id: clientId,
      });
    } catch (err) {
      // Refresh token revoked or expired: fall back to a fresh authorization, where one is possible.
      if (!authorizer) throw err;
      console.warn(`Token refresh failed (${(err as Error).message}), re-authorizing...`);
      cached = await authorizer(clientId);
    }
    await store.save(cached);
  }
  return cached.access_token;
}
