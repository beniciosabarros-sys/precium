// Precium — aportar precios (requiere cuenta). Todas las reglas se hacen cumplir acá y, en
// última instancia, en la base de datos (CHECK: un reporte humano necesita user_id).

'use strict';

const { HttpError } = require('../lib/http');
const V = require('../lib/validate');
const { median, businessesNear, priceMap } = require('../lib/prices');
const { sqlDate } = require('../lib/auth');

const OUTLIER_LOW = 0.6;   // fuera de 60 %–160 % de lo que conocemos: pide confirmación y queda en revisión
const OUTLIER_HIGH = 1.6;
const DAILY_LIMIT = 100;   // aportes por persona cada 24 h
const MAX_ITEMS = 50;
const MAX_PRICE_CENTS = 100_000_000; // $1.000.000

module.exports = function register(router, { db }) {
  // Precio de referencia para detectar atípicos: el del propio comercio y, si no hay, la mediana de la zona.
  function reference(businessId, productId, biz) {
    const own = priceMap(db, [businessId], [productId]).get(businessId).prices[productId];
    if (own) return own;
    const near = businessesNear(db, biz, 5).filter((b) => b.id !== businessId).map((b) => b.id);
    const values = [...priceMap(db, near, [productId]).values()].map((m) => m.prices[productId]).filter(Boolean);
    return values.length >= 2 ? median(values) : null;
  }

  router.add('POST', '/api/reports', async (c) => {
    const user = c.requireUser();
    const b = await c.body();

    const businessId = V.int(b.businessId, 'comercio', 1, 2 ** 31);
    const biz = db.prepare('SELECT id, lat, lng FROM businesses WHERE id = ?').get(businessId);
    if (!biz) throw new HttpError(404, 'unknown_business', 'No encontramos ese comercio.');
    const source = ['manual', 'barcode', 'receipt'].includes(b.source) ? b.source : null;
    if (!source) throw V.bad('invalid_source', 'Origen del precio inválido.');
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_ITEMS) throw V.bad('invalid_items', `Sumá entre 1 y ${MAX_ITEMS} precios por vez.`);

    // Cuándo se vio el precio: ahora por defecto; se admite hasta 30 días atrás y nunca a futuro.
    let observed = new Date();
    if (b.observedAt !== undefined) {
      observed = new Date(b.observedAt);
      if (Number.isNaN(observed.getTime()) || observed.getTime() > Date.now() + 5 * 60e3 || observed.getTime() < Date.now() - 30 * 86400e3) {
        throw V.bad('invalid_date', 'La fecha del precio no es válida.');
      }
    }
    const observedAt = sqlDate(observed);

    const items = b.items.map((i) => {
      if (!i || typeof i !== 'object') throw V.bad('invalid_items', 'Hay un precio inválido.');
      return {
        productId: V.int(i.productId, 'producto', 1, 2 ** 31),
        cents: V.int(i.priceCents, 'precio', 1, MAX_PRICE_CENTS),
        promo: i.promo === true,
        confirm: i.confirmOutlier === true,
      };
    });
    const seen = new Set();
    items.forEach((i) => { if (seen.has(i.productId)) throw V.bad('duplicate_product', 'Un producto aparece dos veces en el mismo envío.'); seen.add(i.productId); });
    const pids = items.map((i) => i.productId);
    const existing = db.prepare(`SELECT id FROM products WHERE id IN (${pids.map(() => '?').join(',')})`).all(...pids).length;
    if (existing !== pids.length) throw new HttpError(400, 'unknown_product', 'Hay productos que no están en el catálogo.');

    const used = db.prepare("SELECT COUNT(*) AS n FROM price_reports WHERE user_id = ? AND created_at >= datetime('now','-1 day')").get(user.id).n;
    if (used + items.length > DAILY_LIMIT) throw new HttpError(429, 'daily_limit', 'Llegaste al máximo de aportes por hoy. ¡Gracias! Seguí mañana.');

    // Mismo precio del mismo producto en el mismo comercio por la misma persona en el día: se rechaza.
    const dup = items.filter((i) => db.prepare(`SELECT 1 FROM price_reports WHERE user_id = ? AND business_id = ? AND product_id = ?
      AND price_cents = ? AND created_at >= datetime('now','-1 day')`).get(user.id, businessId, i.productId, i.cents));
    if (dup.length) throw new HttpError(409, 'duplicate', 'Ya sumaste ese precio hoy.', { productIds: dup.map((i) => i.productId) });

    // Atípicos: sin confirmar no se guarda nada. Confirmados quedan 'flagged' (no cuentan hasta revisarse).
    // La respuesta indica cuáles, sin revelar contra qué precio se comparó.
    const outliers = new Set();
    items.forEach((i) => {
      if (i.promo) return;
      const ref = reference(businessId, i.productId, biz);
      if (ref && (i.cents < ref * OUTLIER_LOW || i.cents > ref * OUTLIER_HIGH)) outliers.add(i.productId);
    });
    const unconfirmed = items.filter((i) => outliers.has(i.productId) && !i.confirm).map((i) => i.productId);
    if (unconfirmed.length) throw new HttpError(409, 'outlier', 'Ese precio se aleja mucho de lo que conocemos. Confirmalo para enviarlo.', { productIds: unconfirmed });

    let receiptId = null;
    if (source === 'receipt' && b.receipt !== undefined) {
      const r = b.receipt;
      if (!r || typeof r.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(r.hash)) throw V.bad('invalid_receipt', 'El ticket no es válido.');
      if (db.prepare('SELECT 1 FROM receipts WHERE image_hash = ?').get(r.hash.toLowerCase())) throw new HttpError(409, 'duplicate_receipt', 'Ese ticket ya fue cargado.');
    }

    db.exec('BEGIN');
    try {
      if (source === 'receipt' && b.receipt) {
        const total = b.receipt.totalCents == null ? null : V.int(b.receipt.totalCents, 'total', 1, 2 ** 40);
        receiptId = Number(db.prepare('INSERT INTO receipts (user_id, business_id, image_hash, receipt_date, total_cents) VALUES (?, ?, ?, ?, ?)')
          .run(user.id, businessId, b.receipt.hash.toLowerCase(), observedAt.slice(0, 10), total).lastInsertRowid);
      }
      const ins = db.prepare(`INSERT INTO price_reports (business_id, product_id, price_cents, is_promo, source, user_id, receipt_id, status, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      items.forEach((i) => ins.run(businessId, i.productId, i.cents, i.promo ? 1 : 0, source, user.id, receiptId, outliers.has(i.productId) ? 'flagged' : 'active', observedAt));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    return { status: 201, body: { saved: items.length, inReview: outliers.size } };
  });
};
