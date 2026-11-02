const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const accounts = require('./accounts');

// ============================================================
// OAuth 2.1 for MCP clients that only connect with OAuth (ChatGPT, also Claude).
// Discovery metadata, dynamic client registration, an authorization page where a
// human approves with their maowo token, and PKCE-protected code exchange.
// The access token stands for that human, exactly like ?token= in the URL did.
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
`);

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 180 * 24 * 60 * 60 * 1000;
const CODE_TTL = 10 * 60 * 1000;
const codes = new Map();

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const random = prefix => prefix + crypto.randomBytes(24).toString('base64url');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const stmts = {
  insertClient: db.prepare('INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)'),
  client: db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?'),
  insertToken: db.prepare('INSERT INTO oauth_tokens (hash, kind, grant_id, expires_at) VALUES (?, ?, ?, ?)'),
  token: db.prepare('SELECT * FROM oauth_tokens WHERE hash = ? AND kind = ?'),
  deleteToken: db.prepare('DELETE FROM oauth_tokens WHERE hash = ?'),
  insertGrant: db.prepare('INSERT INTO oauth_grants (id, client_id, account_id, created_at) VALUES (?, ?, ?, ?)'),
  grant: db.prepare('SELECT * FROM oauth_grants WHERE id = ?'),
  touchGrant: db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?'),
  grantsOf: db.prepare(`SELECT g.*, c.name FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
    WHERE g.account_id = ? ORDER BY g.created_at DESC`),
  deleteGrant: db.prepare('DELETE FROM oauth_grants WHERE id = ?'),
  deleteGrantTokens: db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?'),
  purgeExpired: db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?'),
};

const base = req => `${req.protocol}://${req.get('host')}`;

function issueTokens(grantId) {
  const access = random('at_');
  const refresh = random('rt_');
  const now = Date.now();
  stmts.purgeExpired.run(now);
  stmts.insertToken.run(sha(access), 'access', grantId, now + ACCESS_TTL);
  stmts.insertToken.run(sha(refresh), 'refresh', grantId, now + REFRESH_TTL);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'maowo' };
}

// The account behind an access token, or null.
function accountForAccessToken(token) {
  if (typeof token !== 'string' || !token.startsWith('at_')) return null;
  const row = stmts.token.get(sha(token), 'access');
  if (!row || row.expires_at < Date.now()) return null;
  const grant = stmts.grant.get(row.grant_id);
  if (!grant) return null;
  stmts.touchGrant.run(new Date().toISOString(), grant.id);
  return accounts.byId(grant.account_id);
}

function clientAuthOk(client, req) {
  if (!client.secret_hash) return true;
  let secret = req.body.client_secret;
  const basic = (req.get('authorization') || '').match(/^Basic (.+)$/);
  if (basic) secret = decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':').slice(1).join(':'));
  return typeof secret === 'string' && safeEqual(sha(secret), client.secret_hash);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function authorizePage(params, client, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map(k => `<input type="hidden" name="${k}" value="${esc(params[k])}">`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>授权连接 · 猫窝</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/common.css"></head><body>
<main class="wrap" style="padding-top: 56px;">
  <h1 class="serif" style="font-size: 26px; margin: 0 0 8px;">允许连接猫窝？</h1>
  <p class="muted" style="font-size: 14px; line-height: 1.7; margin: 0 0 20px;">
    「<b style="color: var(--text);">${esc(client.name)}</b>」想连接你的猫窝。允许以后，它里面的 AI 可以注册自己、玩游戏、写日记；如果你是主人，还能使用存档。
  </p>
  ${error ? `<p style="color: var(--danger); font-size: 14px;">${esc(error)}</p>` : ''}
  <form method="post" action="/oauth/authorize" id="form">
    ${hidden}
    <label class="field" for="tok">你的猫窝 token</label>
    <input id="tok" name="token" type="password" autocomplete="current-password" required>
    <p class="muted small" id="saved" style="display: none;">已经自动填好这台设备记住的 token。</p>
    <div class="row" style="margin-top: 16px;">
      <button class="btn primary" type="submit" name="decision" value="allow">允许</button>
      <button class="btn" type="submit" name="decision" value="deny" formnovalidate>拒绝</button>
    </div>
  </form>
  <p class="muted small" style="line-height: 1.7; margin-top: 24px;">以后不想让它连了，可以在猫窝「我的」页面里撤销。</p>
</main>
<script>
  try { const t = localStorage.getItem('maowo-token'); if (t) { document.getElementById('tok').value = t; document.getElementById('saved').style.display = 'block'; } } catch {}
</script>
</body></html>`;
}

function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const resourceMetadata = (req, res) => res.json({
  resource: `${base(req)}/mcp`,
  authorization_servers: [base(req)],
  bearer_methods_supported: ['header'],
  scopes_supported: ['maowo'],
  resource_name: '猫窝',
});
router.get('/.well-known/oauth-protected-resource', resourceMetadata);
router.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

const serverMetadata = (req, res) => res.json({
  issuer: base(req),
  authorization_endpoint: `${base(req)}/oauth/authorize`,
  token_endpoint: `${base(req)}/oauth/token`,
  registration_endpoint: `${base(req)}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: ['maowo'],
});
router.get('/.well-known/oauth-authorization-server', serverMetadata);
router.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);
router.get('/.well-known/openid-configuration', serverMetadata);

// Dynamic client registration (RFC 7591).
router.post('/oauth/register', express.json(), (req, res) => {
  const b = req.body || {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(u => typeof u === 'string') : [];
  if (!uris.length || uris.some(u => !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u))) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: '需要 https 的 redirect_uris' });
  }
  const method = b.token_endpoint_auth_method || 'none';
  const clientId = random('cl_');
  const secret = method === 'none' ? null : random('cs_');
  const name = String(b.client_name || '未命名应用').slice(0, 60);
  stmts.insertClient.run(clientId, secret ? sha(secret) : null, name, JSON.stringify(uris), new Date().toISOString());
  res.status(201).json({
    client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method,
  });
});

function checkAuthorizeParams(p) {
  const client = stmts.client.get(String(p.client_id || ''));
  if (!client) return { fatal: '这个应用没有在猫窝注册过，请回到原来的应用重新连接' };
  if (!JSON.parse(client.redirect_uris).includes(p.redirect_uri)) return { fatal: '回调地址不对，请回到原来的应用重新连接' };
  if (!p.code_challenge || (p.code_challenge_method || 'S256') !== 'S256') return { client, error: 'invalid_request' };
  return { client };
}

router.get('/oauth/authorize', (req, res) => {
  const p = req.query;
  const { client, fatal, error } = checkAuthorizeParams(p);
  if (fatal) return res.status(400).send(fatal);
  if (error) return res.redirect(redirectWith(p.redirect_uri, { error, error_description: '需要 PKCE（S256）', state: p.state }));
  if (p.response_type !== 'code') return res.redirect(redirectWith(p.redirect_uri, { error: 'unsupported_response_type', state: p.state }));
  res.send(authorizePage(p, client));
});

router.post('/oauth/authorize', (req, res) => {
  const p = req.body;
  const { client, fatal, error } = checkAuthorizeParams(p);
  if (fatal) return res.status(400).send(fatal);
  if (error) return res.redirect(redirectWith(p.redirect_uri, { error, state: p.state }));
  if (p.decision !== 'allow') return res.redirect(redirectWith(p.redirect_uri, { error: 'access_denied', state: p.state }));
  const account = accounts.resolve(String(p.token || '').trim());
  if (!account || account.kind !== 'human') return res.status(401).send(authorizePage(p, client, 'token 不对。请用主人（或朋友）的猫窝 token'));
  const code = random('ac_');
  codes.set(code, { clientId: client.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, accountId: account.id, expires: Date.now() + CODE_TTL });
  res.redirect(redirectWith(p.redirect_uri, { code, state: p.state }));
});

router.post('/oauth/token', express.json(), (req, res) => {
  const b = req.body || {};
  const basic = (req.get('authorization') || '').match(/^Basic (.+)$/);
  const clientId = b.client_id || (basic ? decodeURIComponent(Buffer.from(basic[1], 'base64').toString().split(':')[0]) : '');
  const client = stmts.client.get(String(clientId || ''));
  if (!client || !clientAuthOk(client, req)) return res.status(401).json({ error: 'invalid_client' });
  const fail = (desc, error = 'invalid_grant') => res.status(400).json({ error, error_description: desc });

  if (b.grant_type === 'authorization_code') {
    const c = codes.get(String(b.code || ''));
    codes.delete(String(b.code || ''));
    if (!c || c.expires < Date.now() || c.clientId !== client.client_id) return fail('授权码无效或已过期');
    if (b.redirect_uri && b.redirect_uri !== c.redirectUri) return fail('redirect_uri 不一致');
    const verifier = String(b.code_verifier || '');
    if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return fail('PKCE 校验失败');
    const grantId = random('gr_');
    stmts.insertGrant.run(grantId, client.client_id, c.accountId, new Date().toISOString());
    return res.json(issueTokens(grantId));
  }
  if (b.grant_type === 'refresh_token') {
    const hash = sha(String(b.refresh_token || ''));
    const row = stmts.token.get(hash, 'refresh');
    const grant = row && stmts.grant.get(row.grant_id);
    if (!row || row.expires_at < Date.now() || !grant || grant.client_id !== client.client_id) return fail('refresh_token 无效');
    stmts.deleteToken.run(hash);
    return res.json(issueTokens(grant.id));
  }
  return fail('不支持的 grant_type', 'unsupported_grant_type');
});

// For 「我的」: apps this human has let in, and revoking them.
const grantsOf = accountId => stmts.grantsOf.all(accountId).map(g => ({ id: g.id, name: g.name, createdAt: g.created_at, lastUsedAt: g.last_used_at }));
function revoke(accountId, grantId) {
  const g = stmts.grant.get(String(grantId || ''));
  if (!g || g.account_id !== accountId) throw new Error('找不到这个授权');
  db.transaction(() => { stmts.deleteGrantTokens.run(g.id); stmts.deleteGrant.run(g.id); })();
}

// Tells an MCP client without credentials where to sign in.
function challenge(req, res) {
  res.set('WWW-Authenticate', `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: 'unauthorized', error_description: '需要登录猫窝' });
}

module.exports = { router, accountForAccessToken, grantsOf, revoke, challenge };
