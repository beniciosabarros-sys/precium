-- Precium — esquema de base de datos (SQLite)
--
-- Principios de diseño:
--  1. Los precios NUNCA se sobrescriben: cada observación es una fila nueva en
--     price_reports. El "precio actual" se calcula al comparar (mediana de los
--     reportes recientes), lo que permite filtrar atípicos y ponderar frescura.
--  2. Los productos de la canasta son genéricos (products). Las marcas concretas
--     son variantes (product_variants) con código de barras y foto opcional.
--  3. Los precios se guardan en centavos (INTEGER) para evitar errores de coma flotante.
--  4. Las fechas son texto ISO 8601 en UTC, formato 'YYYY-MM-DD HH:MM:SS' (el de datetime('now')).
--  5. Consultar es libre; APORTAR requiere cuenta. Un reporte de origen humano
--     (ticket, código de barras, manual) exige user_id; solo las fuentes automáticas
--     (scrape, open_data) pueden no tenerlo. Lo hace cumplir la base de datos, no solo la API.
--  6. Los códigos de barras se guardan normalizados: solo dígitos y sin ceros a la
--     izquierda (ver server/db/ean.js). Normalizar siempre antes de buscar.
--
-- Activar claves foráneas en CADA conexión: PRAGMA foreign_keys = ON;

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- usuarios
-- Una cuenta con aportes no se borra: se anonimiza (email/contraseña/nombre) y se
-- completa deleted_at. Así los reportes siguen existiendo sin datos personales.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

-- ---------------------------------------------------------------- comercios
-- Un comercio es un LOCAL físico (una sucursal), no una empresa.
CREATE TABLE businesses (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'supermercado','autoservicio','almacen','kiosco','despensa',
                'verduleria','carniceria','panaderia','farmacia',
                'comida_rapida','restaurante','ecommerce','otro')),
  chain       TEXT,                       -- cadena o bandera, si corresponde
  address     TEXT,
  locality    TEXT,
  lat         REAL CHECK (lat BETWEEN -90 AND 90),
  lng         REAL CHECK (lng BETWEEN -180 AND 180),
  source      TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','user','open_data','scrape')),
  external_id TEXT,                       -- id en la fuente externa; SEPA: 'id_comercio-id_bandera-id_sucursal'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)            -- evita duplicar al reimportar; NULL se permite repetido
);
CREATE INDEX idx_businesses_geo ON businesses (lat, lng);

-- ---------------------------------------------------------------- catálogo
CREATE TABLE categories (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Producto genérico: lo que el usuario pone en su canasta ("Leche entera 1 L").
CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories (id),
  unit        TEXT NOT NULL DEFAULT 'un' CHECK (unit IN ('un','kg','l'))
);
CREATE INDEX idx_products_category ON products (category_id);

-- Variante: una marca/presentación concreta (un código de barras).
-- product_id puede ser NULL: variante conocida pero todavía sin clasificar.
-- Los precios importados solo se guardan para variantes ya asignadas a un producto.
CREATE TABLE product_variants (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER REFERENCES products (id) ON DELETE SET NULL,
  brand        TEXT NOT NULL DEFAULT '',
  description  TEXT,                      -- texto original de la fuente
  presentation TEXT,                      -- p. ej. '1 l', '500 g'
  barcode      TEXT UNIQUE,               -- EAN normalizado; NULL si todavía no lo conocemos
  image_path   TEXT                       -- miniatura local (~100 px), no un link externo
);
CREATE INDEX idx_variants_product ON product_variants (product_id);

-- Textos alternativos para reconocer productos (OCR de tickets, importaciones).
-- alias_text se guarda normalizado (minúsculas, sin acentos ni espacios dobles) desde la app.
CREATE TABLE product_aliases (
  id         INTEGER PRIMARY KEY,
  alias_text TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants (id) ON DELETE SET NULL
);
CREATE INDEX idx_aliases_product ON product_aliases (product_id);

-- Tabla de trabajo: productos vistos en la importación SEPA (dentro de la zona) que
-- todavía no están en el catálogo. Se regenera en cada importación; sirve para elegir
-- cuáles clasificar primero (los más presentes en comercios de la zona).
CREATE TABLE sepa_unmatched (
  ean          TEXT PRIMARY KEY,
  description  TEXT,
  brand        TEXT,
  presentation TEXT,
  branch_count INTEGER NOT NULL,
  last_seen    TEXT NOT NULL
);

-- ---------------------------------------------------------------- tickets
-- Solo guardamos el hash de la imagen (para detectar duplicados); la foto se descarta.
CREATE TABLE receipts (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  business_id  INTEGER NOT NULL REFERENCES businesses (id),
  image_hash   TEXT NOT NULL UNIQUE,
  receipt_date TEXT NOT NULL,
  total_cents  INTEGER CHECK (total_cents IS NULL OR total_cents > 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- precios
CREATE TABLE price_reports (
  id          INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses (id),
  product_id  INTEGER NOT NULL REFERENCES products (id),
  variant_id  INTEGER REFERENCES product_variants (id),   -- NULL = producto genérico / marca desconocida
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),   -- precio por la presentación del producto
  is_promo    INTEGER NOT NULL DEFAULT 0 CHECK (is_promo IN (0,1)),
  source      TEXT NOT NULL CHECK (source IN ('receipt','barcode','manual','scrape','open_data')),
  user_id     INTEGER REFERENCES users (id) ON DELETE RESTRICT,  -- NULL solo en fuentes automáticas
  receipt_id  INTEGER REFERENCES receipts (id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','flagged','rejected')),
  observed_at TEXT NOT NULL,              -- cuándo se vio el precio (no cuándo se cargó)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (source IN ('scrape','open_data') OR user_id IS NOT NULL)   -- aportar requiere cuenta
);
CREATE INDEX idx_reports_lookup  ON price_reports (business_id, product_id, observed_at);
CREATE INDEX idx_reports_product ON price_reports (product_id, observed_at);
CREATE INDEX idx_reports_user    ON price_reports (user_id);
-- Usado por el importador para encontrar el último precio de una variante en un local.
CREATE INDEX idx_reports_variant ON price_reports (business_id, variant_id, source, observed_at);

-- ---------------------------------------------------------------- canastas
-- Un invitado arma su canasta en el navegador; guardarla en la base requiere cuenta.
CREATE TABLE baskets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);

CREATE TABLE basket_items (
  basket_id  INTEGER NOT NULL REFERENCES baskets (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity   REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),  -- REAL: permite 0.5 kg
  PRIMARY KEY (basket_id, product_id)
);

-- ---------------------------------------------------------------- vistas
-- Reportes válidos de los últimos 30 días, sin promociones. La app calcula la
-- mediana sobre estas filas (SQLite no trae función de mediana).
CREATE VIEW v_recent_reports AS
SELECT id, business_id, product_id, price_cents, observed_at
FROM price_reports
WHERE status = 'active'
  AND is_promo = 0
  AND observed_at >= datetime('now', '-30 days');

-- Último precio conocido por comercio y producto: punto de partida simple
-- mientras no hay suficientes reportes para calcular medianas.
CREATE VIEW v_latest_price AS
SELECT business_id, product_id, price_cents, observed_at
FROM (
  SELECT business_id, product_id, price_cents, observed_at,
         ROW_NUMBER() OVER (
           PARTITION BY business_id, product_id
           ORDER BY observed_at DESC, id DESC
         ) AS rn
  FROM price_reports
  WHERE status = 'active' AND is_promo = 0
)
WHERE rn = 1;

-- ---------------------------------------------------------------- sesiones
-- Se guarda el hash (SHA-256) del token de la cookie, nunca el token: si se filtra la base,
-- nadie puede usar las sesiones. Las sesiones vencidas se borran al iniciar el servidor.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
