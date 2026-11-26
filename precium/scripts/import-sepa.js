#!/usr/bin/env node
// Precium — importador de la base abierta SEPA / Precios Claros.
//
// Uso:
//   node scripts/import-sepa.js <carpeta> [<carpeta> ...] [--db archivo.sqlite]
//        [--lat -34.5267] [--lng -58.5027] [--radius 4]
//
// <carpeta> es una carpeta con los zips YA DESCOMPRIMIDOS: dentro puede haber una
// subcarpeta por comercio, cada una con comercio.csv, sucursales.csv y productos.csv
// (separados por "|"). Las busca recursivamente. Se pueden pasar varios días.
//
// Cómo maneja el volumen (cada día pesa cientos de MB y tiene millones de filas):
//   1. Lee primero sucursales.csv (chico) y se queda SOLO con los locales dentro del radio.
//   2. Si un comercio no tiene ningún local en la zona, ni abre su productos.csv.
//   3. Si lo tiene, recorre productos.csv línea por línea (sin cargarlo en memoria) y
//      descarta todo lo que no sea de esos locales, y todo producto fuera del catálogo.
//   Así la base solo guarda lo que Precium realmente usa.
//
// Requiere Node 22.13 o superior (usa el módulo node:sqlite incluido, sin dependencias).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { normEan } = require('../server/db/ean');

// ---------------------------------------------------------------- configuración
const DEFAULTS = { lat: -34.5267, lng: -58.5027, radius: 4 }; // centro de Vicente López, 4 km
// Plan B si un local no trae coordenadas válidas: se acepta por nombre de localidad.
const FALLBACK_LOCALITIES = [
  'VICENTE LOPEZ', 'OLIVOS', 'FLORIDA', 'FLORIDA OESTE', 'MUNRO',
  'VILLA MARTELLI', 'LA LUCILA', 'CARAPACHAY',
];
const COMMIT_EVERY = 50000;

// ---------------------------------------------------------------- argumentos
function parseArgs(argv) {
  const opts = { dirs: [], db: process.env.PRECIUM_DB || path.join(__dirname, '..', 'precium.sqlite'), ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') opts.db = argv[++i];
    else if (a === '--lat') opts.lat = Number(argv[++i]);
    else if (a === '--lng') opts.lng = Number(argv[++i]);
    else if (a === '--radius') opts.radius = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`Opción desconocida: ${a}`);
    else opts.dirs.push(a);
  }
  if (opts.dirs.length === 0) throw new Error('Falta la carpeta con los CSV descomprimidos.');
  for (const k of ['lat', 'lng', 'radius']) {
    if (!Number.isFinite(opts[k])) throw new Error(`Valor inválido para --${k}`);
  }
  return opts;
}

// ---------------------------------------------------------------- utilidades
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

function toNum(s) {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toCents(s) {
  const n = toNum(s);
  return n !== null && n > 0 ? Math.round(n * 100) : null;
}

function validCoord(lat, lng) {
  // Rango de Argentina; descarta 0,0, coordenadas vacías o con signo perdido.
  return lat !== null && lng !== null && lat >= -56 && lat <= -21 && lng >= -74 && lng <= -53;
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function toSqlUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function businessType(tipo) {
  const t = norm(tipo);
  if (t.includes('HIPER') || t.includes('SUPER')) return 'supermercado';
  if (t.includes('AUTOSERV')) return 'autoservicio';
  return 'otro';
}

// Busca recursivamente carpetas que contengan comercio.csv.
function findComercioDirs(root, depth = 0) {
  if (depth > 6 || !fs.existsSync(root)) return [];
  const found = [];
  if (fs.existsSync(path.join(root, 'comercio.csv'))) found.push(root);
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) found.push(...findComercioDirs(path.join(root, e.name), depth + 1));
  }
  return found;
}

// Lee un CSV separado por "|" línea por línea. onRow(celdas, columnas) es síncrona.
// Con lenient=true también entrega las filas cuyo ancho no coincide con el encabezado
// (onRow decide qué hacer con ellas); si no, esas filas se descartan y se cuentan.
async function streamCsv(file, required, onRow, lenient = false) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let H = null;
  let width = 0;
  let bad = 0;
  for await (let line of rl) {
    if (H === null) {
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); // BOM
      const names = line.split('|').map((s) => s.trim());
      H = Object.fromEntries(names.map((n, i) => [n, i]));
      width = names.length;
      const missing = required.filter((r) => !(r in H));
      if (missing.length) throw new Error(`${path.basename(file)}: faltan columnas ${missing.join(', ')}`);
      continue;
    }
    if (line === '') continue;
    const cells = line.split('|');
    if (cells.length !== width && !lenient) { bad++; continue; }
    onRow(cells, H);
  }
  return { bad };
}

// ---------------------------------------------------------------- principal
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const center = { lat: opts.lat, lng: opts.lng };
  const localities = new Set(FALLBACK_LOCALITIES.map(norm));

  const db = new DatabaseSync(opts.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const hasSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!hasSchema) {
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'schema.sql'), 'utf8'));
    console.log(`Base creada en ${opts.db}`);
  }

  const upsertBusiness = db.prepare(`
    INSERT INTO businesses (name, type, chain, address, locality, lat, lng, source, external_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open_data', ?)
    ON CONFLICT (source, external_id) DO UPDATE SET
      name = excluded.name, type = excluded.type, chain = excluded.chain,
      address = excluded.address, locality = excluded.locality,
      lat = excluded.lat, lng = excluded.lng
    RETURNING id`);
  const latestReport = db.prepare(`
    SELECT id, price_cents, observed_at FROM price_reports
    WHERE business_id = ? AND variant_id = ? AND source = 'open_data'
    ORDER BY observed_at DESC, id DESC LIMIT 1`);
  const touchReport = db.prepare('UPDATE price_reports SET observed_at = ? WHERE id = ?');
  const insertReport = db.prepare(`
    INSERT INTO price_reports (business_id, product_id, variant_id, price_cents, source, observed_at)
    VALUES (?, ?, ?, ?, 'open_data', ?)`);

  // Catálogo: EAN normalizado -> variante ya asignada a un producto genérico.
  const catalog = new Map();
  for (const r of db.prepare(
    'SELECT id, product_id, barcode FROM product_variants WHERE barcode IS NOT NULL AND product_id IS NOT NULL'
  ).all()) catalog.set(r.barcode, { variantId: r.id, productId: r.product_id });
  console.log(`Catálogo: ${catalog.size} códigos de barras asignados.`);
  if (catalog.size === 0) {
    console.log('  (vacío: se van a registrar los productos de la zona en sepa_unmatched para armar el catálogo)');
  }

  const unmatched = new Map(); // ean -> { description, brand, presentation, branches:Set }
  const totals = {
    comercios: 0, comerciosEnZona: 0, locales: 0, localesEnZona: 0, sinCoordenadas: 0,
    filasLeidas: 0, filasMalas: 0, fueraDeCatalogo: 0, sinEan: 0, sinPrecio: 0,
    nuevos: 0, refrescados: 0, viejos: 0,
  };

  let pending = 0;
  const tick = () => {
    if (++pending >= COMMIT_EVERY) { db.exec('COMMIT'); db.exec('BEGIN'); pending = 0; }
  };

  db.exec('BEGIN');
  try {
    for (const root of opts.dirs) {
      const dirs = findComercioDirs(root);
      if (dirs.length === 0) console.warn(`Aviso: no encontré comercio.csv en ${root}`);

      for (const dir of dirs) {
        totals.comercios++;
        // ---- comercio.csv (una sola fila)
        let comercio = null;
        await streamCsv(path.join(dir, 'comercio.csv'),
          ['id_comercio', 'comercio_razon_social', 'comercio_ultima_actualizacion'],
          (c, H) => {
            if (comercio) return; // solo importa la primera fila
            let updated = c[H.comercio_ultima_actualizacion];
            if (c.length !== Object.keys(H).length) {
              // La fila no tiene todas las columnas del encabezado (por ejemplo, falta un campo vacío):
              // la fecha se reconoce por su formato en vez de por su posición.
              console.warn(`Aviso: ${path.basename(dir)}/comercio.csv tiene ${c.length} campos y el encabezado ${Object.keys(H).length}; busco la fecha por su formato.`);
              updated = c.find((x) => /^\d{4}-\d{2}-\d{2}T/.test(x.trim()));
            }
            comercio = {
              id: c[H.id_comercio].trim(),
              razon: c[H.comercio_razon_social].trim(),
              bandera: ('comercio_bandera_nombre' in H ? c[H.comercio_bandera_nombre] : '').trim(),
              updated: toSqlUtc(updated),
            };
          }, true);
        if (!comercio) { console.warn(`Aviso: ${dir}/comercio.csv sin filas`); continue; }
        if (!comercio.updated) {
          comercio.updated = new Date().toISOString().slice(0, 19).replace('T', ' ');
          console.warn(`Aviso: ${dir}: fecha de actualización inválida; uso la fecha actual.`);
        }

        // ---- sucursales.csv: quedarse solo con los locales de la zona
        const selected = new Map(); // 'comercio-bandera-sucursal' -> business_id
        await streamCsv(path.join(dir, 'sucursales.csv'),
          ['id_comercio', 'id_bandera', 'id_sucursal'],
          (c, H) => {
            totals.locales++;
            const get = (n) => (n in H ? c[H[n]].trim() : '');
            const lat = toNum(get('sucursales_latitud'));
            const lng = toNum(get('sucursales_longitud'));
            let inside;
            if (validCoord(lat, lng)) inside = haversineKm(center, { lat, lng }) <= opts.radius;
            else { totals.sinCoordenadas++; inside = localities.has(norm(get('sucursales_localidad'))); }
            if (!inside) return;

            const key = `${get('id_comercio')}-${get('id_bandera')}-${get('id_sucursal')}`;
            const address = [get('sucursales_calle'), get('sucursales_numero')].filter(Boolean).join(' ');
            const row = upsertBusiness.get(
              get('sucursales_nombre') || comercio.razon,
              businessType(get('sucursales_tipo')),
              comercio.bandera || comercio.razon,
              address || null,
              get('sucursales_localidad') || null,
              validCoord(lat, lng) ? lat : null,
              validCoord(lat, lng) ? lng : null,
              key,
            );
            selected.set(key, row.id);
            totals.localesEnZona++;
            tick();
          });

        if (selected.size === 0) continue; // ni se abre productos.csv
        totals.comerciosEnZona++;

        // ---- productos.csv: solo filas de esos locales y de productos del catálogo
        const stats = await streamCsv(path.join(dir, 'productos.csv'),
          ['id_comercio', 'id_bandera', 'id_sucursal', 'productos_ean', 'productos_precio_lista'],
          (c, H) => {
            totals.filasLeidas++;
            const bizId = selected.get(`${c[H.id_comercio].trim()}-${c[H.id_bandera].trim()}-${c[H.id_sucursal].trim()}`);
            if (bizId === undefined) return;

            const ean = normEan(c[H.productos_ean]);
            if (!ean) { totals.sinEan++; return; }
            const price = toCents(c[H.productos_precio_lista]);
            if (price === null) { totals.sinPrecio++; return; }

            const variant = catalog.get(ean);
            if (!variant) {
              totals.fueraDeCatalogo++;
              let u = unmatched.get(ean);
              if (!u) {
                const get = (n) => (n in H ? c[H[n]].trim() : '');
                u = {
                  description: get('productos_descripcion'),
                  brand: get('productos_marca'),
                  presentation: [get('productos_cantidad_presentacion'), get('productos_unidad_medida_presentacion')]
                    .filter(Boolean).join(' '),
                  branches: new Set(),
                };
                unmatched.set(ean, u);
              }
              u.branches.add(bizId);
              return;
            }

            // Un precio nuevo solo si cambió; si es igual, se refresca la fecha de observación.
            const last = latestReport.get(bizId, variant.variantId);
            if (last) {
              if (comercio.updated <= last.observed_at) { totals.viejos++; return; }
              if (last.price_cents === price) {
                touchReport.run(comercio.updated, last.id);
                totals.refrescados++; tick(); return;
              }
            }
            insertReport.run(bizId, variant.productId, variant.variantId, price, comercio.updated);
            totals.nuevos++; tick();
          });
        totals.filasMalas += stats.bad;
        console.log(`  ${comercio.razon} (${comercio.id}): ${selected.size} local(es) en zona`);
      }
    }

    // ---- tabla de trabajo con lo que falta clasificar
    db.exec('DELETE FROM sepa_unmatched');
    const insUn = db.prepare(
      'INSERT INTO sepa_unmatched (ean, description, brand, presentation, branch_count, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const [ean, u] of unmatched) insUn.run(ean, u.description, u.brand, u.presentation, u.branches.size, now);

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* sin transacción abierta */ }
    throw err;
  }

  const mb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log('\nResumen');
  console.log(`  Comercios revisados: ${totals.comercios} (con locales en zona: ${totals.comerciosEnZona})`);
  console.log(`  Locales: ${totals.locales} leídos, ${totals.localesEnZona} en zona, ${totals.sinCoordenadas} sin coordenadas válidas`);
  console.log(`  Filas de productos leídas (solo comercios con locales en zona): ${totals.filasLeidas}`);
  console.log(`  Precios: ${totals.nuevos} nuevos, ${totals.refrescados} refrescados, ${totals.viejos} ya cargados o más viejos`);
  console.log(`  Fuera del catálogo: ${totals.fueraDeCatalogo} filas (${unmatched.size} productos distintos, ver tabla sepa_unmatched)`);
  console.log(`  Descartadas: ${totals.sinEan} sin EAN válido, ${totals.sinPrecio} sin precio, ${totals.filasMalas} con formato roto`);
  console.log(`  Memoria máxima usada: ${mb} MB`);
  db.close();
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
