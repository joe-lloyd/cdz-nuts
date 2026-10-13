// The Node half of the Spotify sign-in: tokens in a file, and the PKCE
// authorization through the browser and a loopback port.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REDIRECT_URI, SCOPES, configureAuth, tokenRequest, type TokenSet, type TokenStore } from './auth.ts';

const TOKEN_FILE = path.join(import.meta.dirname, '..', 'tokens.json');

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export const fileTokenStore: TokenStore = {
  async load() {
    try {
      return JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as TokenSet;
    } catch {
      return null;
    }
  },
  async save(tokens) {
    await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  },
};

async function authorize(clientId: string): Promise<TokenSet> {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const gotCode = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      if (error || !gotCode || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`Authorization failed: ${error ?? 'state mismatch or missing code'}`);
        server.close();
        reject(new Error(`Authorization failed: ${error ?? 'state mismatch or missing code'}`));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="font-family:sans-serif"><h2>Authorized ✓</h2>You can close this tab and return to the terminal.</body>');
      server.close();
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(8888, '127.0.0.1', () => {
      console.log(`\nOpen this URL to authorize (it should open automatically):\n\n  ${authUrl}\n`);
      if (process.platform === 'darwin') {
        spawn('open', [authUrl.toString()], { stdio: 'ignore', detached: true }).unref();
      }
    });
  });

  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
}

/** Configures auth for a run from the command line; exits with the old message when the client id is missing. */
export function configureNodeAuth(): void {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) {
    console.error('SPOTIFY_CLIENT_ID is not set.');
    console.error('Create an app at https://developer.spotify.com/dashboard,');
    console.error(`add ${REDIRECT_URI} as a redirect URI, then run:`);
    console.error('  SPOTIFY_CLIENT_ID=<your client id> pnpm export');
    process.exit(1);
  }
  configureAuth({ clientId: id, store: fileTokenStore, authorize });
}
