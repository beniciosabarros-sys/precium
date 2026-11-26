// Precium — comparar una canasta. El cálculo vive en el servidor: al navegador solo llegan el
// ranking, la cobertura y el ahorro, nunca los precios de cada comercio.

'use strict';

const { HttpError } = require('../lib/http');
const V = require('../lib/validate');
const { businessesNear, priceMap } = require('../lib/prices');
const { compareBasket } = require('../../public/js/compare.js');
const { FALLBACK } = require('./catalog');

module.exports = function register(router, { db }) {
  router.add('POST', '/api/compare', async (c) => {
    const b = await c.body();
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 60) throw V.bad('invalid_items', 'Armá una canasta con entre 1 y 60 productos.');
    const merged = new Map();
    b.items.forEach((i) => {
      if (!i || typeof i !== 'object') throw V.bad('invalid_items', 'La canasta tiene un producto inválido.');
      const id = V.int(i.productId, 'producto', 1, 2 ** 31);
      const qty = V.num(i.qty === undefined ? 1 : i.qty, 'cantidad', 0.1, 99);
      merged.set(id, Math.round(((merged.get(id) || 0) + qty) * 10) / 10);
    });
    const ids = [...merged.keys()];
    const known = db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id);
    if (known.length !== ids.length) throw new HttpError(400, 'unknown_product', 'Hay productos que no están en el catálogo.');

    const loc = V.location(b, FALLBACK);
    const radius = b.radiusKm === undefined ? 5 : V.num(b.radiusKm, 'radio', 0.2, 20);
    const basket = ids.map((productId) => ({ productId, qty: merged.get(productId) }));
    const near = businessesNear(db, loc, radius);
    const pm = priceMap(db, near.map((x) => x.id), ids);
    const candidates = near.map((x) => ({ id: x.id, lat: x.lat, lng: x.lng, prices: pm.get(x.id).prices }));

    const res = compareBasket(basket, candidates, loc);
    const info = new Map(near.map((x) => [x.id, x]));
    const pub = (r) => {
      const biz = info.get(r.biz.id);
      return {
        business: { id: biz.id, name: biz.name, type: biz.type, address: biz.address, lat: biz.lat, lng: biz.lng },
        km: Math.round(r.km * 1000) / 1000, covered: r.covered, imputed: r.imputed,
      };
    };
    const daysAgo = (ms) => (ms === null ? null : Math.max(0, Math.floor((Date.now() - ms) / 86400e3)));
    let winner = null;
    if (res.winner) {
      const meta = pm.get(res.winner.biz.id);
      winner = { ...pub(res.winner), reports: meta.reports, updatedDaysAgo: daysAgo(meta.lastObserved) };
    }
    return {
      location: { lat: loc.lat, lng: loc.lng, approx: loc.approx },
      basketSize: basket.length, candidates: near.length,
      winner, others: res.others.map(pub),
      savingsPct: res.savingsPct, missing: res.missing, unpriced: res.unpriced,
      lowConfidence: res.lowConfidence, comparableCount: res.comparableCount,
    };
  });
};
