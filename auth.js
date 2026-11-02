const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

// ============================================================
// Owner token: MAOWO_TOKEN env var, or generated once and kept in data/
// ============================================================
const TOKEN_FILE = path.join(DATA_DIR, 'maowo-token.txt');

function loadToken() {
  if (process.env.MAOWO_TOKEN) return { token: process.env.MAOWO_TOKEN, source: 'env' };
  if (fs.existsSync(TOKEN_FILE)) return { token: fs.readFileSync(TOKEN_FILE, 'utf8').trim(), source: 'file' };
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return { token, source: 'new' };
}

const { token: OWNER_TOKEN, source: TOKEN_SOURCE } = loadToken();

function checkToken(given) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(OWNER_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenFromRequest(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.query.token;
}

// Express middleware
function requireToken(req, res, next) {
  if (checkToken(tokenFromRequest(req))) return next();
  res.status(401).json({ error: '需要正确的 token' });
}

module.exports = { checkToken, requireToken, OWNER_TOKEN, TOKEN_SOURCE, TOKEN_FILE };
