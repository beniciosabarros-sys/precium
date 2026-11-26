// Precium — canastas guardadas (requiere cuenta).

'use strict';

const { HttpError } = require('../lib/http');
const V = require('../lib/validate');

const MAX_BASKETS = 20;

module.exports = function register(router, { db }) {
  function load(userId) {
    const baskets = db.prepare('SELECT id, name FROM baskets WHERE user_id = ? ORDER BY created_at, id').all(userId);
    const items = db.prepare(`SELECT bi.basket_id AS b, bi.product_id AS productId, bi.quantity AS qty, p.name, p.unit FROM basket_items bi
      JOIN baskets k ON k.id = bi.basket_id JOIN products p ON p.id = bi.product_id WHERE k.user_id = ?`).all(userId);
    return baskets.map((k) => ({ id: k.id, name: k.name, items: items.filter((i) => i.b === k.id).map(({ b, ...i }) => i) }));
  }

  router.add('GET', '/api/baskets', (c) => ({ baskets: load(c.requireUser().id) }));

  router.add('POST', '/api/baskets', async (c) => {
    const user = c.requireUser();
    const b = await c.body();
    const name = V.str(b.name, 'nombre', 1, 30);
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 60) throw V.bad('invalid_items', 'La canasta tiene que tener entre 1 y 60 productos.');
    const map = new Map();
    b.items.forEach((i) => {
      if (!i || typeof i !== 'object') throw V.bad('invalid_items', 'La canasta tiene un producto inválido.');
      map.set(V.int(i.productId, 'producto', 1, 2 ** 31), V.num(i.qty === undefined ? 1 : i.qty, 'cantidad', 0.1, 99));
    });
    const ids = [...map.keys()];
    if (db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).length !== ids.length) {
      throw new HttpError(400, 'unknown_product', 'Hay productos que no están en el catálogo.');
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM baskets WHERE user_id = ?').get(user.id).n >= MAX_BASKETS) {
      throw new HttpError(409, 'too_many_baskets', `Podés guardar hasta ${MAX_BASKETS} canastas. Borrá alguna para sumar otra.`);
    }
    if (db.prepare('SELECT 1 FROM baskets WHERE user_id = ? AND name = ?').get(user.id, name)) {
      throw new HttpError(409, 'name_taken', 'Ya tenés una canasta con ese nombre.');
    }
    db.exec('BEGIN');
    let id;
    try {
      id = Number(db.prepare('INSERT INTO baskets (user_id, name) VALUES (?, ?)').run(user.id, name).lastInsertRowid);
      const ins = db.prepare('INSERT INTO basket_items (basket_id, product_id, quantity) VALUES (?, ?, ?)');
      map.forEach((qty, pid) => ins.run(id, pid, qty));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { status: 201, body: { basket: load(user.id).find((k) => k.id === id) } };
  });

  router.add('DELETE', '/api/baskets/:id', (c) => {
    const user = c.requireUser();
    const id = Number(c.params.id);
    const r = db.prepare('DELETE FROM baskets WHERE id = ? AND user_id = ?').run(Number.isInteger(id) ? id : -1, user.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No encontramos esa canasta.');
    return { ok: true };
  });
};
