// Connecting an app the OAuth way (ChatGPT, and Claude since 2026-11-05), and no token in links.
//   node test/oauth.js
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maowo-oauth-'));
const PORT = 4800 + Math.floor(Math.random() * 300); // clear of ports fetch refuses
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner-test-token';
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'games.db'), MAOWO_TOKEN: OWNER },
  stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => server.kill());

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(URL_ + '/login'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const H = { Authorization: 'Bearer ' + OWNER };

  // No token in links any more: the REST API only takes the Authorization header.
  const item = await (await fetch(`${URL_}/api/vault/notes`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '笔记', content: '内容' }) })).json();
  assert(item.id, JSON.stringify(item));
  assert.strictEqual((await fetch(`${URL_}/api/vault/${item.id}/download?token=${OWNER}`)).status, 401, 'vault: token in the link refused');
  assert.strictEqual((await fetch(`${URL_}/api/vault/backup/export?token=${OWNER}`)).status, 401, 'export: token in the link refused');
  assert.strictEqual((await fetch(`${URL_}/api/me?token=${OWNER}`)).status, 401, 'api: token in the link refused');
  const dl = await fetch(`${URL_}/api/vault/${item.id}/download`, { headers: H });
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(await dl.text(), '内容');
  assert.strictEqual((await fetch(`${URL_}/api/vault/backup/export`, { headers: H })).status, 200);
  console.log('ok no token in links: header only');

  // The whole OAuth dance the way Claude does it: discover, register, authorize, exchange, call.
  const noAuth = await fetch(`${URL_}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /resource_metadata=/);
  const meta = await (await fetch(`${URL_}/.well-known/oauth-authorization-server`)).json();
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const client = await (await fetch(meta.registration_endpoint.replace(/^https?:\/\/[^/]+/, URL_), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: client.client_id, redirect_uri: redirect, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', response_type: 'code' };
  const page = await fetch(`${URL_}/oauth/authorize?${new URLSearchParams(params)}`);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Claude/);
  const wrong = await fetch(`${URL_}/oauth/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...params, token: 'nope', decision: 'allow' }) });
  assert.strictEqual(wrong.status, 401, 'a wrong token gets the page again');
  const ok = await fetch(`${URL_}/oauth/authorize`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...params, token: OWNER, decision: 'allow' }) });
  const back = new URL(ok.headers.get('location'));
  assert.strictEqual(back.origin + back.pathname, redirect);
  assert.strictEqual(back.searchParams.get('state'), 's1');
  const tok = await (await fetch(`${URL_}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }) })).json();
  assert(tok.access_token && tok.refresh_token, JSON.stringify(tok));
  const list = await (await fetch(`${URL_}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert(list.result.tools.some(t => t.name === 'register'), 'tools listed over OAuth');
  const conns = await (await fetch(`${URL_}/api/connections`, { headers: H })).json();
  assert.deepStrictEqual(conns.oauth.map(g => g.name), ['Claude'], 'shows up in 「我的」 as Claude');
  console.log('ok Claude connects with OAuth: no token in its address');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
