# Precium — el mapa del ahorro

Prototipo de comparador de precios de comercios físicos por canasta de compra, para Vicente López.

## Stack

- **Frontend:** HTML + CSS + JavaScript vanilla, servido como archivos estáticos (`public/`).
- **Backend:** Node.js sin dependencias (`server/`): solo módulos que ya trae Node (`http`, `crypto`, `node:sqlite`). No hace falta `npm install`.
- **Base de datos:** SQLite, con el módulo `node:sqlite` que ya trae Node (sin paquetes extra para los scripts de datos).

## Cómo correrlo

Necesitás [Node.js](https://nodejs.org) **22.13 o superior**.

```bash
npm run seed    # una vez: crea precium.sqlite con datos de muestra (o importá SEPA, ver más abajo)
npm start       # servidor en http://localhost:3000
npm run dev     # igual, pero se reinicia al guardar cambios
npm test        # pruebas de la API
```

Variables opcionales: `PORT`, `HOST` (para probar desde el celular en la misma red: `HOST=0.0.0.0`),
`PRECIUM_DB` (ruta de la base) y `PRECIUM_TRUST_PROXY=1` (si va detrás de un proxy con HTTPS).
La cámara en el celular solo funciona con HTTPS o con `localhost`.

Después abrí http://localhost:3000

## API

Todo en JSON. Las escrituras exigen `Content-Type: application/json` y se aceptan solo desde el propio sitio. La sesión va en una cookie `HttpOnly`.

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /api/register` · `/api/login` · `/api/logout` | todos | cuenta y sesión (con límite de intentos) |
| `GET /api/me` · `DELETE /api/me` | cuenta | datos propios · borrar la cuenta (se anonimiza) |
| `GET /api/products?q=` · `/api/products/frequent` | todos | catálogo genérico |
| `GET /api/barcode/:ean` | todos | código de barras → producto |
| `GET /api/businesses?lat&lng&radius` | todos | comercios cercanos (sin precios) |
| `POST /api/compare` | todos | `{items:[{productId,qty}], lat, lng}` → comercio más conveniente, alternativas, ahorro y cobertura. **Nunca devuelve precios** |
| `POST /api/reports` | cuenta | sumar precios `{businessId, source, items:[{productId, priceCents, promo}]}`; los atípicos piden `confirmOutlier` y quedan en revisión |
| `GET/POST /api/baskets` · `DELETE /api/baskets/:id` | cuenta | canastas guardadas |

## Reglas de acceso

- **Invitados:** pueden entrar, armar una canasta (queda solo en su navegador) y consultar el comercio más conveniente.
- **Aportar precios, guardar canastas y subir tickets requiere cuenta.** La base de datos lo hace cumplir: un reporte de origen humano (`receipt`, `barcode`, `manual`) sin `user_id` es rechazado. Solo las fuentes automáticas (`open_data`, `scrape`) pueden no tener usuario.
- Una cuenta con aportes no se borra: se anonimiza (ver comentario en `users` de `schema.sql`).

## Datos de Precios Claros (SEPA)

La base abierta se publica como un zip por día de la semana; cada uno contiene un zip por comercio, y cada comercio tiene `comercio.csv`, `sucursales.csv` y `productos.csv` separados por `|`. Un día pesa cientos de MB y tiene millones de filas, por eso el importador:

1. lee `sucursales.csv` y se queda solo con los locales dentro de un radio de Vicente López (4 km por defecto; si un local no tiene coordenadas válidas, lo acepta por nombre de localidad);
2. ni abre el `productos.csv` de los comercios sin locales en zona;
3. recorre los que sí, línea por línea y sin cargarlos en memoria, y guarda solo los productos que están en el catálogo de Precium;
4. no duplica: si el precio no cambió, solo refresca la fecha de observación.

### 1. Descomprimir

Mac / Linux:

```bash
mkdir -p datos/lunes && unzip -q lunes.zip -d datos/lunes
for z in datos/lunes/*.zip; do d="${z%.zip}"; mkdir -p "$d" && unzip -q "$z" -d "$d" && rm "$z"; done
```

Windows (PowerShell):

```powershell
Expand-Archive lunes.zip -DestinationPath datos\lunes
Get-ChildItem datos\lunes\*.zip | ForEach-Object { Expand-Archive $_ -DestinationPath ($_.FullName -replace '\.zip$','') ; Remove-Item $_ }
```

### 2. Armar el catálogo (una vez, y después cada tanto)

SEPA no tiene productos "genéricos" como "Leche entera 1 L": solo códigos de barras con marca y descripción. Hay que agruparlos a mano.

```bash
npm run import:sepa -- datos/lunes            # con el catálogo vacío solo anota candidatos
npm run catalog -- export candidatos.csv      # los más presentes en comercios de la zona
```

Abrí `candidatos.csv` en una planilla y completá la columna `producto` con el nombre genérico (varias marcas pueden compartir el mismo producto) y, si querés, `categoria`. Las filas sin `producto` se ignoran. Guardalo como **CSV UTF-8** (separado por punto y coma).

```bash
npm run catalog -- link candidatos.csv        # crea productos y variantes
npm run import:sepa -- datos/lunes            # ahora sí carga los precios
```

Opciones: `--db archivo.sqlite`, y en el importador `--lat`, `--lng`, `--radius` (km).

## Estructura

```
public/              sitio estático, lo que ve el usuario
  index.html           landing page
  canasta.html          armar canasta: búsqueda, escáner, canastas guardadas (con cuenta), comparación en el servidor
  contribuir.html        sumar un precio (manual, código de barras o ticket) — requiere cuenta
  login.html registro.html   cuentas reales (contraseña con scrypt, sesión en cookie HttpOnly)
  terminos.html privacidad.html   borradores legales, a revisar antes de lanzar
  css/  js/             estilos y lógica (api.js = cliente de la API, compare.js = ranking de canastas,
                        session.js / auth.js = sesión contra la API)

server/               backend
  index.js              servidor (sitio + API)
  routes/               auth, catalog, compare, reports, baskets
  lib/                  http, auth (scrypt, sesiones), precios, validaciones
  db/
    schema.sql           esquema de la base
    connection.js        abre la base y crea el esquema
    ean.js                normalización de códigos de barras

test/                 pruebas de la API (npm test)

scripts/              herramientas de datos
  import-sepa.js        importador de SEPA / Precios Claros
  catalog.js            armado del catálogo (export / link)
  seed-demo.js          datos de muestra para probar sin importar SEPA
```

## Pendiente

- Recuperar contraseña y verificar el correo (decidimos dejarlo afuera del prototipo).
- Textos legales (`terminos.html`, `privacidad.html`): son un borrador; revisarlos con una persona del área legal y poner un correo de contacto real.
- Locales cerrados de SEPA: agregar `last_seen_at` y ocultar los que dejaron de aparecer en las importaciones.
- Pantalla para revisar los precios atípicos que quedan en estado `flagged`.
- Escaneo de códigos de barras en navegadores sin `BarcodeDetector` (Safari de iPhone, Firefox): hace falta una librería como ZXing. Hoy esa opción queda deshabilitada ahí.
- Escáner de `canasta.html`: hoy solo reconoce 8 códigos de muestra (`EAN_SAMPLES` en scripts/demo-data.js); con la base real se busca el EAN en `product_variants`.
- Reemplazar las fuentes de Google Fonts por Sackers Gothic / Balgin cuando tengamos los archivos.
- Promociones de SEPA (`productos_precio_unitario_promo*`): hoy se ignoran; muchas dependen de tarjeta o día.
- Comparar presentaciones distintas con el precio de referencia por kg/l (`productos_precio_referencia`).

## Mantener los precios de SEPA al día

SEPA publica un archivo por día. El importador es **repetible y no duplica**: se puede correr todos los días, o una vez por semana con todos los días juntos.

```bash
# 1. Descomprimí los zips nuevos en una carpeta (uno por día)
# 2. Importá (se pueden pasar varios días en orden; la fecha de cada precio es la que informa el comercio)
npm run import:sepa -- datos/2026-10-24 datos/2026-10-25
# 3. Productos nuevos de la zona que todavía no están en el catálogo
npm run catalog -- export candidatos.csv
#    completá la columna "producto" de los que quieras sumar y volvé a cargarlos:
npm run catalog -- link candidatos.csv
```

Qué pasa con los cambios:

- **Un precio cambió:** se guarda como un reporte nuevo (queda el historial).
- **Un precio no cambió:** solo se actualiza la fecha de observación (no se duplica).
- **Un archivo más viejo que lo ya cargado:** se ignora.
- **Un local nuevo:** se agrega. **Un local que cambió de dirección o nombre:** se actualiza.
- **Un producto que ya no viene en el archivo:** su último precio queda y envejece solo (la comparación usa la mediana de 30 días y, si no hay, el último de 90).
- **Un local que cerró:** hoy sigue en la base (ver Pendiente).
