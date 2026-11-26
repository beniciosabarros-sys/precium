// Precium — precio "actual" por comercio y producto, calculado desde price_reports.
// Regla: mediana de los reportes activos (sin promociones) de los últimos 30 días; si no hay,
// el más reciente de los últimos 90. Los precios individuales nunca salen del servidor.

'use strict';

const { distanceKm } = require('../../public/js/compare.js');

const TYPES_NO_PHYSICAL = ['ecommerce'];

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Comercios con coordenadas dentro de radiusKm (caja aproximada en SQL y distancia real en JS).
function businessesNear(db, loc, radiusKm, limit) {
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.cos(loc.lat * Math.PI / 180));
  const rows = db.prepare(`SELECT id, name, type, address, lat, lng FROM businesses
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND type NOT IN (${TYPES_NO_PHYSICAL.map(() => '?').join(',')})`)
    .all(loc.lat - dLat, loc.lat + dLat, loc.lng - dLng, loc.lng + dLng, ...TYPES_NO_PHYSICAL);
  const out = rows.map((b) => ({ ...b, km: distanceKm(loc, b) })).filter((b) => b.km <= radiusKm).sort((a, b) => a.km - b.km);
  return limit ? out.slice(0, limit) : out;
}

const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

// -> Map(businessId -> { prices: {productId: cents}, reports, lastObserved })
function priceMap(db, businessIds, productIds) {
  const result = new Map(businessIds.map((id) => [id, { prices: {}, reports: 0, lastObserved: null }]));
  if (!businessIds.length || !productIds.length) return result;
  const cutoff30 = Date.now() - 30 * 86400e3;
  const prodMarks = productIds.map(() => '?').join(',');
  const grouped = new Map(); // "biz:prod" -> [{ cents, t }]

  chunks(businessIds, 500).forEach((part) => {
    const rows = db.prepare(`SELECT business_id AS b, product_id AS p, price_cents AS c, observed_at AS o FROM price_reports
      WHERE status = 'active' AND is_promo = 0 AND observed_at >= datetime('now','-90 days')
        AND business_id IN (${part.map(() => '?').join(',')}) AND product_id IN (${prodMarks})`).all(...part, ...productIds);
    rows.forEach((r) => {
      const k = `${r.b}:${r.p}`;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push({ cents: r.c, t: Date.parse(r.o.replace(' ', 'T') + 'Z') });
    });
  });

  grouped.forEach((list, k) => {
    const [b, p] = k.split(':').map(Number);
    const entry = result.get(b);
    const recent = list.filter((x) => x.t >= cutoff30);
    entry.prices[p] = recent.length ? median(recent.map((x) => x.cents)) : list.reduce((a, x) => (x.t > a.t ? x : a)).cents;
    entry.reports += recent.length;
    const newest = Math.max(...list.map((x) => x.t));
    if (entry.lastObserved === null || newest > entry.lastObserved) entry.lastObserved = newest;
  });
  return result;
}

module.exports = { median, businessesNear, priceMap };
