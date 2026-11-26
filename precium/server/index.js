// Precium — servidor principal. Sin dependencias: usa solo módulos incluidos en Node 22
// (http, node:sqlite, crypto). Sirve el sitio (public/) y la API (/api/...).
//
//   node server/index.js
//   PORT=3000 HOST=127.0.0.1 PRECIUM_DB=./precium.sqlite node server/index.js

'use strict';

const http = require('http');
const path = require('path');
const { openDb } = require('./db/connection');
const { HttpError, send, sendJson, readJson, parseCookies, createRouter, serveStatic } = require('./lib/http');
const A = require('./lib/auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ db, publicDir = PUBLIC_DIR, trustProxy = false } = {}) {
  const router = createRouter();
  const limits = { auth: A.createLimiter(30, 15 * 60e3), login: A.createLimiter(8, 15 * 60e3) };
  ['auth', 'catalog', 'compare', 'reports', 'baskets'].forEach((name) => require(`./routes/${name}`)(router, { db, limits }));
  router.add('GET', '/api/health', () => ({ ok: true }));

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido', { Allow: 'GET, HEAD' });
      return serveStatic(publicDir, url.pathname, req, res);
    }

    try {
      // Protección CSRF: las escrituras solo se aceptan desde el propio sitio.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'bad_origin', 'Origen no permitido.');
      }
      const m = router.match(req.method === 'HEAD' ? 'GET' : req.method, url.pathname);
      if (!m.handler) {
        throw m.pathMatched ? new HttpError(405, 'method_not_allowed', 'Método no permitido.') : new HttpError(404, 'not_found', 'No existe esa ruta.');
      }
      const token = parseCookies(req.headers.cookie)[A.COOKIE] || null;
      const user = A.userFromToken(db, token);
      const ctx = {
        req, params: m.params, query: url.searchParams, token, user,
        ip: (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'x',
        secure: req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https'),
        body: () => readJson(req),
        requireUser() {
          if (!user) throw new HttpError(401, 'login_required', 'Necesitás iniciar sesión para hacer esto.');
          return user;
        },
      };
      const out = await m.handler(ctx);
      if (out && out.body !== undefined) return sendJson(res, out.status || 200, out.body, out.headers);
      return sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
      console.error('Error interno:', e);
      return sendJson(res, 500, { error: { code: 'internal', message: 'Algo salió mal de nuestro lado. Probá de nuevo.' } });
    }
  };
}

function start() {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1'; // para probar desde el celular: HOST=0.0.0.0
  const file = process.env.PRECIUM_DB || path.join(__dirname, '..', 'precium.sqlite');
  const db = openDb(file);
  const server = http.createServer(createApp({ db, trustProxy: process.env.PRECIUM_TRUST_PROXY === '1' }));
  server.listen(port, host, () => console.log(`Precium corriendo en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (base: ${file})`));
  return server;
}

if (require.main === module) start();
module.exports = { createApp, start };
