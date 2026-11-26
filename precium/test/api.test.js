// Pruebas de la API: levantan el servidor con una base temporal y le hacen pedidos reales.
//   npm test     (o: node --test test/)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openDb } = require('../server/db/connection');
const { createApp } = require('../server');
const { seedDemo } = require('../scripts/seed-demo');

let server, base, db, dir;
const jars = {}; // cookies por "persona"

async function call(who, method, url, body, headers = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  if (jars[who]) h.Cookie = jars[who];
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const set = res.headers.get('set-cookie');
  if (set) jars[who] = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* no JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precium-'));
  db = openDb(path.join(dir, 'test.sqlite'));
  seedDemo(db);
  server = http.createServer(createApp({ db }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const P = (name) => db.prepare('SELECT id FROM products WHERE name LIKE ?').get(name + '%').id;
const loc = { lat: -34.5267, lng: -58.5027 };

test('sitio y cabeceras de seguridad', async () => {
  const r = await call('x', 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Precium/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await call('x', 'GET', '/css/base.css')).status, 200);
  assert.equal((await call('x', 'GET', '/nada.html')).status, 404);
});

test('no se puede salir de public/', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fserver/index.js', '/%2e%2e%2fprecium.sqlite']) {
    const r = await call('x', 'GET', p);
    assert.ok([400, 403, 404].includes(r.status), p + ' -> ' + r.status);
    assert.doesNotMatch(r.text, /"name": "precium"|createApp/);
  }
  const raw = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/../package.json' }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve(t)); });
  });
  assert.doesNotMatch(raw, /"name": "precium"/);
});

test('API: rutas desconocidas y métodos', async () => {
  assert.equal((await call('x', 'GET', '/api/nada')).status, 404);
  assert.equal((await call('x', 'DELETE', '/api/products')).status, 405);
  assert.equal((await call('x', 'POST', '/index.html', {})).status, 405);
  assert.equal((await call('x', 'POST', '/api/login', '{no json')).status, 400);
  assert.equal((await call('x', 'POST', '/api/login', 'a=b', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('x', 'POST', '/api/login', { email: 'a@b.co', password: 'x' }, { Origin: 'https://evil.example' })).status, 403);
});

test('catálogo, frecuentes, código de barras y comercios', async () => {
  const all = await call('x', 'GET', '/api/products?limit=100');
  assert.equal(all.json.products.length, 16);
  const q = await call('x', 'GET', '/api/products?q=' + encodeURIComponent('AZÚCAR'));
  assert.deepEqual(q.json.products.map((p) => p.name), ['Azúcar 1 kg']);
  const fr = await call('x', 'GET', '/api/products/frequent');
  assert.equal(fr.json.products.length, 6);
  const bc = await call('x', 'GET', '/api/barcode/7799000000013');
  assert.equal(bc.json.product.name, 'Leche entera 1 L');
  assert.equal((await call('x', 'GET', '/api/barcode/07799000000013')).status, 200, 'cero inicial se normaliza');
  assert.equal((await call('x', 'GET', '/api/barcode/1234567890128')).status, 404);
  assert.equal((await call('x', 'GET', '/api/barcode/abc')).status, 400);
  const b = await call('x', 'GET', '/api/businesses?lat=-34.5267&lng=-58.5027&limit=2');
  assert.equal(b.json.businesses.length, 2);
  assert.ok(b.json.businesses[0].km <= b.json.businesses[1].km);
  assert.ok(!JSON.stringify(b.json).includes('price'), 'sin precios');
  assert.equal((await call('x', 'GET', '/api/businesses?lat=-34.5267&lng=-58.5027&radius=0.1')).json.businesses.length, 0);
});

test('comparar una canasta: ranking sin precios individuales', async () => {
  const items = [P('Leche'), P('Pan'), P('Arroz')].map((productId) => ({ productId, qty: 1 }));
  const r = await call('x', 'POST', '/api/compare', { items, ...loc });
  assert.equal(r.status, 200);
  assert.equal(r.json.winner.business.name, 'Súper Norte');
  assert.equal(r.json.winner.covered, 3);
  assert.equal(r.json.others.length, 2);
  assert.equal(r.json.location.approx, false);
  assert.ok(r.json.savingsPct >= 0);
  const txt = JSON.stringify(r.json);
  assert.doesNotMatch(txt, /estimated|"prices?"|priceCents|119000/, 'no filtra precios');
  const approx = await call('x', 'POST', '/api/compare', { items });
  assert.equal(approx.json.location.approx, true);
  // un producto sin ningún precio queda aparte
  const lonely = db.prepare("INSERT INTO products (name) VALUES ('Producto sin precios')").run().lastInsertRowid;
  const r2 = await call('x', 'POST', '/api/compare', { items: [...items, { productId: Number(lonely), qty: 1 }], ...loc });
  assert.deepEqual(r2.json.unpriced, [Number(lonely)]);
  assert.equal(r2.json.comparableCount, 3);
});

test('comparar: validaciones', async () => {
  assert.equal((await call('x', 'POST', '/api/compare', { items: [] })).status, 400);
  assert.equal((await call('x', 'POST', '/api/compare', { items: [{ productId: 99999, qty: 1 }] })).status, 400);
  assert.equal((await call('x', 'POST', '/api/compare', { items: [{ productId: 'a', qty: 1 }] })).status, 400);
  assert.equal((await call('x', 'POST', '/api/compare', { items: [{ productId: P('Leche'), qty: -1 }] })).status, 400);
  assert.equal((await call('x', 'POST', '/api/compare', { items: [{ productId: P('Leche'), qty: 1 }], lat: 999, lng: 0 })).status, 400);
  const far = await call('x', 'POST', '/api/compare', { items: [{ productId: P('Leche'), qty: 1 }], lat: 40, lng: 10 });
  assert.equal(far.json.winner, null, 'sin comercios cerca no hay ganador');
});

test('cuentas: registro, sesión, salida', async () => {
  assert.equal((await call('ana', 'GET', '/api/me')).json.user, null);
  assert.equal((await call('ana', 'POST', '/api/register', { name: 'Ana', email: 'mal', password: '12345678' })).status, 400);
  assert.equal((await call('ana', 'POST', '/api/register', { name: 'Ana', email: 'ana@mail.com', password: '1234567' })).status, 400);
  const reg = await call('ana', 'POST', '/api/register', { name: 'Ana', email: 'Ana@Mail.com', password: 'clave-larga-1' });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.equal((await call('ana', 'GET', '/api/me')).json.user.name, 'Ana');
  const row = db.prepare('SELECT email, password_hash FROM users').get();
  assert.equal(row.email, 'ana@mail.com');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.doesNotMatch(row.password_hash, /clave-larga/);
  const tok = jars.ana.split('=')[1];
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(tok).n, 0, 'no se guarda el token en claro');
  assert.equal((await call('x', 'POST', '/api/register', { name: 'Otra', email: 'ana@mail.com', password: 'clave-larga-1' })).status, 409);
  await call('ana', 'POST', '/api/logout', {});
  assert.equal((await call('ana', 'GET', '/api/me')).json.user, null);
  const bad = await call('ana', 'POST', '/api/login', { email: 'ana@mail.com', password: 'incorrecta' });
  assert.equal(bad.status, 401);
  const nobody = await call('ana', 'POST', '/api/login', { email: 'nadie@mail.com', password: 'incorrecta' });
  assert.equal(nobody.json.error.message, bad.json.error.message, 'mismo mensaje exista o no el correo');
  assert.equal((await call('ana', 'POST', '/api/login', { email: 'ana@mail.com', password: 'clave-larga-1' })).status, 200);
});

test('límite de intentos de ingreso', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await call('x', 'POST', '/api/login', { email: 'victima@mail.com', password: 'mal' + i });
  assert.equal(last.status, 429);
});

test('aportar exige cuenta y valida todo', async () => {
  const body = { businessId: 1, source: 'manual', items: [{ productId: P('Yerba'), priceCents: 300000 }] };
  assert.equal((await call('guest', 'POST', '/api/reports', body)).status, 401);
  await call('beto', 'POST', '/api/register', { name: 'Beto', email: 'beto@mail.com', password: 'clave-larga-2' });
  const bad = [
    { ...body, businessId: 999 }, { ...body, source: 'scrape' }, { ...body, items: [] },
    { ...body, items: [{ productId: P('Yerba'), priceCents: -5 }] }, { ...body, items: [{ productId: P('Yerba'), priceCents: 12.5 }] },
    { ...body, items: [{ productId: 99999, priceCents: 1000 }] }, { ...body, observedAt: '2999-01-01' },
    { ...body, items: [{ productId: P('Yerba'), priceCents: 1000 }, { productId: P('Yerba'), priceCents: 2000 }] },
  ];
  for (const b of bad) assert.ok([400, 404].includes((await call('beto', 'POST', '/api/reports', b)).status), JSON.stringify(b));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_reports WHERE user_id IS NOT NULL').get().n, 0);
});

test('aportar: guarda, evita duplicados y marca atípicos sin revelar el precio', async () => {
  const yerba = P('Yerba'), leche = P('Leche');
  const ok = await call('beto', 'POST', '/api/reports', { businessId: 1, source: 'manual', items: [{ productId: yerba, priceCents: 310000 }] });
  assert.equal(ok.status, 201); assert.equal(ok.json.inReview, 0);
  const row = db.prepare("SELECT status, user_id, source FROM price_reports WHERE user_id IS NOT NULL").get();
  assert.equal(row.status, 'active'); assert.equal(row.source, 'manual');
  const dup = await call('beto', 'POST', '/api/reports', { businessId: 1, source: 'manual', items: [{ productId: yerba, priceCents: 310000 }] });
  assert.equal(dup.status, 409); assert.equal(dup.json.error.code, 'duplicate');
  // atípico: 5x lo normal
  const out = await call('beto', 'POST', '/api/reports', { businessId: 1, source: 'manual', items: [{ productId: leche, priceCents: 700000 }] });
  assert.equal(out.status, 409); assert.equal(out.json.error.code, 'outlier');
  assert.deepEqual(out.json.error.productIds, [leche]);
  assert.doesNotMatch(JSON.stringify(out.json), /1250|125000/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_reports WHERE product_id = ? AND user_id IS NOT NULL').get(leche).n, 0, 'nada se guarda sin confirmar');
  const conf = await call('beto', 'POST', '/api/reports', { businessId: 1, source: 'manual', items: [{ productId: leche, priceCents: 700000, confirmOutlier: true }] });
  assert.equal(conf.status, 201); assert.equal(conf.json.inReview, 1);
  assert.equal(db.prepare("SELECT status FROM price_reports WHERE product_id = ? AND user_id IS NOT NULL").get(leche).status, 'flagged');
  // y el atípico confirmado no mueve la comparación
  const items = [{ productId: leche, qty: 1 }, { productId: P('Pan'), qty: 1 }];
  const before = await call('x', 'POST', '/api/compare', { items, ...loc });
  assert.equal(before.json.winner.business.name, 'Súper Norte');
  // una oferta no cuenta como precio habitual
  await call('beto', 'POST', '/api/reports', { businessId: 1, source: 'manual', items: [{ productId: P('Fideos'), priceCents: 1000, promo: true }] });
  assert.equal(db.prepare('SELECT is_promo FROM price_reports WHERE price_cents = 1000').get().is_promo, 1);
});

test('aportar un precio normal cambia la comparación', async () => {
  const items = [{ productId: P('Leche'), qty: 1 }, { productId: P('Arroz'), qty: 1 }, { productId: P('Aceite'), qty: 1 }];
  const before = await call('x', 'POST', '/api/compare', { items, ...loc });
  assert.equal(before.json.winner.business.name, 'Súper Norte');
  const esquina = db.prepare("SELECT id FROM businesses WHERE name LIKE '%Esquina%'").get().id;
  // Una persona informa precios más bajos (dentro de lo razonable) en La Esquina: pasa a ganar.
  await call('dora', 'POST', '/api/register', { name: 'Dora', email: 'dora@mail.com', password: 'clave-larga-4' });
  const r = await call('dora', 'POST', '/api/reports', { businessId: esquina, source: 'manual',
    items: [{ productId: items[0].productId, priceCents: 100000 }, { productId: items[1].productId, priceCents: 150000 }, { productId: items[2].productId, priceCents: 190000 }] });
  assert.equal(r.status, 201); assert.equal(r.json.inReview, 0);
  const after = await call('x', 'POST', '/api/compare', { items, ...loc });
  assert.equal(after.json.winner.business.name, 'Autoservicio La Esquina');
  assert.ok(after.json.savingsPct > 0);
});

test('tickets: se rechaza el mismo ticket dos veces', async () => {
  const hash = 'a'.repeat(64);
  const body = { businessId: 2, source: 'receipt', receipt: { hash, totalCents: 500000 }, items: [{ productId: P('Manteca'), priceCents: 165000 }] };
  assert.equal((await call('beto', 'POST', '/api/reports', body)).status, 201);
  const again = await call('beto', 'POST', '/api/reports', { ...body, items: [{ productId: P('Queso'), priceCents: 700000 }] });
  assert.equal(again.status, 409); assert.equal(again.json.error.code, 'duplicate_receipt');
  assert.equal((await call('beto', 'POST', '/api/reports', { ...body, items: [{ productId: P('Tomate'), priceCents: 210000 }], receipt: { hash: 'xyz' } })).status, 400);
});

test('canastas guardadas: cada persona ve solo las suyas', async () => {
  const items = [{ productId: P('Leche'), qty: 2 }, { productId: P('Pan'), qty: 0.5 }];
  assert.equal((await call('guest', 'GET', '/api/baskets')).status, 401);
  const c = await call('ana', 'POST', '/api/baskets', { name: 'Compra del mes', items });
  assert.equal(c.status, 201);
  assert.deepEqual(c.json.basket.items.map((i) => i.qty).sort(), [0.5, 2]);
  assert.equal((await call('ana', 'POST', '/api/baskets', { name: 'Compra del mes', items })).status, 409);
  assert.equal((await call('ana', 'POST', '/api/baskets', { name: '', items })).status, 400);
  assert.equal((await call('ana', 'POST', '/api/baskets', { name: 'X', items: [{ productId: 99999, qty: 1 }] })).status, 400);
  assert.equal((await call('ana', 'GET', '/api/baskets')).json.baskets.length, 1);
  assert.equal((await call('beto', 'GET', '/api/baskets')).json.baskets.length, 0);
  assert.equal((await call('beto', 'DELETE', '/api/baskets/' + c.json.basket.id)).status, 404, 'no se puede borrar la de otra persona');
  assert.equal((await call('ana', 'DELETE', '/api/baskets/' + c.json.basket.id)).status, 200);
});

test('borrar la cuenta anonimiza y conserva los precios', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM price_reports WHERE user_id IS NOT NULL').get().n;
  assert.ok(before > 0);
  const uid = db.prepare("SELECT id FROM users WHERE email = 'beto@mail.com'").get().id;
  assert.equal((await call('beto', 'DELETE', '/api/me', { password: 'incorrecta' })).status, 403);
  assert.equal((await call('beto', 'DELETE', '/api/me', { password: 'clave-larga-2' })).status, 200);
  const u = db.prepare('SELECT email, display_name, deleted_at, password_hash FROM users WHERE id = ?').get(uid);
  assert.equal(u.display_name, null); assert.ok(u.deleted_at); assert.equal(u.password_hash, '!'); assert.doesNotMatch(u.email, /beto/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_reports WHERE user_id IS NOT NULL').get().n, before);
  assert.equal((await call('beto', 'GET', '/api/me')).json.user, null);
  assert.equal((await call('x', 'POST', '/api/login', { email: 'beto@mail.com', password: 'clave-larga-2' })).status, 401);
});

test('límite diario de aportes', async () => {
  await call('carla', 'POST', '/api/register', { name: 'Carla', email: 'carla@mail.com', password: 'clave-larga-3' });
  const pids = db.prepare('SELECT id FROM products LIMIT 16').all().map((r) => r.id);
  let last;
  for (let i = 0; i < 7; i++) {
    last = await call('carla', 'POST', '/api/reports', { businessId: 4, source: 'manual', items: pids.map((productId, k) => ({ productId, priceCents: 100000 + i * 10 + k, promo: true })) });
  }
  assert.equal(last.status, 429);
});
