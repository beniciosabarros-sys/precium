// Precium — carga datos de muestra (los mismos de public/js/data.js) en la base, para poder
// probar el sitio completo sin haber importado SEPA todavía.
//
//   node scripts/seed-demo.js [--db ./precium.sqlite]
//
// No toca una base que ya tenga productos. Los precios de muestra se cargan como 'open_data'
// (fuente automática, sin usuario), igual que los de SEPA.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { openDb } = require('../server/db/connection');
const { normEan } = require('../server/db/ean');

const TYPES = { Autoservicio: 'autoservicio', 'Almacén': 'almacen', Supermercado: 'supermercado', Despensa: 'despensa' };

function loadSample() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'demo-data.js'), 'utf8')
    + '\n;({ CATALOG, BUSINESSES, EAN_SAMPLES });';
  return vm.runInNewContext(code);
}

function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return { skipped: true };
  const { CATALOG, BUSINESSES, EAN_SAMPLES } = loadSample();
  const sqlDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  db.exec('BEGIN');
  try {
    const prod = {};
    const insProd = db.prepare('INSERT INTO products (name, unit) VALUES (?, ?)');
    CATALOG.forEach((p) => { prod[p.id] = Number(insProd.run(p.name, p.unit).lastInsertRowid); });

    const insVar = db.prepare('INSERT INTO product_variants (product_id, brand, description, barcode) VALUES (?, ?, ?, ?)');
    Object.entries(EAN_SAMPLES).forEach(([ean, pid]) => insVar.run(prod[pid], '', 'Código de muestra', normEan(ean)));

    const insBiz = db.prepare("INSERT INTO businesses (name, type, locality, lat, lng, source) VALUES (?, ?, 'Vicente López', ?, ?, 'manual')");
    const insRep = db.prepare("INSERT INTO price_reports (business_id, product_id, price_cents, source, observed_at) VALUES (?, ?, ?, 'open_data', ?)");
    BUSINESSES.forEach((b) => {
      const id = Number(insBiz.run(b.name, TYPES[b.type] || 'otro', b.lat, b.lng).lastInsertRowid);
      const when = sqlDate(Date.now() - b.updatedDaysAgo * 86400e3);
      Object.entries(b.prices).forEach(([pid, price]) => insRep.run(id, prod[pid], Math.round(price * 100), when));
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { skipped: false };
}

if (require.main === module) {
  const i = process.argv.indexOf('--db');
  const file = i > -1 ? process.argv[i + 1] : process.env.PRECIUM_DB || path.join(__dirname, '..', 'precium.sqlite');
  const r = seedDemo(openDb(file));
  console.log(r.skipped ? `La base ${file} ya tiene productos: no se cargó nada.` : `Datos de muestra cargados en ${file}.`);
}
module.exports = { seedDemo };
