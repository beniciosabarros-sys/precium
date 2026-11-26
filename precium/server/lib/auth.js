// Precium — contraseñas y sesiones.
//  - Contraseñas: scrypt con sal propia (nunca texto plano ni hash rápido).
//  - Sesiones: token aleatorio en cookie HttpOnly; en la base solo se guarda su SHA-256.

'use strict';

const crypto = require('crypto');

const SESSION_DAYS = 30;
const COOKIE = 'precium_sid';
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash de relleno: se usa cuando el correo no existe, para que tardar lo mismo no delate qué correos tienen cuenta.
const DUMMY = hashPassword('relleno-no-es-una-contraseña');

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') { await scrypt('x', Buffer.alloc(16), N, R, P); return false; }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), +n, +r, +p);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

async function verifyAgainstDummy(password) { return verifyPassword(password, await DUMMY); }

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const sqlDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, sqlDate(expires));
  return token;
}

function userFromToken(db, token) {
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.display_name AS name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.deleted_at IS NULL`).get(sha(token)) || null;
}

function destroySession(db, token) { if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token)); }

function cookie(token, secure) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
const clearCookie = (secure) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

// Límite de intentos en memoria: ventana deslizante por clave (IP, correo).
function createLimiter(max, windowMs) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return list.length <= max;
    },
    reset(key) { hits.delete(key); },
  };
}

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy, createSession, userFromToken, destroySession, cookie, clearCookie, createLimiter, COOKIE, sqlDate };
