const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path = require('path');
const pub = path.join(__dirname, '..', 'public', 'js') + path.sep;
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'demo-data.js'), 'utf8'), ctx);
const BUSINESSES = vm.runInContext('BUSINESSES', ctx);
const { compareBasket } = require(pub + 'compare.js');
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
let n = 0; const ok = (label) => console.log('  OK  ', label, ++n && '');

// 1) Datos de muestra, cálculo a mano: leche + yerba
let r = compareBasket([{ productId: 'leche', qty: 1 }, { productId: 'yerba', qty: 1 }], BUSINESSES, null);
assert.strictEqual(r.winner.biz.id, 'norte');
assert(near(r.winner.estimated, 1190 + 2950));
assert.strictEqual(r.savingsPct, 5);                         // 1 - 4140 / mean(4350, 4140, 4530)
assert(!r.others.some((o) => o.biz.id === 'central'));        // Central tiene 1 de 2 productos: queda afuera
ok('muestra: Súper Norte gana, ahorro 5 %, el comercio con cobertura baja no compite');

// 2) El caso que el criterio anterior resolvía mal: lleno pero caro vs. barato con un faltante
const A = { id: 'A', lat: 0, lng: 0, prices: { x: 100, y: 100, z: 100 } };
const B = { id: 'B', lat: 0, lng: 0, prices: { x: 60, y: 60 } };
r = compareBasket(['x', 'y', 'z'].map((p) => ({ productId: p, qty: 1 })), [A, B], null);
assert.strictEqual(r.winner.biz.id, 'B'); assert(near(r.winner.estimated, 220)); assert.strictEqual(r.winner.imputed, 1);
ok('el barato con un faltante le gana al completo y caro (220 estimado vs 300)');

// 3) Cantidades
r = compareBasket([{ productId: 'x', qty: 3 }], [A, B], null);
assert.strictEqual(r.winner.biz.id, 'B'); assert(near(r.winner.estimated, 180));
ok('las cantidades pesan (3 × 60 = 180)');

// 4) Cobertura mínima de 2/3
const C = { id: 'C', lat: 0, lng: 0, prices: { x: 1 } };    // baratísimo pero solo 1 de 3
r = compareBasket(['x', 'y', 'z'].map((p) => ({ productId: p, qty: 1 })), [A, B, C], null);
assert.strictEqual(r.winner.biz.id, 'B'); assert(!r.others.some((o) => o.biz.id === 'C'));
ok('un comercio con 1 de 3 productos no puede ganar aunque sea baratísimo');

// 5) Productos sin precio en ningún comercio no distorsionan
r = compareBasket([{ productId: 'x', qty: 1 }, { productId: 'q', qty: 1 }], [A, B], null);
assert.deepStrictEqual(r.unpriced, ['q']); assert.strictEqual(r.comparableCount, 1); assert.strictEqual(r.winner.biz.id, 'B');
assert(r.missing.includes('q'));
ok('un producto sin ningún precio se informa aparte y no cuenta en la comparación');

// 6) Sin ningún dato
r = compareBasket([{ productId: 'q', qty: 1 }], [A, B], null);
assert.strictEqual(r.winner, null); assert.deepStrictEqual(r.missing, ['q']);
ok('sin datos no inventa un ganador');

// 7) Empate: desempata la distancia
const P = { id: 'P', lat: 0, lng: 0.05, prices: { x: 10 } }, Q = { id: 'Q', lat: 0, lng: 0.01, prices: { x: 10 } };
r = compareBasket([{ productId: 'x', qty: 1 }], [P, Q], { lat: 0, lng: 0 });
assert.strictEqual(r.winner.biz.id, 'Q'); assert.strictEqual(r.savingsPct, 0);
ok('con el mismo precio gana el más cercano y el ahorro es 0');

// 8) Baja confianza: nadie llega a 2/3
const D = { id: 'D', lat: 0, lng: 0, prices: { x: 5 } }, E = { id: 'E', lat: 0, lng: 0, prices: { y: 5 } };
r = compareBasket(['x', 'y', 'z'].map((p) => ({ productId: p, qty: 1 })), [D, E, { id: 'F', lat: 0, lng: 0, prices: { z: 9 } }], null);
assert.strictEqual(r.lowConfidence, true); assert(r.winner);
ok('si nadie llega a 2/3 igual orienta, pero lo marca como poco confiable');

// 9) No filtra precios individuales en el resultado
const text = JSON.stringify(compareBasket([{ productId: 'leche', qty: 1 }], BUSINESSES, null).others.map((o) => ({ id: o.biz.id, covered: o.covered })));
assert(!/1250|1300|1190/.test(text)); ok('lo que se muestra de los otros comercios no incluye precios');
console.log('Todo OK');
