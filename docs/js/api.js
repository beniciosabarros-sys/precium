// Precium — cliente de la API. Todas las pantallas hablan con el servidor a través de acá.
// Los errores llegan como ApiError con: status, code (ver server/routes), message (listo para mostrar) y extra.

(function () {
  'use strict';

  class ApiError extends Error {
    constructor(status, code, message, extra) {
      super(message);
      this.status = status;
      this.code = code;
      this.extra = extra || {};
    }
  }

  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, 'network', 'No pudimos conectar con el servidor. Revisá tu conexión y probá de nuevo.');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuesta sin JSON */ }
    if (!res.ok) {
      const err = (data && data.error) || {};
      const { code, message, ...extra } = err;
      throw new ApiError(res.status, code || 'error', message || 'Algo salió mal. Probá de nuevo.', extra);
    }
    return data;
  }

  const qs = (o) => {
    const p = new URLSearchParams();
    Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  };

  window.PreciumAPI = {
    ApiError,
    me: () => call('GET', '/api/me'),
    register: (name, email, password) => call('POST', '/api/register', { name, email, password }),
    login: (email, password) => call('POST', '/api/login', { email, password }),
    logout: () => call('POST', '/api/logout', {}),
    deleteAccount: (password) => call('DELETE', '/api/me', { password }),
    products: (q, limit) => call('GET', '/api/products' + qs({ q, limit })),
    product: (id) => call('GET', '/api/products/' + encodeURIComponent(id)),
    frequent: () => call('GET', '/api/products/frequent'),
    barcode: (ean) => call('GET', '/api/barcode/' + encodeURIComponent(ean)),
    businesses: (loc, radius, limit) => call('GET', '/api/businesses' + qs({ lat: loc && loc.lat, lng: loc && loc.lng, radius, limit })),
    business: (id) => call('GET', '/api/businesses/' + encodeURIComponent(id)),
    compare: (items, loc) => call('POST', '/api/compare', { items, ...(loc && !loc.approx ? { lat: loc.lat, lng: loc.lng } : {}) }),
    report: (payload) => call('POST', '/api/reports', payload),
    baskets: () => call('GET', '/api/baskets'),
    saveBasket: (name, items) => call('POST', '/api/baskets', { name, items }),
    deleteBasket: (id) => call('DELETE', '/api/baskets/' + encodeURIComponent(id)),
  };
})();
