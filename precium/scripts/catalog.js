#!/usr/bin/env node
// Precium — armado del catálogo a partir de los productos de la base SEPA.
//
// El ciclo de trabajo es:
//   1. node scripts/import-sepa.js <carpeta>          (con el catálogo vacío solo anota candidatos)
//   2. node scripts/catalog.js export candidatos.csv   (los más presentes en comercios de la zona)
//   3. Abrir candidatos.csv en una planilla y completar la columna "producto" con el nombre
//      GENÉRICO ("Leche entera 1 L") en las filas que quieran usar; varias filas pueden
//      compartir el mismo producto (distintas marcas). Las filas sin "producto" se ignoran.
//      Guardar como "CSV UTF-8" (separado por punto y coma).
//   4. node scripts/catalog.js link candidatos.csv     (crea productos y variantes)
//   5. node scripts/import-sepa.js <carpeta>          (ahora sí carga los precios)
//
// Opciones: --db archivo.sqlite   --limit 500 (solo en export)
// Requiere Node 22.13 o superior.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { normEan } = require('../server/db/ean');

const SEP = ';';
const COLUMNS = ['producto', 'unidad', 'categoria', 'ean', 'descripcion', 'marca', 'presentacion', 'locales'];

function parseArgs(argv) {
  const opts = { cmd: argv[0], file: argv[1], db: process.env.PRECIUM_DB || path.join(__dirname, '..', 'precium.sqlite'), limit: 500 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') opts.db = argv[++i];
    else if (argv[i] === '--limit') opts.limit = Number(argv[++i]);
    else throw new Error(`Opción desconocida: ${argv[i]}`);
  }
  if (!['export', 'link'].includes(opts.cmd) || !opts.file) {
    throw new Error('Uso: node scripts/catalog.js export|link <archivo.csv> [--db archivo.sqlite] [--limit 500]');
  }
  return opts;
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// CSV con ";" y comillas dobles (como lo guarda Excel en español).
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === SEP) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const quote = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCandidates(opts) {
  const db = openDb(opts.db);
  const rows = db.prepare(
    'SELECT ean, description, brand, presentation, branch_count FROM sepa_unmatched ORDER BY branch_count DESC, ean LIMIT ?'
  ).all(opts.limit);
  if (rows.length === 0) console.log('No hay candidatos: corré primero scripts/import-sepa.js.');
  const lines = [COLUMNS.join(SEP)];
  for (const r of rows) {
    lines.push(['', 'un', '', r.ean, r.description, r.brand, r.presentation, r.branch_count].map(quote).join(SEP));
  }
  fs.writeFileSync(opts.file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM para que Excel abra bien los acentos
  console.log(`${rows.length} candidatos escritos en ${opts.file}`);
  db.close();
}

function linkCatalog(opts) {
  const text = fs.readFileSync(opts.file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('El archivo no tiene filas.');
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  for (const need of ['producto', 'ean']) {
    if (!header.includes(need)) throw new Error(`Falta la columna "${need}". Revisá que esté separado por punto y coma.`);
  }
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const db = openDb(opts.db);
  const findCategory = db.prepare('SELECT id FROM categories WHERE name = ?');
  const addCategory = db.prepare('INSERT INTO categories (name) VALUES (?) RETURNING id');
  const upsertProduct = db.prepare(`
    INSERT INTO products (name, category_id, unit) VALUES (?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET
      category_id = COALESCE(excluded.category_id, products.category_id), unit = excluded.unit
    RETURNING id`);
  const upsertVariant = db.prepare(`
    INSERT INTO product_variants (product_id, brand, description, presentation, barcode)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (barcode) DO UPDATE SET
      product_id = excluded.product_id, brand = excluded.brand,
      description = excluded.description, presentation = excluded.presentation`);

  let linked = 0;
  let skipped = 0;
  const warnings = [];
  db.exec('BEGIN');
  try {
    lines.slice(1).forEach((line, i) => {
      const c = splitCsvLine(line);
      const get = (n) => (n in col && c[col[n]] !== undefined ? c[col[n]].trim() : '');
      const name = get('producto');
      if (!name) { skipped++; return; }
      const ean = normEan(get('ean'));
      if (!ean) { warnings.push(`Fila ${i + 2}: EAN inválido "${get('ean')}"`); return; }
      const unit = get('unidad').toLowerCase() || 'un';
      if (!['un', 'kg', 'l'].includes(unit)) { warnings.push(`Fila ${i + 2}: unidad "${unit}" (usá un, kg o l)`); return; }

      let categoryId = null;
      const cat = get('categoria');
      if (cat) categoryId = (findCategory.get(cat) || addCategory.get(cat)).id;
      const product = upsertProduct.get(name, categoryId, unit);
      upsertVariant.run(product.id, get('marca'), get('descripcion') || null, get('presentacion') || null, ean);
      linked++;
    });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* sin transacción abierta */ }
    throw err;
  }
  console.log(`${linked} códigos de barras asignados, ${skipped} filas sin producto ignoradas.`);
  warnings.forEach((w) => console.warn(`Aviso: ${w}`));
  db.close();
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'export') exportCandidates(opts); else linkCatalog(opts);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
