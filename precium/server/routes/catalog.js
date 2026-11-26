// Precium — catálogo y comercios cercanos. Nada de esto expone precios.

'use strict';

const { HttpError } = require('../lib/http');
const { normEan } = require('../db/ean');
const { businessesNear } = require('../lib/prices');
const FALLBACK = { lat: -34.5267, lng: -58.5027 }; // centro de Vicente López

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

module.exports = function register(router, { db }) {
  // El catálogo es chico (productos genéricos, no marcas): se guarda en memoria un minuto.
  let cache = { at: 0, list: [] };
  function products() {
    if (Date.now() - cache.at > 60e3) {
      cache = {
        at: Date.now(),
        list: db.prepare(`SELECT p.id, p.name, p.unit, c.name AS category FROM products p
          LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.name`).all().map((p) => ({ ...p, key: norm(p.name) })),
      };
    }
    return cache.list;
  }
  const strip = ({ key, ...rest }) => rest;

  router.add('GET', '/api/products', (c) => {
    const q = norm(c.query.get('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(c.query.get('limit'), 10) || 20, 1), 500);
    return { products: products().filter((p) => !q || p.key.includes(q)).slice(0, limit).map(strip) };
  });

  // Más presentes en comercios con precios recientes: sirven de atajos en "Armar canasta".
  router.add('GET', '/api/products/frequent', () => {
    const rows = db.prepare(`SELECT p.id, p.name, p.unit, COUNT(DISTINCT r.business_id) AS n FROM price_reports r
      JOIN products p ON p.id = r.product_id
      WHERE r.status = 'active' AND r.is_promo = 0 AND r.observed_at >= datetime('now','-30 days')
      GROUP BY p.id ORDER BY n DESC, p.name LIMIT 6`).all();
    return { products: rows.map(({ n, ...p }) => p) };
  });

  router.add('GET', '/api/products/:id', (c) => {
    const id = Number(c.params.id);
    const p = Number.isInteger(id) ? products().find((x) => x.id === id) : null;
    if (!p) throw new HttpError(404, 'not_found', 'No encontramos ese producto.');
    return { product: strip(p) };
  });

  router.add('GET', '/api/barcode/:ean', (c) => {
    const ean = normEan(c.params.ean);
    if (!ean) throw new HttpError(400, 'invalid_barcode', 'El código de barras no es válido.');
    const row = db.prepare(`SELECT p.id, p.name, p.unit, v.brand, v.presentation FROM product_variants v
      JOIN products p ON p.id = v.product_id WHERE v.barcode = ?`).get(ean);
    if (!row) throw new HttpError(404, 'unknown_barcode', 'No conocemos este código todavía.');
    return { product: { id: row.id, name: row.name, unit: row.unit }, variant: { brand: row.brand, presentation: row.presentation } };
  });

  router.add('GET', '/api/businesses/:id', (c) => {
    const id = Number(c.params.id);
    const b = Number.isInteger(id) ? db.prepare('SELECT id, name, type, address, lat, lng FROM businesses WHERE id = ?').get(id) : null;
    if (!b) throw new HttpError(404, 'not_found', 'No encontramos ese comercio.');
    return { business: b };
  });

  router.add('GET', '/api/businesses', (c) => {
    const lat = parseFloat(c.query.get('lat')), lng = parseFloat(c.query.get('lng'));
    const has = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const loc = has ? { lat, lng } : FALLBACK;
    const limit = Math.min(Math.max(parseInt(c.query.get('limit'), 10) || 30, 1), 50);
    const radius = Math.min(Math.max(parseFloat(c.query.get('radius')) || 5, 0.1), 20);
    return {
      approx: !has,
      businesses: businessesNear(db, loc, radius, limit).map((b) => ({
        id: b.id, name: b.name, type: b.type, address: b.address, lat: b.lat, lng: b.lng, km: Math.round(b.km * 1000) / 1000,
      })),
    };
  });
};
module.exports.FALLBACK = FALLBACK;
