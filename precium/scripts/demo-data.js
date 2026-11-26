// Precium — datos de muestra (los usa scripts/seed-demo.js; el sitio ya no los lee).
// Todo esto se reemplaza más adelante por datos reales desde la API / base de datos.
// Las coordenadas son aproximadas, en la zona de Vicente López.

const CATALOG = [
  { id: 'leche',    name: 'Leche entera 1 L',          unit: 'un' },
  { id: 'arroz',    name: 'Arroz largo fino 1 kg',      unit: 'un' },
  { id: 'aceite',   name: 'Aceite de girasol 900 ml',   unit: 'un' },
  { id: 'yerba',    name: 'Yerba mate 500 g',           unit: 'un' },
  { id: 'huevos',   name: 'Huevos, docena',             unit: 'un' },
  { id: 'pan',      name: 'Pan francés',                unit: 'kg' },
  { id: 'fideos',   name: 'Fideos secos 500 g',         unit: 'un' },
  { id: 'azucar',   name: 'Azúcar 1 kg',                unit: 'un' },
  { id: 'cafe',     name: 'Café molido 250 g',          unit: 'un' },
  { id: 'phigien',  name: 'Papel higiénico x4',         unit: 'un' },
  { id: 'deterg',   name: 'Detergente 750 ml',          unit: 'un' },
  { id: 'manteca',  name: 'Manteca 200 g',              unit: 'un' },
  { id: 'queso',    name: 'Queso cremoso',               unit: 'kg' },
  { id: 'tomate',   name: 'Tomate redondo',              unit: 'kg' },
  { id: 'banana',   name: 'Banana',                      unit: 'kg' },
  { id: 'pollo',    name: 'Pechuga de pollo',            unit: 'kg' },
];

const FREQUENT_IDS = ['leche', 'pan', 'arroz', 'aceite', 'huevos', 'yerba'];

// precios en pesos argentinos (de muestra). Un producto ausente en un comercio
// significa que todavía no tenemos ningún reporte de precio para él ahí.
const BUSINESSES = [
  {
    id: 'esquina',
    name: 'Autoservicio La Esquina',
    type: 'Autoservicio',
    lat: -34.5279,
    lng: -58.5047,
    reports: 14,
    updatedDaysAgo: 2,
    prices: {
      leche: 1250, arroz: 1800, aceite: 2400, yerba: 3100, huevos: 2900,
      pan: 2600, fideos: 1400, azucar: 1500, cafe: 4200, phigien: 2100,
      deterg: 2300, manteca: 1700, queso: 6800, tomate: 2200, banana: 1600, pollo: 5200,
    },
  },
  {
    id: 'central',
    name: 'Almacén Central',
    type: 'Almacén',
    lat: -34.5251,
    lng: -58.5002,
    reports: 9,
    updatedDaysAgo: 4,
    prices: {
      leche: 1300, arroz: 1750, aceite: 2550, huevos: 2850,
      pan: 2500, fideos: 1350, azucar: 1450, phigien: 2250,
      deterg: 2200, manteca: 1650, queso: 7100, tomate: 2100, banana: 1550,
      // sin yerba, sin café, sin pollo todavía
    },
  },
  {
    id: 'norte',
    name: 'Súper Norte',
    type: 'Supermercado',
    lat: -34.5312,
    lng: -58.5091,
    reports: 21,
    updatedDaysAgo: 1,
    prices: {
      leche: 1190, arroz: 1690, aceite: 2350, yerba: 2950, huevos: 2750,
      pan: 2450, fideos: 1300, azucar: 1400, cafe: 3950, phigien: 1980,
      deterg: 2150, manteca: 1600, queso: 6500, tomate: 2050, banana: 1500, pollo: 4900,
    },
  },
  {
    id: 'barrio',
    name: 'Despensa del Barrio',
    type: 'Despensa',
    lat: -34.5231,
    lng: -58.4978,
    reports: 5,
    updatedDaysAgo: 6,
    prices: {
      leche: 1280, yerba: 3250, huevos: 3000,
      pan: 2700, fideos: 1450, azucar: 1550, phigien: 2300,
      // despensa chica: cobertura más baja a propósito
    },
  },
];

// Ubicación de referencia si el navegador no comparte la ubicación real
// (más o menos el centro de Vicente López).
const FALLBACK_LOCATION = { lat: -34.5267, lng: -58.5027 };

// Códigos de barras de muestra (EAN-13 con dígito verificador válido) -> producto del catálogo.
// Sirven para probar el escaneo de la canasta. Con la base real, esta relación sale de
// product_variants.barcode (ver server/db/schema.sql).
const EAN_SAMPLES = {
  '7799000000013': 'leche',
  '7799000000020': 'arroz',
  '7799000000037': 'aceite',
  '7799000000044': 'yerba',
  '7799000000051': 'huevos',
  '7799000000068': 'fideos',
  '7799000000075': 'azucar',
  '7799000000082': 'cafe',
};
