// Precium — cuentas: registro, ingreso, salida, datos propios y borrado.

'use strict';

const { HttpError } = require('../lib/http');
const V = require('../lib/validate');
const A = require('../lib/auth');

module.exports = function register(router, { db, limits }) {
  const publicUser = (u) => ({ id: u.id, name: u.name });

  function tooMany() { return new HttpError(429, 'too_many', 'Hiciste demasiados intentos. Probá de nuevo en unos minutos.'); }

  router.add('GET', '/api/me', (c) => ({ user: c.user ? publicUser(c.user) : null }));

  router.add('POST', '/api/register', async (c) => {
    if (!limits.auth.hit('ip:' + c.ip)) throw tooMany();
    const b = await c.body();
    const name = V.str(b.name, 'nombre', 1, 40);
    const email = V.email(b.email);
    const pass = V.password(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'email_taken', 'Ya existe una cuenta con ese correo. Probá iniciar sesión.');
    }
    const hash = await A.hashPassword(pass);
    let id;
    try { id = db.prepare('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)').run(email, hash, name).lastInsertRowid; }
    catch (e) { throw new HttpError(409, 'email_taken', 'Ya existe una cuenta con ese correo. Probá iniciar sesión.'); }
    const token = A.createSession(db, Number(id));
    return { status: 201, headers: { 'Set-Cookie': A.cookie(token, c.secure) }, body: { user: { id: Number(id), name } } };
  });

  router.add('POST', '/api/login', async (c) => {
    if (!limits.auth.hit('ip:' + c.ip)) throw tooMany();
    const b = await c.body();
    const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
    const pass = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    if (!limits.login.hit('email:' + email)) throw tooMany();
    const u = db.prepare('SELECT id, display_name AS name, password_hash FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
    const okPass = u ? await A.verifyPassword(pass, u.password_hash) : (await A.verifyAgainstDummy(pass), false);
    if (!okPass) throw new HttpError(401, 'bad_credentials', 'Correo o contraseña incorrectos.');
    limits.login.reset('email:' + email);
    const token = A.createSession(db, u.id);
    return { headers: { 'Set-Cookie': A.cookie(token, c.secure) }, body: { user: publicUser(u) } };
  });

  router.add('POST', '/api/logout', async (c) => {
    A.destroySession(db, c.token);
    return { headers: { 'Set-Cookie': A.clearCookie(c.secure) }, body: { ok: true } };
  });

  // Borrar la cuenta: se anonimiza (los precios aportados quedan, sin relación con la persona).
  router.add('DELETE', '/api/me', async (c) => {
    const u = c.requireUser();
    const b = await c.body();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    if (!(await A.verifyPassword(typeof b.password === 'string' ? b.password : '', row.password_hash))) {
      throw new HttpError(403, 'bad_credentials', 'La contraseña no es correcta.');
    }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM baskets WHERE user_id = ?').run(u.id);
      db.prepare("UPDATE users SET email = ?, password_hash = '!', display_name = NULL, deleted_at = datetime('now') WHERE id = ?")
        .run(`borrado-${u.id}@borrado.invalid`, u.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { headers: { 'Set-Cookie': A.clearCookie(c.secure) }, body: { ok: true } };
  });
};
