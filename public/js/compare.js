// Precium — comparación de canastas. Lógica pura, sin DOM: se usa en el navegador y
// se puede reutilizar tal cual en el servidor (module.exports) cuando exista la API.
//
// Criterio:
//  1. Ningún comercio tiene precio de todo. Para que los totales sean comparables, el
//     producto que falta se estima con el promedio de los comercios que sí lo tienen.
//  2. Solo compiten los comercios con precio real en al menos 2/3 de los productos
//     (los demás tienen demasiado de estimado para recomendarlos).
//  3. Gana el de menor total estimado. Si empatan: más cobertura, y después el más cerca.
//  4. Nunca se devuelve ningún precio individual: solo el ranking, la cobertura y el ahorro.

(function (root) {
  'use strict';

  const MIN_COVERAGE = 2 / 3;

  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  // basket: [{ productId, qty }] · businesses: [{ id, lat, lng, prices: { productId: precio } }]
  // location: { lat, lng } o null
  function compareBasket(basket, businesses, location, options) {
    const minCoverage = options && options.minCoverage != null ? options.minCoverage : MIN_COVERAGE;

    // Precio de referencia por producto: promedio de los comercios que lo tienen.
    const ref = {};
    basket.forEach(({ productId }) => {
      const known = businesses.map((b) => b.prices[productId]).filter((p) => p != null);
      if (known.length) ref[productId] = known.reduce((s, p) => s + p, 0) / known.length;
    });
    const comparable = basket.filter((i) => ref[i.productId] !== undefined);
    const unpriced = basket.filter((i) => ref[i.productId] === undefined).map((i) => i.productId);

    const results = businesses.map((biz) => {
      let estimated = 0;
      let covered = 0;
      comparable.forEach(({ productId, qty }) => {
        const price = biz.prices[productId];
        if (price != null) { estimated += price * qty; covered += 1; }
        else estimated += ref[productId] * qty;
      });
      return {
        biz,
        estimated,
        covered,
        imputed: comparable.length - covered,
        km: location ? distanceKm(location, biz) : 0,
      };
    });

    const minCount = Math.max(1, Math.ceil(comparable.length * minCoverage - 1e-9));
    let pool = results.filter((r) => r.covered >= minCount);
    const lowConfidence = pool.length === 0;
    if (lowConfidence) pool = results.filter((r) => r.covered > 0);

    pool.sort((a, b) => (a.estimated - b.estimated) || (b.covered - a.covered) || (a.km - b.km));
    const winner = pool[0] || null;

    let savingsPct = 0;
    if (winner && pool.length > 1) {
      const mean = pool.reduce((s, r) => s + r.estimated, 0) / pool.length;
      savingsPct = mean > 0 ? Math.max(0, Math.round((1 - winner.estimated / mean) * 100)) : 0;
    }

    const missing = winner
      ? basket.filter((i) => winner.biz.prices[i.productId] == null).map((i) => i.productId)
      : basket.map((i) => i.productId);

    return {
      winner,
      others: pool.slice(1, 3),
      savingsPct,
      missing,
      unpriced,
      lowConfidence,
      comparableCount: comparable.length,
    };
  }

  const api = { compareBasket, distanceKm, MIN_COVERAGE };
  root.PreciumCompare = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
