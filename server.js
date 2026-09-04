const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { getChatReply } = require('./chat');
const { construirRecibo, previsualizarRecibo } = require('./escpos-recibo');
const { getInventario, mapPladeItemToProduct, isPladeConfigured, saveOrderToPlade, normalizarSucursales } = require('./plade-marketplade-client');
const adminUsers = require('./admin-users');
const { FUNCIONES, permisosEfectivos, tienePermiso, normalizarPermisos } = require('./permisos');
const productImages = require('./product-images');
const {
  isLoyaltyConfigured,
  getLoyaltyForUser,
  listLoyaltyLevels,
  recordPurchase,
  listPurchases,
  getPurchase,
  setPurchaseStatus,
  countPurchases,
  deletePurchasesByOrderIds,
} = require('./supabase-admin');
const { isCartReminderConfigured, sendAbandonedCartReminders } = require('./email-reminders');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Captura del pago que adjunta el cliente en el checkout — límite más chico que el de arriba
// (pensado para inventario) y solo imágenes, ya que es lo único que tiene sentido pedir acá.
const uploadPaymentProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// El backend sirve archivos subidos por clientes (capturas de pago) y HTML del panel viejo, y no
// mandaba ninguna cabecera de seguridad — esas están puestas en Vercel, que solo cubre la tienda.
// `nosniff` impide que el navegador "adivine" el tipo de un archivo y termine ejecutando como
// página algo que se sirvió como imagen; el resto niega que este dominio se pueda meter en un
// iframe ajeno y evita filtrar el orderId (que ES la llave del comprobante) por el Referer.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Render termina el TLS y pasa la IP real del visitante en X-Forwarded-For. Sin esto `req.ip`
// devuelve la IP del proxy para TODO el mundo, y cualquier límite por IP castigaría a todos por
// igual — incluido el dueño. Un solo salto de confianza, que es exactamente lo que hay delante.
app.set('trust proxy', 1);

// El catálogo y las fichas son públicos y los consume la tienda desde otro dominio, así que ahí
// CORS abierto es correcto.
//
// SALTEA /api/admin A PROPÓSITO. La primera versión de este arreglo dejaba este `cors()` cubriendo
// todo /api y añadía después una política restrictiva para el panel — y no servía de nada: cuando
// el origen NO está permitido, el middleware de abajo no escribe ninguna cabecera, así que
// sobrevivía el `Access-Control-Allow-Origin: *` que este ya había puesto. Verificado contra
// producción: un origen ajeno seguía recibiendo `*`.
const corsPublico = cors();
app.use('/api', (req, res, next) => {
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  return corsPublico(req, res, next);
});

// Pero el panel NO. Antes `app.use('/api', cors())` también dejaba a cualquier página del mundo
// llamar a /api/admin/* desde el navegador de un administrador logueado. Hoy no era explotable
// —el token va en una cabecera Authorization que el navegador no adjunta solo, así que no hay
// CSRF— pero es permiso regalado sin ninguna razón. Se restringe a los orígenes propios.
const ORIGENES_PANEL = [
  'https://cristal44.com',
  'https://www.cristal44.com',
  'http://localhost:3001', // desarrollo
];
app.use('/api/admin', cors({
  origin: (origin, cb) => cb(null, !origin || ORIGENES_PANEL.includes(origin)),
  credentials: false,
}));

// Si DATA_DIR apunta a un disco persistente de Render (ver README), los datos sobreviven a los
// redeploys. Sin esa variable, cae de vuelta a la carpeta local del repo (efímera en Render free).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
// Ventas hechas en la web que todavía no se reflejan en el stock de PLADE (PLADE recién descuenta
// cuando el dueño procesa/confirma el pago a mano ahí, no cuando llega el pedido) — ver
// replaceProductsCatalog() y getMergedProducts() más abajo para el porqué de esta capa aparte.
const STOCK_ADJUSTMENTS_FILE = path.join(DATA_DIR, 'stock_adjustments.json');
const DETAILS_FILE = path.join(DATA_DIR, 'product_details.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders_location.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
// Categorías pausadas: las que NO se le muestran al cliente aunque PLADE las siga mandando. Vive en
// el disco persistente (/var/data) y no en Supabase a propósito — se consulta en CADA request del
// catálogo público, y pegarle a la base por eso sería absurdo. Se guarda por NOMBRE de categoría,
// no por id de producto: así una pausa sobrevive a las sincronizaciones con PLADE, que reemplazan
// el catálogo entero cada 30 minutos.
const PAUSED_CATEGORIES_FILE = path.join(DATA_DIR, 'paused_categories.json');
// Visitas al sitio, AGREGADAS POR DÍA. No se guarda un registro por visita ni la IP de nadie: solo
// cuántas hubo, de qué país y cuántas eran sesiones nuevas. Así el archivo no crece sin control y
// no hay datos personales que proteger — el panel viejo ya filtró datos de clientes una vez
// (sección 2.6 del HANDOFF) y no hace falta volver a crear ese riesgo para contar visitas.
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
// Cola de impresión de la tienda. Vive en el disco y no en memoria porque su razón de ser es
// sobrevivir: si la PC del local está apagada cuando entra un pedido, el trabajo espera ahí hasta
// que el agente vuelva. Un reinicio de Render tampoco debe perder un pedido sin imprimir.
// De qué sedes de PLADE se toma el inventario. Vive en el disco y no en una variable de entorno
// porque el dueño lo cambia desde el panel: abrir una sede nueva no debería exigir un despliegue.
const INVENTORY_CONFIG_FILE = path.join(DATA_DIR, 'inventory_config.json');
// Aparatos con notificaciones activas. Es una lista de "direcciones de entrega" que dan los
// servicios de push (Google, Apple, Mozilla): no son datos de la persona ni permiten identificar el
// teléfono, solo entregarle un aviso.
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subscriptions.json');
const PRINT_QUEUE_FILE = path.join(DATA_DIR, 'print_queue.json');
// Qué impresora usar y cómo. Lo edita el dueño desde el panel.
const PRINT_CONFIG_FILE = path.join(DATA_DIR, 'print_config.json');
const ORDERS_PDF_DIR = path.join(DATA_DIR, 'orders_pdfs');
const ORDERS_PAYMENT_PROOFS_DIR = path.join(DATA_DIR, 'orders_payment_proofs');
const ORDERS_RECEIPTS_DIR = path.join(DATA_DIR, 'orders_receipts');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
// Panel nuevo (cristal44.com/admin) con usuario+contraseña en vez del password-suelto-por-formulario
// que usan las pantallas HTML viejas (/admin, /admin/purchases, etc. — esas no se tocan). "admin"
// reutiliza el mismo ADMIN_PASSWORD de siempre (un solo secreto que administrar); "salidas" es una
// cuenta nueva y separada, pensada para la persona que solo escanea códigos a la salida — no tiene
// acceso a nada más del panel (el backend se lo niega, no es solo un tema de UI).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const SALIDAS_USERNAME = process.env.SALIDAS_USERNAME || 'salidas';
const SALIDAS_PASSWORD = process.env.SALIDAS_PASSWORD || 'changeme';
// Firma los tokens de sesión del panel nuevo (ver login/verifyAdminToken más abajo). Mismo patrón
// de fallback "changeme" que ADMIN_PASSWORD — hay que fijarlo de verdad en el Environment de Render.
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'changeme-token-secret';
// Secreto separado del ADMIN_PASSWORD para el cron externo que dispara el envío de recordatorios
// de carrito (/cron/cart-reminders) — así ese secreto puede vivir en la URL configurada en un
// servicio de cron de terceros sin exponer la contraseña real del panel de administración.
const CRON_SECRET = process.env.CRON_SECRET;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(STOCK_ADJUSTMENTS_FILE)) fs.writeFileSync(STOCK_ADJUSTMENTS_FILE, '{}');
if (!fs.existsSync(DETAILS_FILE)) fs.writeFileSync(DETAILS_FILE, '{}');
if (!fs.existsSync(REVIEWS_FILE)) fs.writeFileSync(REVIEWS_FILE, '{}');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '{}');
if (!fs.existsSync(PAUSED_CATEGORIES_FILE)) fs.writeFileSync(PAUSED_CATEGORIES_FILE, '{}');
if (!fs.existsSync(VISITS_FILE)) fs.writeFileSync(VISITS_FILE, '{}');
// Arranca con Depósito General (1) + Av Bolívar (5): lo pidió el dueño el 2026-09-02 tras ver que
// esa combinación deja 4.356 productos a la venta, contra 4.755 de todas las sedes y 3.810 de solo
// Av Bolívar. A partir de acá manda el panel — esto solo siembra el archivo la primera vez.
if (!fs.existsSync(INVENTORY_CONFIG_FILE)) fs.writeFileSync(INVENTORY_CONFIG_FILE, JSON.stringify({ sucursales: [1, 5] }, null, 2));
if (!fs.existsSync(PUSH_SUBS_FILE)) fs.writeFileSync(PUSH_SUBS_FILE, '[]');
if (!fs.existsSync(PRINT_QUEUE_FILE)) fs.writeFileSync(PRINT_QUEUE_FILE, '[]');
if (!fs.existsSync(PRINT_CONFIG_FILE)) fs.writeFileSync(PRINT_CONFIG_FILE, '{}');
if (!fs.existsSync(ORDERS_PDF_DIR)) fs.mkdirSync(ORDERS_PDF_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_PAYMENT_PROOFS_DIR)) fs.mkdirSync(ORDERS_PAYMENT_PROOFS_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_RECEIPTS_DIR)) fs.mkdirSync(ORDERS_RECEIPTS_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Column mapping heuristics (Spanish inventory exports) ---
const FIELD_SYNONYMS = {
  name: ['nombre', 'producto', 'articulo', 'item', 'descripcioncorta'],
  description: ['descripcion', 'detalle', 'observacion'],
  price: ['preciousd', 'preciodolar', 'preciodolares', 'precioventausd', 'precio', 'precioventa', 'preciounitario'],
  stock: ['existencia', 'stock', 'cantidad', 'disponible', 'existencias'],
  category: ['categoria', 'rubro', 'departamento', 'grupo'],
  sku: ['codigo', 'sku', 'referencia', 'cod', 'codigoproducto'],
  image: ['imagen', 'foto', 'urlimagen', 'image'],
  width: ['ancho', 'anchocm', 'width'],
  height: ['alto', 'altocm', 'height'],
  length: ['largo', 'largocm', 'profundidad', 'length', 'depth'],
  material: ['material', 'materiales'],
  weight: ['peso', 'pesog', 'pesokg', 'weight'],
  color: ['color', 'colores'],
};

// Fields editable manually from /admin/products (in addition to whatever the Excel provides)
const DETAIL_FIELDS = ['width', 'height', 'length', 'material', 'weight', 'color', 'image', 'image2', 'image3', 'image4', 'video', 'description'];

// Mapeo de columnas del importador masivo de detalles (POST /admin/details-upload). Aparte de
// FIELD_SYNONYMS a propósito: ese alimenta la carga del catálogo CRUDO (/admin/upload) y no debe
// cambiar de comportamiento. Este, en cambio, escribe en product_details.json — la capa que
// sobrevive a las sincronizaciones con PLADE, que es justo lo que hace falta para las imágenes
// 2-5 y las descripciones (getInventario solo devuelve UN campo `imagen` y ninguna descripción
// larga; verificado contra la instancia real el 2026-08-09, ver HANDOFF 2.11).
const DETAIL_FIELD_SYNONYMS = {
  sku: ['codigo', 'sku', 'referencia', 'cod', 'codigoproducto', 'codigointerno', 'id'],
  description: ['descripcion', 'descripcionlarga', 'detalle', 'observacion', 'texto'],
  image: ['imagen', 'imagen1', 'foto', 'foto1', 'urlimagen', 'image', 'image1'],
  image2: ['imagen2', 'foto2', 'image2', 'urlimagen2'],
  image3: ['imagen3', 'foto3', 'image3', 'urlimagen3'],
  image4: ['imagen4', 'foto4', 'image4', 'urlimagen4'],
  video: ['video', 'urlvideo', 'videourl'],
  material: ['material', 'materiales'],
  color: ['color', 'colores'],
  width: ['ancho', 'anchocm', 'width'],
  height: ['alto', 'altocm', 'height'],
  length: ['largo', 'largocm', 'profundidad', 'length', 'depth'],
  weight: ['peso', 'pesog', 'pesokg', 'weight'],
};

const DETAIL_TEXT_FIELDS = ['description', 'image', 'image2', 'image3', 'image4', 'video', 'material', 'color'];
const DETAIL_NUMBER_FIELDS = ['width', 'height', 'length', 'weight'];

/**
 * Lee un CSV/XLSX detectando la codificación. SheetJS, ante un CSV sin BOM, asume la codepage
 * heredada de Windows (1252/Latin-1): un archivo UTF-8 entra como "macramÃ©" en vez de "macramé".
 * Forzar siempre 65001 tampoco sirve — Excel en Windows exporta CSV en ANSI por defecto y esos se
 * romperían al revés. Por eso se decide por archivo: si el contenido es UTF-8 válido, se lee como
 * UTF-8; si no, se deja que SheetJS aplique su codepage por defecto.
 * (Los .xlsx no se ven afectados: guardan el texto en UTF-8 dentro del ZIP y SheetJS ya lo respeta.)
 */
function readWorkbookAutoEncoding(buffer) {
  const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let isUtf8 = hasUtf8Bom;
  if (!isUtf8) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      isUtf8 = true;
    } catch {
      isUtf8 = false; // secuencias inválidas en UTF-8 => es un archivo de codepage heredada
    }
  }
  return XLSX.read(buffer, { type: 'buffer', ...(isUtf8 ? { codepage: 65001 } : {}) });
}

function normalize(header) {
  return String(header)
    .normalize('NFD')
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// `synonyms` es parametrizable para que el importador de detalles pueda usar su propio mapeo
// (DETAIL_FIELD_SYNONYMS) sin alterar el de la carga del catálogo crudo, que sigue siendo el default.
function buildColumnMap(headers, synonymMap = FIELD_SYNONYMS) {
  const normalizedHeaders = headers.map(normalize);
  const map = {};
  for (const [field, synonyms] of Object.entries(synonymMap)) {
    const idx = normalizedHeaders.findIndex((h) => synonyms.includes(h));
    if (idx !== -1) map[field] = headers[idx];
  }
  return map;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  const cleaned = String(value).replace(/[^0-9.,-]/g, '').replace(/\.(?=.*\.)/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = parseNumber(value);
  return num || num === 0 ? num : null;
}

function rowsToProducts(rows, columnMap) {
  return rows.map((row, index) => {
    const name = columnMap.name ? row[columnMap.name] : null;
    if (!name) return null;
    return {
      id: columnMap.sku && row[columnMap.sku] ? String(row[columnMap.sku]) : String(index + 1),
      title: String(name).trim(),
      description: columnMap.description ? String(row[columnMap.description] ?? '').trim() : '',
      price: parseNumber(columnMap.price ? row[columnMap.price] : 0),
      stock: columnMap.stock ? Math.trunc(parseNumber(row[columnMap.stock])) : null,
      category: columnMap.category ? String(row[columnMap.category] ?? '').trim() : 'General',
      image: columnMap.image ? String(row[columnMap.image] ?? '').trim() : '',
      width: columnMap.width ? parseOptionalNumber(row[columnMap.width]) : null,
      height: columnMap.height ? parseOptionalNumber(row[columnMap.height]) : null,
      length: columnMap.length ? parseOptionalNumber(row[columnMap.length]) : null,
      material: columnMap.material ? String(row[columnMap.material] ?? '').trim() || null : null,
      weight: columnMap.weight ? parseOptionalNumber(row[columnMap.weight]) : null,
      color: columnMap.color ? String(row[columnMap.color] ?? '').trim() || null : null,
      image2: null,
      image3: null,
      image4: null,
      video: null,
    };
  }).filter(Boolean);
}

// Cachea en memoria de proceso el contenido de un JSON (products/details/reviews/stock_adjustments)
// — GET /api/products/:id releía los 4 archivos del disco en CADA llamada, y el build estático de
// tienda_web le pega ~8700 veces seguidas durante un deploy; esa lectura sincrónica repetida era
// carga real de más sobre un solo proceso Node, y varias veces terminó tumbando el backend a mitad
// del build (ver server.js history). save() actualiza la caché con el mismo objeto que ya se está
// escribiendo, así que nunca queda desincronizada con el archivo.
function makeJsonStore(filePath) {
  let cache = null;
  return {
    load() {
      if (cache === null) cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return cache;
    },
    save(data) {
      cache = data;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    },
  };
}

const productsStore = makeJsonStore(PRODUCTS_FILE);
const stockAdjustmentsStore = makeJsonStore(STOCK_ADJUSTMENTS_FILE);

function loadProducts() {
  return productsStore.load();
}

function loadStockAdjustments() {
  return stockAdjustmentsStore.load();
}

function saveStockAdjustments(adjustments) {
  stockAdjustmentsStore.save(adjustments);
}

// Descuenta (delta negativo, una venta) o repone (delta positivo, una anulación desde
// /admin/purchases) stock — pero SIN tocar PRODUCTS_FILE. PLADE recién descuenta su propio stock
// cuando el dueño procesa/confirma el pago a mano ahí (no cuando llega el pedido automático), así
// que si tocáramos PRODUCTS_FILE directo, la sincronización de los 30 min lo pisaría de vuelta al
// número viejo antes de que PLADE se entere de la venta — literalmente deshaciendo el descuento.
// En cambio, esto se acumula en stock_adjustments.json (una capa aparte que se resta en
// getMergedProducts()) y se va reconciliando sola en replaceProductsCatalog() más abajo, a medida
// que el stock de PLADE realmente baja. No deja que lo pendiente baje de 0.
function adjustStock(items, delta) {
  const adjustments = loadStockAdjustments();
  for (const item of items) {
    const pending = Math.max(0, (adjustments[item.id] || 0) - delta * item.quantity);
    if (pending > 0) adjustments[item.id] = pending;
    else delete adjustments[item.id];
  }
  saveStockAdjustments(adjustments);
}

// Reemplaza el catálogo crudo (sincronización con PLADE o carga manual de Excel/CSV en
// /admin/upload) y reconcilia stock_adjustments.json de paso: por cada producto cuyo stock bajó
// respecto a la versión anterior, ese tanto ya lo procesó PLADE (sea nuestra venta online o una
// venta en tienda física — no hay forma de distinguir cuál, pero no importa: cualquier baja real
// cuenta como "ya lo tiene en cuenta PLADE") — se le resta esa baja a lo pendiente, para no
// descontarlo dos veces. Si el stock sube (reposición) o queda igual, lo pendiente no se toca:
// sigue esperando a que PLADE procese esa venta puntual.
function replaceProductsCatalog(newProducts) {
  const oldById = new Map(loadProducts().map((p) => [p.id, p]));
  const adjustments = loadStockAdjustments();
  for (const p of newProducts) {
    const pending = adjustments[p.id];
    if (!pending) continue;
    const old = oldById.get(p.id);
    if (!old || old.stock === null || p.stock === null) continue;
    const drop = Math.max(0, old.stock - p.stock);
    if (drop <= 0) continue;
    const remaining = Math.max(0, pending - drop);
    if (remaining > 0) adjustments[p.id] = remaining;
    else delete adjustments[p.id];
  }
  saveStockAdjustments(adjustments);
  productsStore.save(newProducts);
}

const detailsStore = makeJsonStore(DETAILS_FILE);
const reviewsStore = makeJsonStore(REVIEWS_FILE);
const pausedCategoriesStore = makeJsonStore(PAUSED_CATEGORIES_FILE);
const visitsStore = makeJsonStore(VISITS_FILE);
const inventoryConfigStore = makeJsonStore(INVENTORY_CONFIG_FILE);
const pushSubsStore = makeJsonStore(PUSH_SUBS_FILE);
const printQueueStore = makeJsonStore(PRINT_QUEUE_FILE);
const printConfigStore = makeJsonStore(PRINT_CONFIG_FILE);

function loadDetails() {
  return detailsStore.load();
}

function saveDetails(details) {
  detailsStore.save(details);
}

function loadReviews() {
  return reviewsStore.load();
}

function saveReviews(reviews) {
  reviewsStore.save(reviews);
}

function loadOrdersLocation() {
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
}

function saveOrdersLocation(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function loadCustomers() {
  return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8'));
}

function saveCustomers(customers) {
  fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify(customers, null, 2));
}

const DELIVERY_METHOD_LABELS = {
  pickup: 'Retiro en tienda (Pickup)',
  homeDelivery: 'Delivery a domicilio (Gran Valencia)',
  nationalShipping: 'Envío nacional',
  internationalShipping: 'Envío internacional',
};
// Espejo de tienda_web/lib/pickup-stores.ts (PICKUP_STORES_BY_COUNTRY, todas las sedes).
const PICKUP_STORE_LABELS = {
  avBolivarNorte: 'Sede Valencia, C.C. Salva Market',
  avUniversidad: 'Sede Naguanagua, C.C. La Granja',
  miami: 'Sede Miami, Miami, Florida',
  bogota: 'Sede Bogotá, Bogotá',
  medellin: 'Sede Medellín, Medellín',
};
// Espejo de tienda_web/lib/payment-methods.ts (PAYMENT_METHODS_BY_COUNTRY, los 3 países).
const PAYMENT_METHOD_LABELS = {
  pagoMovil: 'Pago Móvil (Bs)',
  binance: 'Binance (USDT)',
  zinli: 'Zinli (Panamá)',
  zelle: 'Zelle (USD)',
  cash: 'Efectivo contra entrega',
  boaTransfer: 'Transferencia Bank of America',
  paypal: 'PayPal',
  bizum: 'Bizum (Euro)',
  bancolombia: 'Bancolombia',
  nequi: 'Nequi',
  binanceUsdt: 'Binance (USDT)',
};
// Espejo de tienda_web/lib/couriers.ts (COURIERS_BY_COUNTRY + INTERNATIONAL_COURIERS).
const COURIER_LABELS = {
  mrw: 'MRW',
  zoom: 'Zoom',
  tealca: 'Tealca',
  usps: 'USPS',
  ups: 'UPS',
  fedex: 'FedEx',
  dhl: 'DHL',
  servientrega: 'Servientrega',
  coordinadora: 'Coordinadora',
  tcc: 'TCC',
  envia: 'Envía',
  dhlExpress: 'DHL Express',
  fedexInternational: 'FedEx International',
  upsWorldwide: 'UPS Worldwide',
};
// Espejo de tienda_web/lib/delivery-zones.ts — solo aplica cuando paymentMethod es "cash".
const DELIVERY_ZONE_LABELS = {
  valencia: 'Valencia',
  naguanagua: 'Naguanagua',
  sanDiego: 'San Diego',
  guacaraFlorAmarillo: 'Guacara y Flor Amarillo',
  libertadorTocuyito: 'Libertador/Tocuyito',
};

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

// Miles con punto, decimales con coma — igual que tienda_web/lib/format.ts, para que el PDF
// coincida con cómo se ve el precio en Bs durante el checkout.
function formatBs(amount) {
  const fixed = Number(amount).toFixed(2);
  const [intPart, decimals] = fixed.split('.');
  let grouped = '';
  for (let i = 0; i < intPart.length; i++) {
    const posFromEnd = intPart.length - i;
    grouped += intPart[i];
    if (posFromEnd > 1 && posFromEnd % 3 === 1) grouped += '.';
  }
  return `Bs ${grouped},${decimals}`;
}

// Peso colombiano: sin decimales, miles con punto — igual que tienda_web/lib/format.ts.
function formatCop(amount) {
  const rounded = Math.round(Number(amount));
  const digits = String(rounded);
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    const posFromEnd = digits.length - i;
    grouped += digits[i];
    if (posFromEnd > 1 && posFromEnd % 3 === 1) grouped += '.';
  }
  return `COP ${grouped}`;
}

// 1mm en puntos PDF (72 puntos por pulgada, 25.4mm por pulgada).
function mm(value) {
  return (value * 72) / 25.4;
}

const RECEIPT_WIDTH = mm(80); // ancho estándar de rollo térmico
const RECEIPT_MARGIN = mm(4); // 80mm - 4mm*2 = 72mm de área imprimible, el estándar de la industria
const RECEIPT_CONTENT_WIDTH = RECEIPT_WIDTH - RECEIPT_MARGIN * 2;
const RECEIPT_MAX_HEIGHT = mm(1000); // alto holgado solo para medir, se recorta al alto real después

function drawReceiptDivider(doc) {
  doc.moveDown(0.2);
  const y = doc.y;
  // Negro puro (no gris) — una impresora térmica simula el gris con menos densidad de puntos, y
  // sale rayado/débil en el papel real (se vio clarito en un recibo impreso y escaneado que trajo
  // el dueño). Todo el recibo es monocromático en negro a propósito por lo mismo.
  doc.moveTo(doc.x, y).lineTo(doc.x + RECEIPT_CONTENT_WIDTH, y).lineWidth(0.7).strokeColor('#000').stroke();
  doc.moveDown(0.4);
}

// Dibuja todo el contenido del recibo sobre un documento ya creado. Se llama dos veces (ver
// generateOrderPdfBuffer): una para medir cuánta altura ocupa el contenido real, y otra para
// generar el PDF final con esa altura exacta — así no se imprime papel en blanco de más.
function drawReceiptBody(doc, order, barcodeBuffer) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text('El Imperio del Cristal', { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Bisutería y accesorios', { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000');
  doc.text(`Pedido: ${order.orderId}`, { align: 'center' });
  doc.text(`Fecha: ${new Date(order.createdAt).toLocaleString('es-VE')}`, { align: 'center' });
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Datos del cliente');
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text(`Nombre: ${order.nombre}`);
  doc.text(`Identificación: ${order.idType}-${order.cedula}`);
  doc.text(`Teléfono: ${order.telefono}`);
  doc.text(`Correo: ${order.correo}`);
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).text('Entrega');
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text(`Estado: ${order.estado}`);
  doc.text(`Ciudad: ${order.ciudad}`);
  doc.text(`Parroquia: ${order.parroquia}`);
  doc.text(`Dirección: ${order.address}`);
  doc.text(`Método: ${DELIVERY_METHOD_LABELS[order.deliveryMethod] || order.deliveryMethod}`);
  if (order.deliveryMethod === 'pickup' && order.pickupStore) {
    doc.text(`Sede: ${PICKUP_STORE_LABELS[order.pickupStore] || order.pickupStore}`);
  }
  if ((order.deliveryMethod === 'nationalShipping' || order.deliveryMethod === 'internationalShipping') && order.courier) {
    doc.text(`Empresa de envío: ${COURIER_LABELS[order.courier] || order.courier}`);
  }
  if (order.deliveryMethod === 'internationalShipping' && order.destinationCountry) {
    doc.text(`País de destino: ${order.destinationCountry}`);
  }
  if (order.deliveryMethod === 'homeDelivery' && order.deliveryZone) {
    const zoneLabel = DELIVERY_ZONE_LABELS[order.deliveryZone] || order.deliveryZone;
    doc.text(`Zona: ${zoneLabel} (+${formatUsd(order.deliveryFee || 0)})`);
  }
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).text('Pago');
  doc.font('Helvetica-Bold').fontSize(8);
  doc.text(`Método: ${PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod}`);
  if (order.reference) doc.text(`Referencia: ${order.reference}`);
  if (order.paymentHolderName) doc.text(`Titular del pago: ${order.paymentHolderName}`);
  if (order.paymentMethod === 'pagoMovil' && order.bcvRate) {
    doc.text(`Monto a pagar: ${formatBs(order.total * order.bcvRate)}`);
    doc.text(`(tasa BCV: ${formatBs(order.bcvRate)} por $1)`);
  }
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).text('Productos');
  doc.moveDown(0.2);
  for (const item of order.items) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text(item.id);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(item.title);
    doc.font('Helvetica-Bold').fontSize(8);
    doc.text(`${item.quantity} x ${formatUsd(item.price)} = ${formatUsd(item.price * item.quantity)}`);
    doc.moveDown(0.3);
  }
  drawReceiptDivider(doc);

  if (order.discountApplied) {
    const subtotal = order.total + order.discountApplied.amount - (order.deliveryFee || 0);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(`Subtotal: ${formatUsd(subtotal)}`, { align: 'right' });
    doc.text(
      `Descuento nivel ${order.discountApplied.tier} (-${order.discountApplied.percent}%): -${formatUsd(order.discountApplied.amount)}`,
      { align: 'right' }
    );
    doc.moveDown(0.2);
  }

  doc.font('Helvetica-Bold').fontSize(11).text(`Total: ${formatUsd(order.total)}`, { align: 'right' });
  // La moneda secundaria del total depende del país del pedido: Bs solo para Venezuela, COP solo
  // para Colombia, ninguna para EEUU (aunque el request traiga bcvRate/trmRate, el país manda).
  if (order.country === 'CO' && order.trmRate) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(`(${formatCop(order.total * order.trmRate)})`, { align: 'right' });
  } else if (order.country !== 'US' && order.country !== 'CO' && order.bcvRate) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(`(${formatBs(order.total * order.bcvRate)})`, { align: 'right' });
  }

  // Código QR del número de pedido: permite escanear y validar en tienda que esta venta no se
  // procese/entregue dos veces (ver POST /api/admin/scan). No es un ID de pago externo, solo el
  // orderId propio.
  if (barcodeBuffer) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('Código de verificación del pedido', { align: 'center' });
    doc.moveDown(0.2);
    // Cuadrado de 32mm — cómodo para escanear de cerca en el mostrador, bien adentro de los
    // 72mm imprimibles (80mm de rollo - 4mm de margen a cada lado). `align: 'center'` solo no
    // centra bien combinado con `fit` (bug conocido de pdfkit) — se calcula la posición X a mano.
    const qrSize = mm(32);
    const qrX = doc.x + (RECEIPT_CONTENT_WIDTH - qrSize) / 2;
    doc.image(barcodeBuffer, qrX, doc.y, { fit: [qrSize, qrSize] });
    doc.y += qrSize;
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(order.orderId, { align: 'center' });
  }
}

// Genera el PDF de resumen de un pedido (para descarga del cliente, envío por WhatsApp, e
// impresión en impresora térmica de 80mm). Usa pdfkit porque no requiere un navegador headless.
// Como pdfkit necesita el tamaño de página al crearla, se dibuja el contenido dos veces: una vez
// en un documento de altura holgada solo para medir cuánto ocupa de verdad (doc.y al terminar),
// y otra en el documento final con esa altura exacta — así no queda papel en blanco de sobra al
// imprimir en el rollo continuo.
async function generateOrderPdfBuffer(order) {
  let barcodeBuffer = null;
  try {
    barcodeBuffer = await bwipjs.toBuffer({
      // QR en vez de Code 128: el dueño probó con un pedido real y la impresora térmica dejó
      // rayas/zonas débiles en el papel (cabezal desgastado) — un código de barras lineal no
      // tolera eso, una sola raya sobre una barra tira abajo la lectura completa. El QR tiene
      // corrección de errores incorporada (nivel 'H' = hasta ~30% del código dañado/tapado y
      // sigue leyendo bien), mucho más resistente a ese tipo de defecto real de impresión.
      // Confirmado con el dueño que el lector USB es de cámara/imagen (2D), no láser de una sola
      // línea — un lector láser viejo NO puede leer QR, por eso se preguntó antes de cambiar.
      bcid: 'qrcode',
      text: order.orderId,
      eclevel: 'H',
      scale: 3,
      includetext: false,
    });
  } catch (err) {
    console.error('No se pudo generar el código de barras del pedido:', err.message);
  }

  const measureDoc = new PDFDocument({
    size: [RECEIPT_WIDTH, RECEIPT_MAX_HEIGHT],
    margins: { top: RECEIPT_MARGIN, bottom: RECEIPT_MARGIN, left: RECEIPT_MARGIN, right: RECEIPT_MARGIN },
  });
  measureDoc.on('data', () => {});
  drawReceiptBody(measureDoc, order, barcodeBuffer);
  const contentHeight = Math.ceil(measureDoc.y) + RECEIPT_MARGIN;
  measureDoc.end();

  const doc = new PDFDocument({
    size: [RECEIPT_WIDTH, contentHeight],
    margins: { top: RECEIPT_MARGIN, bottom: RECEIPT_MARGIN, left: RECEIPT_MARGIN, right: RECEIPT_MARGIN },
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const donePromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  drawReceiptBody(doc, order, barcodeBuffer);
  doc.end();
  return donePromise;
}

// Versión "para pantalla" del recibo, con la captura del pago incrustada — NO reemplaza al de
// arriba (ese sigue siendo el que se imprime en la impresora térmica de la tienda, sin fotos: una
// captura de pago ahí saldría enorme y en baja calidad, esa impresora es monocromática y angosta).
// Este otro es tamaño carta normal, pensado para verse en pantalla o mandarse por WhatsApp. Solo
// se genera cuando el pedido trae una captura adjunta (ver POST /api/orders).
async function generateReceiptWithProofPdfBuffer(order, proofBuffer) {
  let barcodeBuffer = null;
  try {
    barcodeBuffer = await bwipjs.toBuffer({
      // QR en vez de Code 128: el dueño probó con un pedido real y la impresora térmica dejó
      // rayas/zonas débiles en el papel (cabezal desgastado) — un código de barras lineal no
      // tolera eso, una sola raya sobre una barra tira abajo la lectura completa. El QR tiene
      // corrección de errores incorporada (nivel 'H' = hasta ~30% del código dañado/tapado y
      // sigue leyendo bien), mucho más resistente a ese tipo de defecto real de impresión.
      // Confirmado con el dueño que el lector USB es de cámara/imagen (2D), no láser de una sola
      // línea — un lector láser viejo NO puede leer QR, por eso se preguntó antes de cambiar.
      bcid: 'qrcode',
      text: order.orderId,
      eclevel: 'H',
      scale: 3,
      includetext: false,
    });
  } catch (err) {
    console.error('No se pudo generar el código de barras del pedido:', err.message);
  }

  const doc = new PDFDocument({ size: 'A4', margin: mm(15) });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const donePromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  drawReceiptBody(doc, order, barcodeBuffer);

  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text('Captura del pago', { align: 'center' });
  doc.moveDown(0.5);
  try {
    // pdfkit no soporta todos los formatos de imagen (ej. WEBP, HEIC) — si falla, no se rompe el
    // resto del comprobante, solo se avisa con texto (la captura original sigue disponible aparte
    // en GET /api/orders/:orderId/proof).
    doc.image(proofBuffer, {
      fit: [
        doc.page.width - doc.page.margins.left - doc.page.margins.right,
        doc.page.height - doc.y - doc.page.margins.bottom,
      ],
      align: 'center',
    });
  } catch (err) {
    console.error('No se pudo incrustar la captura de pago en el PDF:', err.message);
    doc.font('Helvetica').fontSize(9).fillColor('#b91c1c').text(
      'No se pudo mostrar la captura acá (formato de imagen no compatible). Sigue disponible en el link de la captura original.',
      { align: 'center' }
    );
  }

  doc.end();
  return donePromise;
}

function ratingSummary(productReviews) {
  if (!productReviews || productReviews.length === 0) return { rating: null, reviewCount: 0 };
  const sum = productReviews.reduce((acc, r) => acc + r.rating, 0);
  return { rating: Math.round((sum / productReviews.length) * 10) / 10, reviewCount: productReviews.length };
}

// Manual edits from /admin/products win over whatever the Excel provided for the same field.
function mergeProductWithDetails(product, details) {
  const override = details[product.id];
  if (!override) return product;
  const merged = { ...product };
  for (const field of DETAIL_FIELDS) {
    if (override[field] !== undefined && override[field] !== null && override[field] !== '') {
      merged[field] = override[field];
    }
  }
  return merged;
}

// Resta lo pendiente de stock_adjustments.json (ventas online que PLADE todavía no procesó) sobre
// el stock crudo — ver adjustStock()/replaceProductsCatalog() más arriba. No toca stock null (no
// rastreado).
/**
 * Unidades ENTERAS que se pueden comprar de un stock que puede traer decimales.
 *
 * El catálogo conserva los decimales de PLADE (81,34 metros de paracord), pero el carrito trabaja
 * en unidades enteras. Sin redondear hacia abajo, un rollo con 0,8 metros se ofrecía, el cliente
 * pedía 1, el servidor lo rechazaba, y el botón de "dejar 0,8" volvía a mandar 1: un bucle.
 */
function unidadesComprables(stock) {
  if (stock === null || stock === undefined) return null;
  const n = Number(stock);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function applyPendingStock(stock, productId, adjustments) {
  const pending = adjustments[productId];
  if (!pending || stock === null || stock === undefined) return stock;
  return Math.max(0, stock - pending);
}

/**
 * Clave con la que se guarda una categoría pausada. PLADE manda los nombres tal como los tipeó
 * alguien en su sistema: "Hilos", "HILOS ", "hilos" pueden convivir y cambiar de un día para otro.
 * Normalizar al comparar evita que una categoría pausada "reviva" sola porque cambió una mayúscula
 * o un espacio del otro lado.
 */
function claveCategoria(nombre) {
  return String(nombre ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Orden alfabético A-Z para cualquier lista de categorías que vea una persona.
 *
 * `localeCompare` con 'es' y no una comparación de strings a secas: sin locale, la Ñ y las vocales
 * acentuadas caen después de la Z (comparan por código de carácter), así que "PIÑA" quedaría al
 * final de la lista en vez de entre PILA y PITA.
 */
function compararCategorias(a, b) {
  return String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
}

/** `{ "HILOS": { pausedAt, by, nombreOriginal } }` — ver PAUSED_CATEGORIES_FILE. */
function loadPausedCategories() {
  return pausedCategoriesStore.load();
}

function loadVisits() {
  return visitsStore.load();
}

function saveVisits(data) {
  visitsStore.save(data);
}

function savePausedCategories(data) {
  pausedCategoriesStore.save(data);
}

function categoriasPausadasSet() {
  return new Set(Object.keys(loadPausedCategories()));
}

/**
 * Quita de una lista de productos los que pertenecen a una categoría pausada.
 *
 * Se aplica SOLO en los endpoints públicos, nunca en los del panel: si filtrara en
 * getMergedProducts() el panel tampoco vería las categorías pausadas y no habría forma de
 * reactivarlas — la pantalla quedaría vacía y el dueño encerrado afuera de su propia decisión.
 */
function soloCategoriasActivas(products) {
  const pausadas = categoriasPausadasSet();
  if (pausadas.size === 0) return products;
  return products.filter((p) => !pausadas.has(claveCategoria(p.category || 'General')));
}

function getMergedProducts() {
  const products = loadProducts();
  const details = loadDetails();
  const reviews = loadReviews();
  const adjustments = loadStockAdjustments();
  return products.map((p) => {
    const merged = mergeProductWithDetails(p, details);
    return {
      ...merged,
      stock: applyPendingStock(merged.stock, p.id, adjustments),
      ...ratingSummary(reviews[p.id]),
    };
  });
}

/**
 * De qué sucursales de PLADE se suma el inventario.
 *
 * Lista vacía = todas las sedes, que es el comportamiento histórico y el que hay que conservar si
 * la configuración se pierde o se corrompe: preferible mostrar de más y que el chequeo del carrito
 * lo corrija, a mostrar de menos y dejar de vender mercancía que sí hay.
 */
/**
 * Sedes que el dueño escondió de la lista del panel.
 *
 * Es SOLO presentación: una sede oculta que estuviera seleccionada seguiría aportando su stock, y
 * eso sería un estado imposible de entender después. Por eso al guardar se descarta de las ocultas
 * cualquiera que esté en uso — la invariante se aplica en el servidor y no solo en la pantalla.
 */
function sucursalesOcultas() {
  try {
    const c = inventoryConfigStore.load();
    const ocultas = normalizarSucursales(Array.isArray(c && c.ocultas) ? c.ocultas : []);
    const enUso = sucursalesDeInventario();
    return ocultas.filter((id) => !enUso.includes(id));
  } catch {
    return [];
  }
}

function sucursalesDeInventario() {
  try {
    const c = inventoryConfigStore.load();
    return normalizarSucursales(Array.isArray(c && c.sucursales) ? c.sucursales : []);
  } catch {
    return [];
  }
}

// --- Sincronización con PLADE SOFTWARE (getInventario) ---
// Solo se activa si PLADE_USER/PLADE_PASSWORD/PLADE_TOKEN están configurados como variables de
// entorno; sin ellas, el catálogo sigue viniendo del CSV subido manualmente en /admin (sin cambios
// de comportamiento para quien no tenga PLADE conectado). Escribe directo a PRODUCTS_FILE, así que
// el resto del backend (getMergedProducts, /api/products, /api/categories) no necesita saber de
// dónde vino el catálogo.
// Cada 8 minutos. Eran 30, con el argumento de que el catálogo no cambia segundo a segundo — pero
// el que sí cambia es el STOCK: una venta en el mostrador físico puede dejar un producto en cero, y
// hasta la siguiente sincronización la tienda lo seguía ofreciendo. Ese hueco era de media hora.
//
// Coste real medido: PLADE devuelve el catálogo completo (2,4 MB) en 0,4-1 s. Pasar de 2 a 7
// consultas por hora no es carga apreciable para su sistema, y recorta el hueco a menos de diez
// minutos. Bajar mucho más no compensa: la comprobación del checkout ya consulta EN VIVO, así que
// nadie llega a pagar algo agotado aunque lo vea disponible un rato en el catálogo.
const PLADE_SYNC_INTERVAL_MS = 8 * 60 * 1000;
let lastPladeSync = null; // { at: string, count: number } | { at: string, error: string }

async function syncProductsFromPlade() {
  const items = await getInventario(sucursalesDeInventario());
  const products = items.map(mapPladeItemToProduct).filter((p) => p.id && p.title);
  replaceProductsCatalog(products);
  lastPladeSync = { at: new Date().toISOString(), count: products.length };
  console.log(`Sincronizado con PLADE: ${products.length} productos (${lastPladeSync.at})`);
  return products.length;
}

/**
 * Envía un pedido real a PLADE (savePedidoExterno) después del checkout. Nunca debe tumbar la
 * respuesta al cliente — el pedido ya quedó guardado localmente (PDF, ubicación, cliente) sin
 * depender de esto; se llama sin `await` desde /api/orders. Si falta el idPlade de algún producto
 * (catálogo manual sin sincronizar con PLADE) o no hay tasa BCV en caché, se omite el envío en vez
 * de mandar una factura incompleta.
 */
async function submitOrderToPlade({ orderId, nota, items, country }) {
  if (!isPladeConfigured()) return;
  if (country && country !== 'VE') {
    console.log(`Pedido ${orderId} no se envía a PLADE: es de ${country}, PLADE solo factura ventas de Venezuela.`);
    return;
  }
  if (!bcvRateCache || !bcvRateCache.rate) {
    console.error(`Pedido ${orderId} no se envió a PLADE: no hay tasa BCV en caché.`);
    return;
  }

  const catalog = loadProducts();
  const catalogById = new Map(catalog.map((p) => [p.id, p]));
  const pladeItems = items.map((item) => {
    const product = catalogById.get(item.id);
    if (!product?.idPlade) return null;
    return { idPlade: product.idPlade, title: item.title, quantity: item.quantity, price: item.price, ivaRate: product.ivaRate || 0 };
  });

  if (!pladeItems.every(Boolean)) {
    console.error(`Pedido ${orderId} no se envió a PLADE: algún producto no tiene idPlade (catálogo sin sincronizar).`);
    return;
  }

  const result = await saveOrderToPlade({ orderId, nota, bcvRate: bcvRateCache.rate, items: pladeItems });
  console.log(`Pedido ${orderId} enviado a PLADE: factura ${result.id_factura}`);
}

if (isPladeConfigured()) {
  syncProductsFromPlade().catch((err) => {
    lastPladeSync = { at: new Date().toISOString(), error: err.message };
    console.error('Error en sincronización inicial con PLADE:', err.message);
  });
  setInterval(() => {
    syncProductsFromPlade().catch((err) => {
      lastPladeSync = { at: new Date().toISOString(), error: err.message };
      console.error('Error en sincronización periódica con PLADE:', err.message);
    });
  }, PLADE_SYNC_INTERVAL_MS);
} else {
  console.log('PLADE_USER/PLADE_PASSWORD/PLADE_TOKEN no configurados: usando el catálogo cargado manualmente.');
}

// --- Tasa BCV (bolívares por dólar) ---
// bcv.org.ve sirve una cadena de certificados TLS incompleta/rota (problema conocido y documentado
// del propio sitio del Banco Central, no nuestro) — se desactiva la verificación SOLO para este host
// fijo y hardcodeado (nunca para una URL dinámica): el dato es una tasa de cambio pública, no
// información sensible ni un pago real, y el usuario siempre ve el monto antes de transferir.
// Antes esto se raspaba en vivo en cada visita desde una ruta de Next.js — bcv.org.ve es lento y
// eso hacía esperar segundos a cada sesión nueva. Aquí se cachea en memoria y se refresca cada 30
// min (la tasa se publica una vez al día), así que responder es prácticamente instantáneo siempre.
const BCV_URL = 'https://www.bcv.org.ve/';
const BCV_SYNC_INTERVAL_MS = 30 * 60 * 1000;
let bcvRateCache = null; // { rate: number, at: string } | { error: string, at: string }

function fetchBcvHtml() {
  return new Promise((resolve, reject) => {
    const req = https.get(BCV_URL, { rejectUnauthorized: false }, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`No se pudo obtener la tasa BCV (${res.statusCode})`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Tiempo de espera agotado consultando el BCV')));
  });
}

async function syncBcvRate() {
  const html = await fetchBcvHtml();
  const dolarSectionMatch = html.match(/id="dolar"[\s\S]*?<\/div>\s*<\/div>/);
  const section = dolarSectionMatch ? dolarSectionMatch[0] : html;
  const rateMatch = section.match(/<strong[^>]*class="[^"]*strong-tb[^"]*"[^>]*>([^<]+)<\/strong>/);
  const rateText = rateMatch?.[1]?.trim();
  if (!rateText) throw new Error('No se encontró la tasa del dólar en la página del BCV');

  const normalized = rateText.replace(/\./g, '').replace(',', '.');
  const rate = parseFloat(normalized);
  if (!Number.isFinite(rate)) throw new Error(`Formato de tasa BCV inesperado: ${rateText}`);

  bcvRateCache = { rate, at: new Date().toISOString() };
  console.log(`Tasa BCV actualizada: ${rate} (${bcvRateCache.at})`);
  return rate;
}

syncBcvRate().catch((err) => {
  bcvRateCache = { error: err.message, at: new Date().toISOString() };
  console.error('Error en consulta inicial al BCV:', err.message);
});
setInterval(() => {
  syncBcvRate().catch((err) => {
    bcvRateCache = { error: err.message, at: new Date().toISOString() };
    console.error('Error en consulta periódica al BCV:', err.message);
  });
}, BCV_SYNC_INTERVAL_MS);

// --- TRM (pesos colombianos por dólar) ---
// Mismo patrón que la tasa BCV: se cachea en memoria y se refresca cada 30 min en vez de consultar
// en cada request. A diferencia de bcv.org.ve, datos.gov.co tiene un certificado TLS válido, así que
// no hace falta desactivar la verificación. Fuente: dataset oficial "TRM Historico" de datos.gov.co,
// certificado por la Superintendencia Financiera de Colombia con base en operaciones del Banco de la
// República.
const TRM_URL = 'https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1';
const TRM_SYNC_INTERVAL_MS = 30 * 60 * 1000;
let trmRateCache = null; // { rate: number, at: string } | { error: string, at: string }

function fetchTrmJson() {
  return new Promise((resolve, reject) => {
    const req = https.get(TRM_URL, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`No se pudo obtener la TRM (${res.statusCode})`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Tiempo de espera agotado consultando la TRM')));
  });
}

async function syncTrmRate() {
  const json = await fetchTrmJson();
  const body = JSON.parse(json);
  const valorText = body?.[0]?.valor;
  const rate = parseFloat(valorText);
  if (!Number.isFinite(rate)) throw new Error(`Formato de TRM inesperado: ${valorText}`);

  trmRateCache = { rate, at: new Date().toISOString() };
  console.log(`TRM actualizada: ${rate} (${trmRateCache.at})`);
  return rate;
}

syncTrmRate().catch((err) => {
  trmRateCache = { error: err.message, at: new Date().toISOString() };
  console.error('Error en consulta inicial a la TRM:', err.message);
});
setInterval(() => {
  syncTrmRate().catch((err) => {
    trmRateCache = { error: err.message, at: new Date().toISOString() };
    console.error('Error en consulta periódica a la TRM:', err.message);
  });
}, TRM_SYNC_INTERVAL_MS);

// --- Routes ---

app.get('/', (req, res) => {
  res.redirect('/admin');
});

// --- Panel nuevo (cristal44.com/admin): login con usuario/contraseña + escaneo de salidas ---
// Token stateless firmado con HMAC (sin sesiones en memoria ni tabla nueva en Supabase) — el
// frontend lo guarda (localStorage) y lo manda en el header Authorization en cada request. Expira a
// las 12 horas (una jornada de trabajo; si hace falta más, se vuelve a loguear). No usa cookies a
// propósito: tienda_web (cristal44.com) y este backend (onrender.com) son dominios distintos, y un
// bearer token evita todo el tema de cookies cross-origin.
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// `actor` identifica QUIÉN hizo la acción, para auditoría: { sub, username }. `sub` es el uuid de
// la fila en admin_users, o null cuando el login vino por el respaldo de variables de entorno.
function signAdminToken(role, actor = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      role,
      sub: actor.sub || null,
      username: actor.username || role,
      // `cvc` = can view counter. Va firmado en el token para no pegarle a Supabase en cada
      // request del contador, que se refresca solo cada minuto desde varias pantallas.
      // Contrapartida: si se revoca el permiso, tarda hasta 12h (lo que dura el token) en aplicar,
      // o hasta que la persona vuelva a entrar. Aceptable para un permiso de solo lectura.
      cvc: actor.canViewCounter ? 1 : 0,
      // `cpc` = can pause categories. Mismo criterio que `cvc`: viaja firmado para no consultar
      // Supabase en cada request. Contrapartida idéntica — revocar el permiso tarda hasta 12h (lo
      // que dura el token) o hasta el próximo login. Aceptable: pausar una categoría no destruye
      // nada, se revierte con un clic y queda registrado quién lo hizo.
      cpc: actor.canPauseCategories ? 1 : 0,
      // `p` = permisos. Va firmado por el mismo motivo que cvc/cpc: no pegarle a Supabase en cada
      // request. Misma contrapartida — quitar un permiso tarda hasta 12h (lo que dura el token) o
      // hasta el próximo login de esa persona. Para lo destructivo eso no alcanza, así que
      // `datos-prueba` se vuelve a validar contra la base en el momento de usarlo.
      p: permisosEfectivos(actor),
      exp: Date.now() + ADMIN_TOKEN_TTL_MS,
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', ADMIN_TOKEN_SECRET).update(payload).digest('base64url');
  if (
    !signature ||
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data; // { role, sub, username, cvc, cpc, exp }
  } catch {
    return null;
  }
}

// Exige un token válido con alguno de los roles permitidos — el chequeo es server-side, no un
// simple ocultamiento de UI: "salidas" no puede pegarle a nada que no esté explícitamente permitido
// acá, sin importar qué muestre o deje de mostrar el frontend.
function requireAdminRole(...allowedRoles) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const data = verifyAdminToken(token);
    // `master` está por encima de todo: satisface cualquier requisito sin tener que agregarlo a
    // mano en cada llamada a requireAdminRole(). Si se olvidara en alguna, el master quedaría
    // afuera de una pantalla que debería poder ver — este atajo lo hace imposible.
    const permitido = data && (data.role === 'master' || allowedRoles.includes(data.role));
    if (!permitido) {
      return res.status(401).json({ error: 'No autorizado.' });
    }
    req.adminRole = data.role;
    req.adminUser = {
      sub: data.sub || null,
      username: data.username || data.role,
      canViewCounter: Boolean(data.cvc),
      canPauseCategories: Boolean(data.cpc),
      // Tokens emitidos antes de que existieran los permisos no traen `p`. Se cae a lo que da el
      // rol en vez de dejar a esa persona sin nada hasta que vuelva a entrar.
      permissions: Array.isArray(data.p) ? data.p : null,
      role: data.role,
    };
    next();
  };
}

/**
 * Exige un permiso concreto del catálogo (ver permisos.js), además del rol.
 *
 * Se usa DESPUÉS de requireAdminRole en la misma ruta: el rol dice quién puede entrar al panel y
 * el permiso dice qué puede hacer ahí dentro. El master pasa siempre, sin depender de la lista.
 */
function requierePermiso(clave) {
  return (req, res, next) => {
    if (req.adminRole === 'master') return next();
    if (tienePermiso({ role: req.adminRole, ...req.adminUser }, clave)) return next();
    return res.status(403).json({ error: 'Tu cuenta no tiene habilitada esa función.' });
  };
}

/**
 * Valida usuario+contraseña en dos etapas, en este orden:
 *
 * 1. Contra la tabla `admin_users` de Supabase (una fila por persona, contraseña con bcrypt).
 * 2. Si ese usuario NO existe ahí, contra las variables de entorno de siempre
 *    (ADMIN_USERNAME/ADMIN_PASSWORD y SALIDAS_USERNAME/SALIDAS_PASSWORD).
 *
 * El orden importa: si el usuario existe en la tabla pero la contraseña está mal, se rechaza y NO
 * se cae al respaldo — si no, alguien podría entrar como una cuenta real usando las credenciales
 * compartidas. El respaldo existe solo para nombres de usuario que no están en la tabla.
 *
 * Por qué se mantiene el respaldo: es la vía de entrada cuando Supabase está caído, cuando la
 * tabla todavía no se creó, o cuando alguien desactivó por error al último administrador. Sin él,
 * un problema en la base te deja afuera de tu propio panel sin forma de arreglarlo.
 */
async function authenticateAdmin(username, password) {
  // Un fallo de Supabase NUNCA debe bloquear el acceso al panel: se registra y se sigue con el
  // respaldo por variables de entorno. Pasó de verdad el 2026-08-09 — una columna nueva que la base
  // todavía no tenía hacía que esto lanzara, y el login devolvía 500 para todo el mundo, incluido
  // el dueño. La disponibilidad del panel no puede depender de que la base esté impecable.
  let user = null;
  try {
    user = await adminUsers.findActiveUser(username);
  } catch (err) {
    console.error('No se pudo consultar admin_users; se usa el respaldo por variables de entorno:', err.message);
  }
  if (user) {
    const ok = await adminUsers.verifyPassword(password, user.password_hash);
    if (!ok) return null;
    adminUsers.touchLastLogin(user.id).catch((err) =>
      console.error('No se pudo actualizar last_login_at:', err.message)
    );
    return {
      role: user.role,
      sub: user.id,
      username: user.username,
      fullName: user.full_name,
      canViewCounter: Boolean(user.can_view_counter),
      canPauseCategories: Boolean(user.can_pause_categories),
      // `undefined` si la migración 014 no se corrió: permisosEfectivos() cae a los del rol.
      permissions: user.permissions === undefined ? null : user.permissions,
    };
  }

  // La cuenta de respaldo por variables de entorno es la del dueño y es la vía de emergencia
  // cuando Supabase falla: se le da rol `master` para que nunca quede por debajo de una cuenta de
  // la base. Además garantiza que SIEMPRE exista un master que pueda crear otros.
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    // El nombre se muestra en el saludo del panel y en la cabecera. El panel toma el primer
    // término para el "Hola, ..." — por eso el nombre va primero y el cargo entre paréntesis.
    return {
      role: 'master',
      sub: null,
      username: ADMIN_USERNAME,
      fullName: 'Giormary Pacia (C.E.O.)',
      canViewCounter: true,
      canPauseCategories: true,
    };
  }
  if (username === SALIDAS_USERNAME && password === SALIDAS_PASSWORD) {
    return { role: 'salidas', sub: null, username: SALIDAS_USERNAME, fullName: 'Salidas' };
  }
  return null;
}

/**
 * Freno de fuerza bruta para el login del panel.
 *
 * NO bloquea de forma permanente, A PROPÓSITO. Un bloqueo duro por IP es un arma de doble filo:
 * cualquiera puede dispararlo a mano contra la IP del dueño y dejarlo afuera de su propio panel,
 * que es peor que el ataque que evita. En vez de eso cada intento fallido consecutivo obliga a
 * esperar el doble que el anterior (0,2s · 0,4s · 0,8s… hasta 5s), lo que vuelve impracticable
 * probar contraseñas —a 5 segundos por intento son unos 17.000 al día, contra un espacio de
 * millones— sin molestar a quien simplemente se equivocó al teclear.
 *
 * El contador se borra con un login correcto y se olvida solo a los 15 minutos.
 */
const VENTANA_LOGIN_MS = 15 * 60 * 1000;
const ESPERA_MAX_MS = 5000;
const FALLOS_PARA_RECHAZAR = 25;
const intentosLogin = new Map();

function podarIntentos() {
  // Se poda al escribir y no con un temporizador: sin esto el mapa crece sin techo con cada IP
  // que pase por acá, que es una fuga de memoria lenta pero segura.
  if (intentosLogin.size < 500) return;
  const limite = Date.now() - VENTANA_LOGIN_MS;
  for (const [ip, reg] of intentosLogin) {
    if (reg.ultimo < limite) intentosLogin.delete(ip);
  }
}

function estadoIntentos(ip) {
  const reg = intentosLogin.get(ip);
  if (!reg || Date.now() - reg.ultimo > VENTANA_LOGIN_MS) return { fallos: 0, espera: 0 };
  return { fallos: reg.fallos, espera: Math.min(200 * 2 ** (reg.fallos - 1), ESPERA_MAX_MS) };
}

function anotarFallo(ip) {
  const previo = estadoIntentos(ip).fallos;
  intentosLogin.set(ip, { fallos: previo + 1, ultimo: Date.now() });
  podarIntentos();
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Falta usuario o contraseña.' });
  }

  const ip = req.ip || 'desconocida';
  const { fallos, espera } = estadoIntentos(ip);
  if (fallos >= FALLOS_PARA_RECHAZAR) {
    res.set('Retry-After', String(Math.ceil(VENTANA_LOGIN_MS / 1000)));
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' });
  }
  // La espera va ANTES de validar: así el atacante paga el tiempo aunque acierte, y no se puede
  // medir por la duración de la respuesta si el usuario existe o no.
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));

  let account;
  try {
    account = await authenticateAdmin(username, password);
  } catch (err) {
    // Supabase caído o mal configurado: se avisa en el log, pero al usuario se le da el mismo
    // mensaje genérico que a una credencial inválida, para no filtrar el estado de la infra.
    console.error('Error validando el login del panel:', err.message);
    return res.status(500).json({ error: 'No se pudo validar el acceso. Intentá de nuevo.' });
  }

  if (!account) {
    anotarFallo(ip);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  // Entró bien: se borra el historial de fallos de esa IP para que un error de tecleo previo no
  // le siga cobrando espera al dueño el resto del cuarto de hora.
  intentosLogin.delete(ip);

  res.json({
    token: signAdminToken(account.role, {
      sub: account.sub,
      username: account.username,
      canViewCounter: account.canViewCounter,
      canPauseCategories: account.canPauseCategories,
      permissions: account.permissions,
      role: account.role,
    }),
    role: account.role,
    username: account.username,
    fullName: account.fullName,
    canViewCounter: Boolean(account.canViewCounter),
    canPauseCategories: Boolean(account.canPauseCategories),
    // Ya resueltos: el panel no tiene que saber nada de roles ni de columnas viejas para decidir
    // qué tarjetas pintar. Igual el backend revalida cada request — esto es solo presentación.
    permisos: permisosEfectivos(account),
  });
});

/**
 * El catálogo de funciones que se pueden habilitar por cuenta.
 *
 * Lo sirve el backend y no lo repite el frontend a propósito: es la MISMA lista que usan los
 * chequeos de permiso, así que una función nueva aparece sola en la pantalla de usuarios sin tener
 * que acordarse de agregarla en dos sitios.
 */
app.get('/api/admin/permisos/catalogo', requireAdminRole('admin'), (req, res) => {
  res.json({
    funciones: FUNCIONES.map(({ clave, nombre, descripcion, rolesPorDefecto, peligrosa, aviso }) => ({
      clave, nombre, descripcion, rolesPorDefecto, peligrosa: Boolean(peligrosa), aviso: aviso || null,
    })),
    // Los del que pregunta, ya resueltos: el panel decide con esto qué tarjetas pintar.
    mios: permisosEfectivos({ role: req.adminRole, ...req.adminUser }),
  });
});

// --- Gestión de usuarios del panel (solo rol admin) ---

app.get('/api/admin/users', requireAdminRole('admin'), async (req, res) => {
  if (!adminUsers.isAdminUsersConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no hay tabla de usuarios todavía.' });
  }
  try {
    res.json({ users: await adminUsers.listUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', requireAdminRole('admin'), async (req, res) => {
  const { username, fullName, password, role, canViewCounter, canPauseCategories, permissions } = req.body || {};

  // Un admin no puede crear un master ni regalar el permiso del contador: si pudiera, el rol
  // superior no significaría nada — cualquier admin se fabricaría uno y se lo daría a sí mismo.
  // Va ANTES del chequeo de Supabase a propósito: una decisión de permisos no debe depender del
  // estado de la infraestructura, y con el orden inverso un 503 tapaba el 403.
  if (tapaCuentaDeEmergencia(username)) {
    return res.status(400).json({ error: ERROR_TAPA_EMERGENCIA });
  }
  if (req.adminRole !== 'master' && (role === 'master' || canViewCounter || canPauseCategories || permissions !== undefined)) {
    return res.status(403).json({ error: 'Solo una cuenta Master puede crear cuentas Master o repartir permisos.' });
  }
  if (!adminUsers.isAdminUsersConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no hay tabla de usuarios todavía.' });
  }

  try {
    res.status(201).json({
      user: await adminUsers.createUser({ username, fullName, password, role, canViewCounter, canPauseCategories, permissions }),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * ¿Este nombre de usuario taparía una de las cuentas de respaldo por variables de entorno?
 *
 * El login busca PRIMERO en admin_users y solo cae al respaldo si no encuentra a nadie. Una fila con
 * el mismo nombre que ADMIN_USERNAME intercepta el login y **deja al dueño fuera de su vía de
 * emergencia** — ya pasó (ver la sección 6 del HANDOFF). Se compara en minúsculas porque
 * normalizeUsername() guarda así, aunque el respaldo compare con mayúsculas y minúsculas exactas.
 */
function tapaCuentaDeEmergencia(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return false;
  return u === String(ADMIN_USERNAME).trim().toLowerCase() || u === String(SALIDAS_USERNAME).trim().toLowerCase();
}

const ERROR_TAPA_EMERGENCIA =
  'Ese nombre de usuario está reservado: es el de una cuenta de emergencia. Si lo usás acá, el login ' +
  'de esa cuenta dejaría de funcionar y podrías quedarte afuera del panel. Elegí otro.';

app.patch('/api/admin/users/:id', requireAdminRole('admin'), async (req, res) => {
  const { role, active, password, canViewCounter, canPauseCategories, fullName, username, permissions } = req.body || {};
  const esMaster = req.adminRole === 'master';
  const pierdeAdmin = role !== undefined && role !== 'admin' && role !== 'master';

  // Nadie puede desactivarse ni degradarse a sí mismo: es la forma más fácil de quedarse afuera
  // del panel sin querer. Que lo haga otra cuenta con permisos.
  if (req.adminUser.sub && req.adminUser.sub === req.params.id && (active === false || pierdeAdmin)) {
    return res.status(400).json({ error: 'No podés desactivar ni bajarte el rol a vos mismo.' });
  }
  if (!esMaster && (role === 'master' || canViewCounter !== undefined || canPauseCategories !== undefined || permissions !== undefined)) {
    return res.status(403).json({ error: 'Solo una cuenta Master puede asignar el rol Master o repartir permisos.' });
  }
  // Un master no puede dejarse a sí mismo sin funciones: sería la versión silenciosa de quedarse
  // fuera del panel, y no habría forma de volver desde adentro.
  if (permissions !== undefined && req.adminUser.sub && req.adminUser.sub === req.params.id) {
    return res.status(400).json({ error: 'No podés cambiarte los permisos a vos mismo. Que lo haga otra cuenta Master.' });
  }
  // Corregir el nombre o el usuario de otra persona es identidad, no operación: se reserva al master.
  if (!esMaster && (fullName !== undefined || username !== undefined)) {
    return res.status(403).json({ error: 'Solo una cuenta Master puede corregir el nombre o el usuario de una cuenta.' });
  }
  if (username !== undefined && tapaCuentaDeEmergencia(username)) {
    return res.status(400).json({ error: ERROR_TAPA_EMERGENCIA });
  }
  // Igual que en POST: los permisos se deciden antes que el estado de la infraestructura.
  if (!adminUsers.isAdminUsersConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no hay tabla de usuarios todavía.' });
  }

  try {
    const target = (await adminUsers.listUsers()).find((u) => u.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // Un admin no puede tocar a un master: solo un par o superior puede hacerlo.
    if (!esMaster && target.role === 'master') {
      return res.status(403).json({ error: 'Solo otra cuenta Master puede modificar a un Master.' });
    }

    // Guarda contra quedarse sin ninguna cuenta con poder de administración (master o admin).
    if (active === false || pierdeAdmin) {
      const eraAdmin = target.role === 'admin' || target.role === 'master';
      if (eraAdmin && target.active && (await adminUsers.countActiveAdmins()) <= 1) {
        return res.status(400).json({ error: 'Es la última cuenta con permisos de administración. Creá otra antes de tocar esta.' });
      }
    }

    if (password !== undefined) await adminUsers.resetPassword(req.params.id, password);
    const cambiaAlgo =
      role !== undefined ||
      active !== undefined ||
      canViewCounter !== undefined ||
      canPauseCategories !== undefined ||
      permissions !== undefined ||
      fullName !== undefined ||
      username !== undefined;
    const user = cambiaAlgo
      ? await adminUsers.updateUser(req.params.id, {
          role,
          active,
          canViewCounter,
          canPauseCategories,
          fullName,
          username,
          permissions,
        })
      : (await adminUsers.listUsers()).find((u) => u.id === req.params.id);

    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Reseñas y clientes desde el panel nuevo ---
//
// Ambas cosas son solo para rol `admin`: borrar una reseña es irreversible, y la ficha de cliente
// expone datos personales (cédula, teléfono, correo, historial de compras). Si más adelante hace
// falta que `empleado` atienda consultas, se puede abrir la lectura de clientes sin abrir el borrado.

const ADMIN_REVIEWS_PAGE_SIZE = 25;

app.get('/api/admin/reviews', requireAdminRole('admin'), (req, res) => {
  const reviews = loadReviews();
  const titles = new Map(loadProducts().map((p) => [p.id, p.title]));

  // reviews.json está indexado por producto; para moderar conviene verlas todas juntas y por fecha.
  const todas = [];
  for (const [productId, lista] of Object.entries(reviews)) {
    for (const r of lista || []) {
      todas.push({
        ...r,
        productId,
        // Un producto puede haber desaparecido del catálogo tras una sync de PLADE y su reseña
        // quedar huérfana: se muestra igual, con el id, en vez de esconderla.
        productTitle: titles.get(productId) || null,
      });
    }
  }
  todas.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // Conteo por estrellas, siempre sobre el total: es lo que permite ir directo a las de 1 estrella,
  // que son las que urge revisar. Se calcula antes de filtrar para que las pestañas no cambien de
  // número al entrar a un grupo.
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of todas) if (counts[r.rating] !== undefined) counts[r.rating]++;

  const rating = parseInt(req.query.rating, 10);
  const filtradas = rating >= 1 && rating <= 5 ? todas.filter((r) => r.rating === rating) : todas;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  res.json({
    total: filtradas.length,
    totalGeneral: todas.length,
    counts,
    offset,
    pageSize: ADMIN_REVIEWS_PAGE_SIZE,
    reviews: filtradas.slice(offset, offset + ADMIN_REVIEWS_PAGE_SIZE),
  });
});

app.delete('/api/admin/reviews/:productId/:reviewId', requireAdminRole('admin'), (req, res) => {
  const reviews = loadReviews();
  const lista = reviews[req.params.productId];
  if (!lista) return res.status(404).json({ error: 'Producto sin reseñas.' });

  const restantes = lista.filter((r) => r.id !== req.params.reviewId);
  if (restantes.length === lista.length) return res.status(404).json({ error: 'Reseña no encontrada.' });

  reviews[req.params.productId] = restantes;
  saveReviews(reviews);
  res.json({ ok: true, ...ratingSummary(restantes) });
});

/**
 * Clientes. La lista sale de customers.json (que se llena en cada checkout, incluidos invitados) y
 * se enriquece con los pedidos reales. El cruce es por TELÉFONO: es el único dato que guardan tanto
 * el pedido como la ficha del cliente — los pedidos anteriores al 2026-08-09 no tienen cédula.
 */
function ordersForPhone(orders, telefono) {
  if (!telefono) return [];
  const norm = (v) => String(v || '').replace(/\D/g, '');
  const objetivo = norm(telefono);
  if (!objetivo) return [];
  return orders.filter((o) => norm(o.telefono) === objetivo);
}

const ADMIN_CUSTOMERS_PAGE_SIZE = 25;

app.get('/api/admin/customers', requireAdminRole('admin'), (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const customers = loadCustomers();
  const orders = loadOrdersLocation();

  let filas = Object.entries(customers).map(([key, c]) => {
    const suyos = ordersForPhone(orders, c.telefono).filter((o) => !o.cancelledAt);
    return {
      key,
      nombre: c.nombre || null,
      cedula: `${c.idType || ''}-${c.cedula || ''}`.replace(/^-|-$/g, '') || null,
      telefono: c.telefono || null,
      correo: c.correo || null,
      firstSeen: c.firstSeen || null,
      lastSeen: c.lastSeen || null,
      // orderCount lo lleva customers.json; los pedidos cruzados pueden diferir si cambió de
      // teléfono entre compras. Se muestran los dos en vez de elegir uno y ocultar la diferencia.
      orderCount: c.orderCount ?? null,
      pedidosCruzados: suyos.length,
      totalGastado: suyos.reduce((s, o) => s + (typeof o.total === 'number' ? o.total : 0), 0),
    };
  });

  if (search) {
    filas = filas.filter((c) =>
      [c.nombre, c.cedula, c.telefono, c.correo]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(search))
    );
  }
  filas.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json({
    total: filas.length,
    offset,
    pageSize: ADMIN_CUSTOMERS_PAGE_SIZE,
    customers: filas.slice(offset, offset + ADMIN_CUSTOMERS_PAGE_SIZE),
  });
});

app.get('/api/admin/customers/:key', requireAdminRole('admin'), async (req, res) => {
  const customers = loadCustomers();
  const c = customers[req.params.key];
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const orders = loadOrdersLocation();
  const suyos = ordersForPhone(orders, c.telefono).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );

  // Nivel de fidelidad: solo se puede resolver si alguna de sus compras quedó registrada en
  // Supabase, que pasa únicamente cuando compró con sesión iniciada. Para un invitado no existe, y
  // eso es normal — se devuelve null en vez de inventar un nivel.
  let loyalty = null;
  if (isLoyaltyConfigured() && suyos.length) {
    try {
      const ids = new Set(suyos.map((o) => o.orderId));
      const purchase = (await listPurchases()).find((p) => ids.has(p.order_id) && p.user_id);
      if (purchase) loyalty = await getLoyaltyForUser(purchase.user_id);
    } catch (err) {
      console.error(`No se pudo resolver la fidelidad de ${req.params.key}:`, err.message);
    }
  }

  res.json({
    customer: {
      key: req.params.key,
      nombre: c.nombre || null,
      cedula: `${c.idType || ''}-${c.cedula || ''}`.replace(/^-|-$/g, '') || null,
      telefono: c.telefono || null,
      correo: c.correo || null,
      firstSeen: c.firstSeen || null,
      lastSeen: c.lastSeen || null,
      orderCount: c.orderCount ?? null,
    },
    loyalty,
    orders: suyos.map(orderSummary),
  });
});

// --- Contador de ventas del día (barra fija del panel) ---
//
// Solo para rol `master`, o para un `admin` con el permiso `can_view_counter` activado desde la
// pantalla de usuarios. Es información sensible del negocio y el dueño quiso poder darla caso a caso.

/** Venezuela es UTC-4 todo el año (no tiene horario de verano). */
const VE_UTC_OFFSET_HOURS = -4;

/**
 * Instante en que empezó el día EN VENEZUELA. Render corre en UTC, así que usar la medianoche del
 * servidor reiniciaría el contador a las 8 de la noche hora local — que es justo el horario en que
 * el dueño estaría mirando las ventas del día.
 */
function startOfTodayVenezuela() {
  const ahora = new Date();
  // Se corre el reloj a hora local de Venezuela, se trunca el día ahí, y se vuelve a UTC.
  const enVE = new Date(ahora.getTime() + VE_UTC_OFFSET_HOURS * 3600_000);
  const inicioVE = Date.UTC(enVE.getUTCFullYear(), enVE.getUTCMonth(), enVE.getUTCDate());
  return inicioVE - VE_UTC_OFFSET_HOURS * 3600_000;
}

// Se mantiene el nombre por los sitios que ya lo llaman, pero ahora resuelve contra el catálogo:
// así el permiso "contador" se puede dar tanto por la columna vieja como por la lista nueva.
function puedeVerContador(req) {
  return tienePermiso({ role: req.adminRole, ...req.adminUser }, 'contador');
}

function calcularContador() {
  const desde = startOfTodayVenezuela();
  const orders = loadOrdersLocation();

  // "Del día" se mide por fecha de CREACIÓN del pedido. Un pedido de ayer despachado hoy no suma a
  // las ventas de hoy, pero sí al contador de despachos, que es una métrica de operación.
  const deHoy = orders.filter((o) => {
    const t = new Date(o.createdAt).getTime();
    return Number.isFinite(t) && t >= desde && !o.cancelledAt;
  });
  const despachadosHoy = orders.filter((o) => {
    const t = new Date(o.dispatchedAt || 0).getTime();
    return Number.isFinite(t) && t >= desde && !o.cancelledAt;
  });
  // Anuladas: se mide por la fecha en que se ANULÓ, no por la de la venta. Anular hoy un pedido de
  // la semana pasada es trabajo de hoy, y es lo que el dueño quiere ver en el contador del día.
  const anuladasHoy = orders.filter((o) => {
    const t = new Date(o.cancelledAt || 0).getTime();
    return Number.isFinite(t) && t >= desde;
  });
  const porDespachar = orders.filter((o) => !o.cancelledAt && !o.dispatchedAt);

  const usd = deHoy.reduce((s, o) => s + (typeof o.total === 'number' ? o.total : 0), 0);
  const rate = bcvRateCache && bcvRateCache.rate ? bcvRateCache.rate : null;

  // Desglose por forma de pago, para el submenú del botón Valor. Se manda la CLAVE cruda
  // (pagoMovil, zelle…) y no una etiqueta: los nombres legibles ya viven en el frontend
  // (lib/payment-methods.ts) y duplicarlos acá sería una segunda lista que se desincroniza.
  const porMetodo = new Map();
  for (const o of deHoy) {
    const metodo = o.paymentMethod || 'desconocido';
    const acc = porMetodo.get(metodo) || { metodo, pedidos: 0, usd: 0 };
    acc.pedidos++;
    acc.usd += typeof o.total === 'number' ? o.total : 0;
    porMetodo.set(metodo, acc);
  }
  const porMetodoPago = [...porMetodo.values()]
    .map((m) => ({ ...m, usd: Math.round(m.usd * 100) / 100 }))
    .sort((a, b) => b.usd - a.usd || b.pedidos - a.pedidos);

  return {
    ventas: deHoy.length,
    despachados: despachadosHoy.length,
    anuladas: anuladasHoy.length,
    // Del día, para que el contador sea coherente con el resto de la barra…
    porDespacharHoy: porDespachar.filter((o) => new Date(o.createdAt).getTime() >= desde).length,
    // …y el total acumulado, porque un pedido de ayer sin despachar sigue siendo trabajo pendiente
    // y desaparecería del radar si solo se mirara el día.
    porDespacharTotal: porDespachar.length,
    usd,
    porMetodoPago,
    // Sin tasa en caché se devuelve null en vez de un 0 que parecería una venta de cero bolívares.
    bs: rate ? Math.round(usd * rate * 100) / 100 : null,
    bcvRate: rate,
    // Para que el frontend sepa cuándo se reinicia sin recalcular la zona horaria por su cuenta.
    desde: new Date(desde).toISOString(),
    sinMonto: deHoy.filter((o) => typeof o.total !== 'number').length,
  };
}

app.get('/api/admin/counter', requireAdminRole('master', 'admin'), (req, res) => {
  if (!puedeVerContador(req)) {
    return res.status(403).json({ error: 'Tu cuenta no tiene autorizado ver el contador de ventas.' });
  }
  res.json(calcularContador());
});

// --- Contador en tiempo real (Server-Sent Events) ---
//
// El contador se actualiza en el instante en que se crea una venta o se despacha un pedido, en vez
// de esperar a que el navegador vuelva a preguntar. Se eligió SSE y no WebSockets porque el flujo
// es de una sola dirección (servidor → panel): no hace falta una librería extra ni otro protocolo.
//
// El token NO viaja en la URL: el navegador se conecta con fetch + Authorization en vez de
// EventSource (que no admite cabeceras). Un token de 12 horas en la query string quedaría escrito
// en los logs de acceso de Render y de cualquier proxy intermedio.

const clientesContador = new Set();
/** Los proxies cortan conexiones ociosas; un comentario cada tanto las mantiene vivas. */
const SSE_HEARTBEAT_MS = 25_000;

function enviarEvento(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Cliente que se fue justo en el medio: lo limpia el handler de 'close'.
  }
}

/**
 * Empuja el contador a todos los paneles conectados. Se llama tras cada cambio que lo afecta.
 * Nunca debe romper la operación que la invoca — por eso no lanza.
 */
function broadcastContador() {
  if (clientesContador.size === 0) return;
  let snapshot;
  try {
    snapshot = calcularContador();
  } catch (err) {
    console.error('No se pudo calcular el contador para emitir:', err.message);
    return;
  }
  for (const res of clientesContador) enviarEvento(res, snapshot);
}

app.get('/api/admin/counter/stream', requireAdminRole('master', 'admin'), (req, res) => {
  if (!puedeVerContador(req)) {
    return res.status(403).json({ error: 'Tu cuenta no tiene autorizado ver el contador de ventas.' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx (y el proxy de Render) bufferean por defecto y el stream no llegaría hasta cerrarse.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  clientesContador.add(res);
  enviarEvento(res, calcularContador()); // foto inicial, para no esperar al primer cambio

  const latido = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ver 'close' */
    }
  }, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(latido);
    clientesContador.delete(res);
  });
});

// --- Niveles de fidelidad de los clientes ---
//
// Comparte el permiso del contador de ventas (can_view_counter) A PROPÓSITO: las dos pantallas
// muestran cifras de dinero por cliente, así que quien puede ver una puede ver la otra. Evita
// además una columna nueva en admin_users, que sería una migración sobre la consulta del login —
// justo lo que devolvió 500 y bloqueó el panel entero el 2026-08-09 (ver HANDOFF.md §6).
//
// El tiempo real NO abre un stream propio: la pantalla se cuelga del /api/admin/counter/stream que
// ya existe y vuelve a pedir estos datos cuando llega un evento. broadcastContador() ya se dispara
// en los 4 momentos que mueven una venta, así que un segundo canal sería otra conexión abierta por
// cada panel para enterarse exactamente de lo mismo.
//
// El agregado lo resuelve Postgres de una sola llamada (admin_loyalty_levels, supabase/012). Si esa
// migración todavía no se corrió, listLoyaltyLevels() devuelve null y acá se responde 200 con
// `migracionPendiente` en vez de un 500 que dejaría la pantalla en blanco sin decir qué falta.

/** De mayor a menor: fija tanto el orden de la respuesta como el de los botones del panel. */
const NIVELES_FIDELIDAD = ['DIAMANTE', 'PLATINO', 'ORO', 'PLATA', 'NINGUNO'];

function resumirNiveles(clientes) {
  return NIVELES_FIDELIDAD.map((tier) => {
    const delNivel = clientes.filter((c) => c.tier === tier);
    return {
      tier,
      clientes: delNivel.length,
      gasto12mo: Math.round(delNivel.reduce((s, c) => s + c.spend12mo, 0) * 100) / 100,
      // El descuento es propiedad del nivel, así que alcanza con leerlo de cualquier integrante.
      // Queda null en un nivel vacío: preferible a repetir acá los porcentajes del 003.
      descuento: delNivel.length > 0 ? delNivel[0].discountPercent : null,
    };
  });
}

function rechazarSinPermisoDeNiveles(req, res) {
  if (puedeVerContador(req)) return false;
  res.status(403).json({ error: 'Tu cuenta no tiene autorizado ver los niveles de clientes.' });
  return true;
}

app.get('/api/admin/loyalty/levels', requireAdminRole('master', 'admin'), async (req, res) => {
  if (rechazarSinPermisoDeNiveles(req, res)) return;
  if (!isLoyaltyConfigured()) {
    return res.json({ configurado: false, migracionPendiente: false, niveles: [], totalClientes: 0 });
  }
  try {
    const clientes = await listLoyaltyLevels();
    if (clientes === null) {
      return res.json({ configurado: true, migracionPendiente: true, niveles: [], totalClientes: 0 });
    }
    res.json({
      configurado: true,
      migracionPendiente: false,
      niveles: resumirNiveles(clientes),
      totalClientes: clientes.length,
    });
  } catch (err) {
    console.error('No se pudieron cargar los niveles de fidelidad:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los niveles de fidelidad.' });
  }
});

app.get('/api/admin/loyalty/levels/:tier', requireAdminRole('master', 'admin'), async (req, res) => {
  if (rechazarSinPermisoDeNiveles(req, res)) return;

  const tier = String(req.params.tier || '').toUpperCase();
  if (!NIVELES_FIDELIDAD.includes(tier)) {
    return res.status(404).json({ error: 'Ese nivel no existe.' });
  }
  if (!isLoyaltyConfigured()) {
    return res.json({ configurado: false, migracionPendiente: false, tier, clientes: [] });
  }
  try {
    const todos = await listLoyaltyLevels();
    if (todos === null) {
      return res.json({ configurado: true, migracionPendiente: true, tier, clientes: [] });
    }
    // De mayor a menor gasto: lo primero que se quiere ver de un nivel es quién más compra.
    const clientes = todos.filter((c) => c.tier === tier).sort((a, b) => b.spend12mo - a.spend12mo);
    res.json({ configurado: true, migracionPendiente: false, tier, clientes });
  } catch (err) {
    console.error('No se pudieron cargar los clientes del nivel:', err.message);
    res.status(500).json({ error: 'No se pudieron cargar los clientes de ese nivel.' });
  }
});

// --- Dashboard del panel nuevo ---
//
// Se calcula al vuelo sobre orders_location.json y el catálogo cacheado en memoria: con ~8700
// productos y decenas de pedidos es cuestión de milisegundos, y evita mantener contadores
// persistidos que se pueden desincronizar. Si el volumen de pedidos crece mucho, el candidato a
// optimizar es este recorrido, no el del catálogo.

/** Umbral de "poco stock". Mismo criterio que el rail de "últimas piezas" del checkout. */
const LOW_STOCK_THRESHOLD = 5;

/**
 * Medianoche de hace N días **en Venezuela**.
 *
 * Antes usaba `setHours(0,0,0,0)`, que trunca el día en la hora del SERVIDOR — y Render corre en
 * UTC. O sea que para el Resumen "hoy" empezaba a las 8 de la noche hora local del día anterior,
 * mientras el contador de ventas (startOfTodayVenezuela) cortaba bien: **las dos pantallas
 * mostraban días distintos entre las 20:00 y la medianoche**, justo cuando el dueño revisa la
 * jornada. Se reutiliza la función correcta en vez de repetir el cálculo.
 *
 * Restar días de 24 h exactas es válido acá: Venezuela no tiene horario de verano.
 */
function startOfDaysAgo(days) {
  return startOfTodayVenezuela() - days * 24 * 3600_000;
}

app.get('/api/admin/dashboard', requireAdminRole('admin', 'empleado'), (req, res) => {
  const orders = loadOrdersLocation();
  const products = getMergedProducts();
  const now = Date.now();

  // Las ventas anuladas no cuentan para ningún total: si no, anular no tendría efecto visible.
  const vigentes = orders.filter((o) => !o.cancelledAt);

  const rango = (desde) => {
    const enRango = vigentes.filter((o) => {
      const t = new Date(o.createdAt).getTime();
      return Number.isFinite(t) && t >= desde && t <= now;
    });
    return {
      pedidos: enRango.length,
      // `total` es null en los pedidos anteriores a agosto 2026; se suma solo lo que existe y se
      // informa cuántos quedaron fuera, para que el número no parezca más chico "sin motivo".
      monto: enRango.reduce((s, o) => s + (typeof o.total === 'number' ? o.total : 0), 0),
      sinMonto: enRango.filter((o) => typeof o.total !== 'number').length,
    };
  };

  const pendientes = orders.filter((o) => !o.cancelledAt && !o.dispatchedAt);

  // Más vendidos de los últimos 30 días, sumando cantidades por producto.
  const desde30 = startOfDaysAgo(30);
  const ventasPorProducto = new Map();
  for (const o of vigentes) {
    const t = new Date(o.createdAt).getTime();
    if (!Number.isFinite(t) || t < desde30) continue;
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const prev = ventasPorProducto.get(it.id) || { id: it.id, title: it.title, unidades: 0 };
      prev.unidades += Number(it.quantity) || 0;
      ventasPorProducto.set(it.id, prev);
    }
  }
  const masVendidos = [...ventasPorProducto.values()]
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, 8);

  const pocoStock = products
    .filter((p) => typeof p.stock === 'number' && p.stock > 0 && p.stock < LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.stock - b.stock);

  const catalogo = {
    total: products.length,
    sinFoto: products.filter((p) => !p.image).length,
    sinDescripcion: products.filter((p) => !p.description || !String(p.description).trim()).length,
    agotados: products.filter((p) => p.stock === 0).length,
  };

  const payload = {
    pendientesDespacho: pendientes.length,
    catalogo,
    pocoStock: {
      umbral: LOW_STOCK_THRESHOLD,
      total: pocoStock.length,
      productos: pocoStock.slice(0, 8).map((p) => ({ id: p.id, title: p.title, stock: p.stock })),
    },
  };

  // El rol "empleado" no ve plata (ver la definición de roles en 010_admin_users.sql). Se omiten
  // los campos del lado del servidor en vez de esconderlos en la pantalla: así el dato no viaja.
  if (req.adminRole === 'admin') {
    payload.ventas = {
      hoy: rango(startOfDaysAgo(0)),
      semana: rango(startOfDaysAgo(7)),
      mes: rango(startOfDaysAgo(30)),
    };
    payload.masVendidos = masVendidos;
  }

  res.json(payload);
});

// --- Pedidos desde el panel nuevo: listar, ver detalle, despachar y anular ---
//
// La fuente de verdad del estado es NUESTRO registro (orders_location.json), no la tabla purchases
// de Supabase: esa solo existe para clientes logueados que suman fidelidad, y los pedidos de
// invitados no tienen fila ahí. Al anular se sincroniza purchases si hay una fila que corresponda,
// pero el stock y el estado se manejan siempre contra nuestro propio registro, que siempre existe.

const ADMIN_ORDERS_PAGE_SIZE = 25;

function orderSummary(order) {
  return {
    orderId: order.orderId,
    createdAt: order.createdAt,
    nombre: order.nombre || null,
    telefono: order.telefono || null,
    total: order.total ?? null,
    paymentMethod: order.paymentMethod || null,
    deliveryMethod: order.deliveryMethod || null,
    destino: [order.ciudad, order.estado].filter(Boolean).join(', ') || null,
    dispatchedAt: order.dispatchedAt || null,
    dispatchedBy: order.dispatchedBy || null,
    cancelledAt: order.cancelledAt || null,
    cancelledBy: order.cancelledBy || null,
    hasProof: Boolean(order.proofUrl),
  };
}

/** pendiente = ni despachado ni anulado. Es el estado que importa a la salida de la tienda. */
function orderStatus(order) {
  if (order.cancelledAt) return 'anulado';
  if (order.dispatchedAt) return 'despachado';
  return 'pendiente';
}

app.get('/api/admin/orders', requireAdminRole('admin', 'empleado'), (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const status = String(req.query.status || '');
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // Más recientes primero: es el orden en que se trabajan los pedidos.
  let orders = loadOrdersLocation().slice().reverse();
  if (status) orders = orders.filter((o) => orderStatus(o) === status);
  if (search) {
    orders = orders.filter((o) =>
      [o.orderId, o.nombre, o.telefono, o.cedula, o.reference]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(search))
    );
  }

  const counts = loadOrdersLocation().reduce(
    (acc, o) => {
      acc[orderStatus(o)]++;
      return acc;
    },
    { pendiente: 0, despachado: 0, anulado: 0 }
  );

  res.json({
    total: orders.length,
    offset,
    pageSize: ADMIN_ORDERS_PAGE_SIZE,
    counts,
    orders: orders.slice(offset, offset + ADMIN_ORDERS_PAGE_SIZE).map(orderSummary),
  });
});

app.get('/api/admin/orders/:orderId', requireAdminRole('admin', 'empleado'), (req, res) => {
  const order = loadOrdersLocation().find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

  res.json({
    order: {
      ...orderSummary(order),
      status: orderStatus(order),
      cedula: order.cedula || null,
      correo: order.correo || null,
      address: order.address || null,
      parroquia: order.parroquia || null,
      pickupStore: order.pickupStore || null,
      reference: order.reference || null,
      paymentHolderName: order.paymentHolderName || null,
      // Los archivos se sirven por sus endpoints públicos existentes, que ya usa el cliente.
      pdfUrl: `/api/orders/${encodeURIComponent(order.orderId)}/pdf`,
      proofUrl: order.proofUrl ? `/api/orders/${encodeURIComponent(order.orderId)}/proof` : null,
      items: Array.isArray(order.items) ? order.items : [],
      // Los pedidos anteriores a agosto 2026 no guardaban items; conviene decirlo en la pantalla
      // en vez de mostrar una lista vacía como si la compra no tuviera productos.
      itemsUnavailable: !Array.isArray(order.items) || order.items.length === 0,
    },
  });
});

/** Marcar despachado a mano, para cuando el código del recibo no se puede escanear. */
app.post('/api/admin/orders/:orderId/dispatch', requireAdminRole('admin', 'empleado'), (req, res) => {
  const orders = loadOrdersLocation();
  const order = orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
  if (order.cancelledAt) return res.status(409).json({ error: 'El pedido está anulado; restauralo antes de despacharlo.' });
  if (order.dispatchedAt) {
    return res.status(409).json({ error: 'Esta compra ya está procesada y entregada/enviada, no se puede repetir.' });
  }

  order.dispatchedAt = new Date().toISOString();
  order.dispatchedBy = req.adminUser.username || req.adminRole;
  saveOrdersLocation(orders);
  broadcastContador();
  res.json({ ok: true, order: orderSummary(order) });
});

/**
 * Anular o restaurar. Solo rol admin: mueve stock y plata, no es una acción de mostrador.
 * Anular repone el stock reservado; restaurar lo vuelve a descontar. La guarda de estado evita
 * duplicar el ajuste si alguien toca el botón dos veces.
 */
app.post('/api/admin/orders/:orderId/cancel', requireAdminRole('admin'), async (req, res) => {
  const restore = req.body?.restore === true;
  const orders = loadOrdersLocation();
  const order = orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

  const alreadyCancelled = Boolean(order.cancelledAt);
  if (restore === alreadyCancelled) {
    if (restore) {
      order.cancelledAt = null;
      order.cancelledBy = null;
    } else {
      order.cancelledAt = new Date().toISOString();
      order.cancelledBy = req.adminUser.username || req.adminRole;
    }
    if (Array.isArray(order.items) && order.items.length) {
      adjustStock(order.items, restore ? -1 : 1);
    }
    saveOrdersLocation(orders);
    broadcastContador();

    // Si el pedido tiene una compra registrada para fidelidad, se sincroniza el estado. Que no
    // exista es normal (compra de invitado) y no debe hacer fallar la anulación.
    if (isLoyaltyConfigured()) {
      try {
        const purchase = (await listPurchases()).find((p) => p.order_id === order.orderId);
        if (purchase) await setPurchaseStatus(purchase.id, restore ? 'confirmed' : 'cancelled');
      } catch (err) {
        console.error(`No se pudo sincronizar purchases para ${order.orderId}:`, err.message);
      }
    }
  }

  res.json({ ok: true, order: { ...orderSummary(order), status: orderStatus(order) } });
});

// --- Productos desde el panel nuevo: buscar, editar detalles y subir fotos ---
// Accesible para admin y empleado: cargar fotos y descripciones es justamente el trabajo que se
// quiere delegar al personal. No toca precios ni stock (eso lo manda PLADE) ni el catálogo crudo:
// todo va a product_details.json, la capa que sobrevive a las sincronizaciones.

const ADMIN_PRODUCTS_PAGE_SIZE = 30;

app.get('/api/admin/products', requireAdminRole('admin'), (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const missing = String(req.query.missing || ''); // '', 'photo' o 'description'
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  let products = getMergedProducts();
  if (missing === 'photo') products = products.filter((p) => !p.image);
  if (missing === 'description') products = products.filter((p) => !p.description || !p.description.trim());
  if (search) {
    products = products.filter(
      (p) => p.id.toLowerCase().includes(search) || p.title.toLowerCase().includes(search)
    );
  }

  // Categorías CON su conteo, calculadas después del filtro pero antes de elegir una: así se ve
  // "sin foto: HILOS (174), ACRILICOS (89)…" y se puede atacar el catálogo por bloques en vez de
  // recorrer 3644 fichas sueltas. Ordenadas por cantidad: primero donde hay más trabajo.
  const porCategoria = new Map();
  for (const p of products) {
    const c = p.category || 'General';
    porCategoria.set(c, (porCategoria.get(c) || 0) + 1);
  }
  const categories = [...porCategoria.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const category = String(req.query.category || '');
  if (category) products = products.filter((p) => (p.category || 'General') === category);

  const total = products.length;
  const page = products.slice(offset, offset + ADMIN_PRODUCTS_PAGE_SIZE).map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    price: p.price,
    stock: p.stock,
    image: p.image || null,
    photoCount: [p.image, p.image2, p.image3, p.image4].filter(Boolean).length,
    hasDescription: Boolean(p.description && p.description.trim()),
  }));

  res.json({ total, offset, pageSize: ADMIN_PRODUCTS_PAGE_SIZE, categories, products: page });
});

// --- Pausar categorías: qué parte del catálogo ve el cliente ---
//
// PLADE manda el catálogo completo y no tiene forma de decir "esto no lo vendo por ahora": borrar
// el producto allá lo sacaría del inventario real. La pausa vive solo de este lado, no toca nada en
// PLADE y se revierte con un clic.
//
// NO hay subcategorías. getInventario de PLADE devuelve exactamente 11 campos por producto y
// `categoria` es el único de taxonomía (ver COMUNICACION-PLADE.md). Si algún día PLADE agrega una,
// el lugar donde engancharla es claveCategoria() + este bloque.

/**
 * Quién puede pausar: el master siempre, y cualquier admin al que el master le haya dado el permiso
 * desde la pantalla de Usuarios. Mismo patrón que el contador de ventas (`canViewCounter`).
 */
function puedePausarCategorias(req) {
  return tienePermiso({ role: req.adminRole, ...req.adminUser }, 'categorias');
}

app.get('/api/admin/categories', requireAdminRole('admin'), (req, res) => {
  const pausadas = loadPausedCategories();
  const productos = loadProducts();

  const porCategoria = new Map();
  for (const p of productos) {
    const nombre = String(p.category || 'General').trim() || 'General';
    const clave = claveCategoria(nombre);
    const info = porCategoria.get(clave) || { nombre, total: 0, conStock: 0 };
    info.total += 1;
    if (p.stock === null || p.stock > 0) info.conStock += 1;
    porCategoria.set(clave, info);
  }

  // Una categoría pausada cuyos productos ya no vienen de PLADE tiene que seguir listándose: si
  // desapareciera de la pantalla quedaría pausada para siempre, sin forma de reactivarla.
  for (const [clave, info] of Object.entries(pausadas)) {
    if (!porCategoria.has(clave)) {
      porCategoria.set(clave, { nombre: info.nombreOriginal || clave, total: 0, conStock: 0 });
    }
  }

  const categories = [...porCategoria.entries()]
    .map(([key, info]) => ({
      key,
      name: info.nombre,
      total: info.total,
      inStock: info.conStock,
      paused: Boolean(pausadas[key]),
      pausedAt: pausadas[key] ? pausadas[key].pausedAt || null : null,
      pausedBy: pausadas[key] ? pausadas[key].by || null : null,
    }))
    .sort((a, b) => compararCategorias(a.name, b.name));

  res.json({
    categories,
    // El panel usa esto para mostrar los botones o solo la lista. El permiso real se revalida en el
    // PUT de abajo: esconder un botón no es la protección.
    canEdit: puedePausarCategorias(req),
    ocultos: productos.filter((p) => pausadas[claveCategoria(p.category || 'General')]).length,
    totalProductos: productos.length,
  });
});

// --- Comprobación del carrito CONTRA PLADE, antes de que el cliente pague ---
//
// El checkout cobra por transferencia: el cliente se va del sitio, hace el pago y vuelve a subir la
// captura. Descubrir ahí que un producto se agotó es descubrirlo TARDE — ya pagó. Por eso esta
// comprobación va antes, al entrar al paso de pago.
//
// Consulta a PLADE EN VIVO, no el catálogo cacheado: la sincronización corre cada 30 minutos y en
// ese hueco cabe una venta en el mostrador físico que deje el producto en cero.

/** El catálogo de PLADE recién traído, con su momento. Ver por qué existe en pladeFresco(). */
let inventarioFresco = null;
const FRESCURA_MS = 15 * 1000;

/**
 * Trae el inventario de PLADE, reutilizándolo si se pidió hace menos de 15 segundos.
 *
 * Los 15 segundos no son un caché de comodidad: son un freno de estampida. Si diez personas están
 * pagando a la vez, sin esto se dispararían diez descargas del catálogo completo (2,4 MB cada una)
 * contra el sistema del negocio. A efectos del cliente sigue siendo "en vivo": ninguna venta cambia
 * el mundo en quince segundos.
 */
async function pladeFresco() {
  if (inventarioFresco && Date.now() - inventarioFresco.at < FRESCURA_MS) return inventarioFresco.porId;

  const items = await getInventario(sucursalesDeInventario());
  const productos = items.map(mapPladeItemToProduct).filter((p) => p.id && p.title);
  const porId = new Map(productos.map((p) => [p.id, p]));
  inventarioFresco = { at: Date.now(), porId };

  // Además de responder esta comprobación, se APROVECHA para actualizar el catálogo de la tienda.
  //
  // Si PLADE acaba de decir que algo está en cero, no tiene sentido que cristal44.com lo siga
  // ofreciendo durante los minutos que falten para la próxima sincronización: en cuanto un cliente
  // lo detecta al pagar, el producto pasa a "Agotado" para TODO el mundo.
  //
  // Se usa replaceProductsCatalog() y no una escritura directa a propósito: esa función es la que
  // reconcilia stock_adjustments.json. Escribir el stock a mano descontaría dos veces las ventas
  // que PLADE ya procesó — el stock nuevo ya las trae restadas, y lo pendiente seguiría restándose
  // encima.
  try {
    replaceProductsCatalog(productos);
    lastPladeSync = { at: new Date().toISOString(), count: productos.length, motivo: 'checkout' };
  } catch (err) {
    // Que falle la actualización del catálogo no debe tumbar la comprobación del carrito, que es
    // para lo que el cliente está esperando.
    console.error('No se pudo actualizar el catálogo tras la comprobación de carrito:', err.message);
  }

  return porId;
}

app.post('/api/cart/check', async (req, res) => {
  if (isCartCheckRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Demasiadas comprobaciones. Esperá un momento.' });
  }

  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 100) : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'No hay productos que comprobar.' });
  }

  const pedidos = items.map((it) => ({
    id: String(it && it.id ? it.id : '').trim(),
    quantity: Math.max(1, Math.trunc(Number(it && it.quantity) || 1)),
  }));

  let porId;
  let fuente = 'plade';
  try {
    if (!isPladeConfigured()) throw new Error('PLADE no configurado');
    porId = await pladeFresco();
  } catch (err) {
    // PLADE caído o sin configurar: se comprueba contra el último catálogo sincronizado en vez de
    // bloquear la venta. Se avisa en la respuesta para que la tienda pueda decir que el dato puede
    // no estar al minuto — mejor una comprobación imperfecta que ninguna.
    console.error('Comprobación de carrito: no se pudo consultar PLADE, se usa el catálogo local:', err.message);
    porId = new Map(loadProducts().map((p) => [p.id, p]));
    fuente = 'local';
  }

  const ajustes = loadStockAdjustments();
  const resultado = pedidos.map(({ id, quantity }) => {
    const p = porId.get(id);
    if (!p) return { id, title: id, pedido: quantity, disponible: 0, estado: 'no_existe' };
    const titulo = p.title || id;
    // Un precio en cero no es una rebaja: es un producto mal cargado. Se trata como agotado, o el
    // cliente completaría el pedido pagando nada — y saldría "correcto", porque el precio lo toma
    // el servidor del catálogo.
    // Sin conteo en PLADE ya NO se vende. Antes eran venta libre; por decisión del dueño ahora
    // esperan a tener inventario de verdad, y se activan solos en cuanto PLADE les dé existencia.
    if (p.stock === null || p.stock === undefined) {
      return { id, title: titulo, pedido: quantity, disponible: 0, estado: 'proximamente' };
    }
    // Un precio en cero no es una rebaja: es una ficha a medio cargar. Se avisa como "próximamente"
    // y no como "agotado" porque decir que se agotó algo que sí está en el almacén sería mentir.
    if (!p.price || Number(p.price) <= 0) {
      return { id, title: titulo, pedido: quantity, disponible: 0, estado: 'proximamente' };
    }
    // Se descuenta lo ya comprometido por pedidos que PLADE todavía no procesó, igual que en la
    // creación del pedido: si no, dos personas se llevarían la misma última unidad.
    const disponible = unidadesComprables(applyPendingStock(Number(p.stock) || 0, id, ajustes));
    if (disponible <= 0) return { id, title: titulo, pedido: quantity, disponible: 0, estado: 'agotado' };
    if (quantity > disponible) return { id, title: titulo, pedido: quantity, disponible, estado: 'insuficiente' };
    return { id, title: titulo, pedido: quantity, disponible, estado: 'ok' };
  });

  const problemas = resultado.filter((r) => r.estado !== 'ok');
  res.json({ ok: problemas.length === 0, fuente, items: resultado, problemas });
});

// --- Contador de visitas ---
//
// Se guarda AGREGADO POR DÍA, nunca visita por visita: `{ "2026-08-31": { vistas, sesiones,
// paises: { VE: 120, CO: 8 } } }`. Sin IPs, sin identificadores, sin rutas por persona. Contar no
// necesita saber quién.
//
// `vistas` = páginas abiertas. `sesiones` = visitas distintas (la primera página de cada sesión del
// navegador). Se muestran las dos porque significan cosas distintas: 500 vistas de 20 sesiones es
// mucha gente mirando poco, o poca gente mirando mucho.

const DIAS_DE_VISITAS = 90;

// El país lo pone la red que tenemos delante, no el navegador: Vercel en `x-vercel-ip-country` y
// Cloudflare (que va delante de Render) en `cf-ipcountry`. Se prueban ambos porque la visita puede
// llegar por cualquiera de los dos caminos. Si ninguno lo dice, se cuenta como desconocido en vez
// de adivinar.
function paisDeLaPeticion(req) {
  // ⚠️ EL ORDEN IMPORTA Y NO ES INTERCAMBIABLE. `x-country` va PRIMERO.
  //
  // La visita no llega acá desde el navegador: la reenvía la función de Vercel, que es quien sí
  // conoce el país real del visitante y lo pone en `x-country`. Render está detrás de Cloudflare,
  // y Cloudflare sella `cf-ipcountry` con el país de QUIEN LLAMA — o sea, el centro de datos de
  // Vercel. Si `cf-ipcountry` se mira antes, tapa al país real y **todas las visitas quedan como
  // Estados Unidos**, que es exactamente lo que pasó el 2026-08-31.
  //
  // Los otros dos quedan de respaldo por si algún día la baliza pegara directo al backend.
  const crudo =
    req.headers['x-country'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['cf-ipcountry'] ||
    '';
  const pais = String(crudo).trim().toUpperCase();
  // Cloudflare usa XX para "no se sabe" y T1 para tráfico por Tor.
  if (!/^[A-Z]{2}$/.test(pais) || pais === 'XX' || pais === 'T1') return '??';
  return pais;
}

/**
 * Estado o región del visitante. Vercel manda el código ISO 3166-2 sin el prefijo del país.
 *
 * Solo se sigue a los TRES PAÍSES a los que vende la tienda — Venezuela, Colombia y Estados
 * Unidos. La región de un visitante de España no le dice nada al dueño y multiplicaría las claves
 * del archivo sin motivo.
 *
 * Se guarda CON el prefijo del país (`VE-G`, `US-GA`). El prefijo no es decorativo: sin él, "G"
 * sería Carabobo y Georgia a la vez, y "S" Táchira y Carolina del Sur.
 */
const PAISES_CON_REGION = new Set(['VE', 'CO', 'US']);

/**
 * Une las claves viejas con las nuevas.
 *
 * La primera versión de esto guardaba el código PELADO ("G") y solo para Venezuela; la de ahora lo
 * guarda con el país delante ("VE-G"). En el archivo conviven las dos formas, y sin normalizar el
 * panel mostraba **dos filas con el mismo nombre**: "Carabobo" por las visitas viejas y "Carabobo"
 * otra vez por las nuevas.
 *
 * Que una clave sin guion sea venezolana no es una suposición: en aquella versión la función
 * devolvía `null` para cualquier país que no fuera VE (commit def2047), así que no pudo escribirse
 * otra cosa.
 *
 * Se normaliza AL LEER y no reescribiendo el archivo a propósito: las visitas son el único registro
 * histórico que hay y no se gana nada tocándolo. Lo que se escribe hoy ya va con prefijo, así que
 * las claves peladas son un conjunto cerrado que no vuelve a crecer.
 */
function normalizaRegion(clave) {
  const k = String(clave || '').trim().toUpperCase();
  return k.includes('-') ? k : `VE-${k}`;
}

function regionDeLaPeticion(req, pais) {
  if (!PAISES_CON_REGION.has(pais)) return null;
  const crudo = String(req.headers['x-region'] || req.headers['x-vercel-ip-country-region'] || '')
    .trim()
    .toUpperCase();
  // Algunas redes lo mandan ya prefijado ("VE-G"): se quita para volver a ponerlo de forma uniforme.
  const limpio = crudo.startsWith(`${pais}-`) ? crudo.slice(3) : crudo;
  if (!/^[A-Z0-9]{1,3}$/.test(limpio)) return null;
  return `${pais}-${limpio}`;
}

// Los buscadores y los previsualizadores de enlaces (WhatsApp, Facebook) NO son visitas de
// personas. Sin este filtro, el conteo sube solo y el dueño cree que tiene tráfico que no tiene.
const ES_BOT = /bot|crawl|spider|slurp|bing|yandex|baidu|duckduck|facebookexternalhit|whatsapp|telegram|preview|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch/i;

/**
 * Tipo de aparato, deducido del user-agent. Se guarda solo la palabra ("movil"), nunca el
 * user-agent completo: eso último, junto a la hora, identifica a una persona bastante bien.
 *
 * El orden importa: una tablet Android dice "Android" pero NO dice "Mobile", así que hay que
 * descartarla antes de mirar si es móvil.
 */
function dispositivoDe(ua) {
  if (/ipad|tablet|playbook|silk|kindle|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(ua)) return 'movil';
  return 'escritorio';
}

/** Sistema operativo, también del user-agent. */
function sistemaDe(ua) {
  // iPhone/iPad primero: sus user-agents dicen "like Mac OS X" y si no, todos caerían en macOS.
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/android/i.test(ua)) return 'Android';
  if (/windows nt/i.test(ua)) return 'Windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/cros/i.test(ua)) return 'ChromeOS';
  if (/linux|ubuntu|fedora/i.test(ua)) return 'Linux';
  return 'Otro';
}

/**
 * De dónde llegó la visita. El navegador manda solo el DOMINIO de la página anterior, nunca la URL
 * completa: una URL de búsqueda o de un correo puede llevar datos personales en sus parámetros.
 *
 * Los dominios conocidos se agrupan con nombre legible (todos los `google.*` son Google) y el resto
 * se guarda tal cual, con un tope de 25 por día para que nadie pueda inflar el archivo mandando
 * dominios inventados.
 */
const ORIGENES_CONOCIDOS = [
  [/^(www\.)?google\./i, 'Google'],
  [/instagram|ig\.me/i, 'Instagram'],
  [/facebook|fb\.com|fb\.me/i, 'Facebook'],
  [/whatsapp|wa\.me/i, 'WhatsApp'],
  [/tiktok/i, 'TikTok'],
  [/youtube|youtu\.be/i, 'YouTube'],
  [/bing\./i, 'Bing'],
  [/t\.co$|twitter|x\.com$/i, 'X (Twitter)'],
  [/telegram|t\.me/i, 'Telegram'],
  [/duckduckgo/i, 'DuckDuckGo'],
];
const MAX_ORIGENES_POR_DIA = 25;

function origenDe(crudo) {
  const host = String(crudo || '').trim().toLowerCase().replace(/^www\./, '').slice(0, 80);
  if (!host) return 'Directo';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return 'Otros';
  for (const [patron, nombre] of ORIGENES_CONOCIDOS) {
    if (patron.test(host)) return nombre;
  }
  return host;
}

function claveDelDia(ms) {
  // En hora de Venezuela: si el día se cortara en UTC, las visitas de la tarde caerían en el día
  // siguiente y el gráfico no cuadraría con lo que ve el dueño. Mismo criterio que el contador de
  // ventas (startOfTodayVenezuela).
  const d = new Date(ms - 4 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Hora del día (0-23) en Venezuela. Se aplica el mismo desplazamiento que claveDelDia para que la
 * hora y el día que se guardan sean del mismo reloj: si una fuera de Venezuela y la otra de UTC,
 * las visitas de la noche aparecerían en la madrugada del día equivocado.
 */
function horaDeVenezuela(ms) {
  return new Date(ms - 4 * 3600_000).getUTCHours();
}

app.post('/api/visit', (req, res) => {
  // Siempre 204, pase lo que pase: es una baliza de conteo, y un error acá no debe ensuciar la
  // consola del cliente ni hacerle pensar que la tienda falla.
  res.status(204).end();

  try {
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || ES_BOT.test(ua)) return;
    if (isVisitRateLimited(req.ip)) return;

    const ahora = Date.now();
    const hoy = claveDelDia(ahora);
    const visitas = loadVisits();
    const dia = visitas[hoy] || { vistas: 0, sesiones: 0, paises: {} };
    // Los días guardados antes de que existieran estos desgloses no traen las claves: se crean al
    // vuelo en vez de romper.
    dia.dispositivos = dia.dispositivos || {};
    dia.sistemas = dia.sistemas || {};
    dia.origenes = dia.origenes || {};
    dia.horas = dia.horas || {};
    dia.estados = dia.estados || {};

    dia.vistas += 1;
    const pais = paisDeLaPeticion(req);
    dia.paises[pais] = (dia.paises[pais] || 0) + 1;

    const estado = regionDeLaPeticion(req, pais);
    if (estado) dia.estados[estado] = (dia.estados[estado] || 0) + 1;

    const aparato = dispositivoDe(ua);
    dia.dispositivos[aparato] = (dia.dispositivos[aparato] || 0) + 1;
    const sistema = sistemaDe(ua);
    dia.sistemas[sistema] = (dia.sistemas[sistema] || 0) + 1;

    const hora = horaDeVenezuela(ahora);
    dia.horas[hora] = (dia.horas[hora] || 0) + 1;

    if (req.body && req.body.nueva === true) {
      dia.sesiones += 1;
      // El origen se cuenta UNA vez por visita, no por página: si contara cada página, una persona
      // que llega de Instagram y mira 10 productos aparecería como 10 llegadas desde Instagram.
      const origen = origenDe(req.body.origen);
      if (dia.origenes[origen] !== undefined || Object.keys(dia.origenes).length < MAX_ORIGENES_POR_DIA) {
        dia.origenes[origen] = (dia.origenes[origen] || 0) + 1;
      } else {
        dia.origenes['Otros'] = (dia.origenes['Otros'] || 0) + 1;
      }
    }

    visitas[hoy] = dia;

    // Se recorta a 90 días para que el archivo no crezca para siempre. Con ~1 KB por día son unos
    // 90 KB como mucho.
    const dias = Object.keys(visitas).sort();
    for (const d of dias.slice(0, Math.max(0, dias.length - DIAS_DE_VISITAS))) delete visitas[d];

    saveVisits(visitas);
  } catch (err) {
    console.error('No se pudo registrar la visita:', err.message);
  }
});

/**
 * Repara los países mal registrados: los pasa a `??` (Sin determinar).
 *
 * Hasta el commit 5ff78be el país se leía de `cf-ipcountry`, que Cloudflare sella con el país de
 * QUIEN LLAMA a Render — el centro de datos de Vercel, en Estados Unidos. Todas las visitas
 * quedaron marcadas como US sin importar de dónde entrara la persona.
 *
 * NO se borran las visitas: ocurrieron de verdad y sus páginas, horas, aparatos y orígenes son
 * correctos. Lo único falso es la etiqueta de país, así que se sustituye por "no se sabe" en vez de
 * tirar datos buenos. Pasarlas a `??` además mantiene la cuenta cuadrada: si se borrara el desglose,
 * la suma por país no llegaría al total de páginas y los porcentajes mentirían.
 *
 * Va por día porque los datos se guardan por día: no hay forma de separar, dentro de la jornada en
 * que se desplegó el arreglo, las visitas de antes de las de después.
 */
app.post('/api/admin/visits/reparar-paises', requireAdminRole('admin'), (req, res) => {
  if (req.adminRole !== 'master') {
    return res.status(403).json({ error: 'Solo una cuenta Master puede tocar los datos de visitas.' });
  }

  const hasta = String((req.body && req.body.hasta) || claveDelDia(Date.now()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ error: 'Fecha no válida.' });
  }

  const visitas = loadVisits();
  let diasTocados = 0;
  let vistasReetiquetadas = 0;

  for (const [dia, d] of Object.entries(visitas)) {
    if (dia > hasta || !d || !d.paises) continue;
    const total = Object.values(d.paises).reduce((a, b) => a + (Number(b) || 0), 0);
    // Si el día ya está entero como desconocido, no hay nada que reparar.
    if (total === 0 || (Object.keys(d.paises).length === 1 && d.paises['??'] === total)) continue;
    d.paises = { '??': total };
    diasTocados += 1;
    vistasReetiquetadas += total;
  }

  if (diasTocados > 0) saveVisits(visitas);
  console.log(`Países de visitas reparados por ${req.adminUser.username}: ${diasTocados} días, ${vistasReetiquetadas} páginas hasta ${hasta}.`);
  res.json({ ok: true, diasTocados, vistasReetiquetadas, hasta });
});

app.get('/api/admin/visits', requireAdminRole('admin'), requierePermiso('visitas'), (req, res) => {

  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 7), DIAS_DE_VISITAS);
  const visitas = loadVisits();

  // Se rellenan los días sin visitas con ceros: un gráfico que se salta los días vacíos miente
  // sobre la forma de la curva.
  const serie = [];
  const hoyMs = Date.now();
  for (let i = dias - 1; i >= 0; i--) {
    const clave = claveDelDia(hoyMs - i * 24 * 3600_000);
    const d = visitas[clave] || { vistas: 0, sesiones: 0, paises: {} };
    serie.push({ dia: clave, vistas: d.vistas || 0, sesiones: d.sesiones || 0 });
  }

  // Un solo recorrido para los cuatro desgloses.
  const acumular = (campo, normaliza = (x) => x) => {
    const mapa = new Map();
    for (const { dia } of serie) {
      const d = visitas[dia];
      if (!d || !d[campo]) continue;
      for (const [clave, n] of Object.entries(d[campo])) {
        const k = normaliza(clave);
        mapa.set(k, (mapa.get(k) || 0) + n);
      }
    }
    return [...mapa.entries()]
      .map(([clave, total]) => ({ clave, total }))
      .sort((a, b) => b.total - a.total);
  };

  const paises = acumular('paises').map(({ clave, total }) => ({ codigo: clave, vistas: total }));

  // Las 24 horas SIEMPRE, incluso las que no tuvieron ninguna visita: un gráfico de horas al que le
  // faltan las de la madrugada haría creer que el día empieza a las 7.
  const porHora = new Map();
  for (const { dia } of serie) {
    const d = visitas[dia];
    if (!d || !d.horas) continue;
    for (const [h, n] of Object.entries(d.horas)) porHora.set(Number(h), (porHora.get(Number(h)) || 0) + n);
  }
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, vistas: porHora.get(h) || 0 }));
  const estados = acumular('estados', normalizaRegion).map(({ clave, total }) => ({ codigo: clave, vistas: total }));
  const dispositivos = acumular('dispositivos');
  const sistemas = acumular('sistemas');
  const origenes = acumular('origenes');

  const totalVistas = serie.reduce((a, d) => a + d.vistas, 0);
  const totalSesiones = serie.reduce((a, d) => a + d.sesiones, 0);
  const hoy = serie[serie.length - 1] || { vistas: 0, sesiones: 0 };

  res.json({
    dias,
    serie,
    paises,
    estados,
    horas,
    dispositivos,
    sistemas,
    origenes,
    totalVistas,
    totalSesiones,
    hoy,
    // Para poder decirle al dueño "todavía no hay datos" en vez de mostrarle un gráfico vacío que
    // parece un fallo.
    desde: Object.keys(visitas).sort()[0] || null,
  });
});

// --- Borrar los datos de prueba: dejar la tienda en cero antes de vender de verdad ---
//
// Durante el desarrollo se hicieron pedidos de prueba con el checkout REAL. Cada uno dejó rastro en
// CINCO sitios, no en uno:
//
//   1. orders_location.json        el pedido
//   2. stock_adjustments.json      el stock descontado, esperando a que PLADE procese la venta
//   3. orders_pdfs/ + comprobantes + recibos
//   4. customers.json              el cliente y su contador de pedidos
//   5. purchases (Supabase)        el monto que decide el NIVEL DE FIDELIDAD del cliente
//
// Borrar solo el pedido dejaría lo demás huérfano. El caso peor es el 2: esos descuentos solo se
// reconcilian cuando el stock de PLADE baja de verdad (ver replaceProductsCatalog), y como estas
// ventas nunca ocurrieron, el stock quedaría rebajado PARA SIEMPRE sin que nada lo explique.
//
// ⚠️ Lo que esto NO puede deshacer: **las facturas que ya se crearon en PLADE**. Cada checkout de
// Venezuela manda un pedido real a su sistema (submitOrderToPlade). Eso vive en la contabilidad del
// negocio, fuera de acá, y hay que anularlo en PLADE a mano.

/** Todo lo que se va a tocar, contado ANTES de tocarlo. No modifica nada. */
async function resumenDatosDePrueba() {
  const orders = loadOrdersLocation();
  const adjustments = loadStockAdjustments();
  const customers = loadCustomers();

  const contarArchivos = (dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
    } catch {
      return 0;
    }
  };

  let compras = null;
  try {
    compras = isLoyaltyConfigured() ? await countPurchases() : null;
  } catch (err) {
    compras = { error: err.message };
  }

  const fechas = orders.map((o) => o.createdAt).filter(Boolean).sort();

  return {
    pedidos: orders.length,
    pedidosAnulados: orders.filter((o) => o.cancelledAt).length,
    desde: fechas[0] || null,
    hasta: fechas[fechas.length - 1] || null,
    productosConStockPendiente: Object.keys(adjustments).length,
    unidadesPendientes: Object.values(adjustments).reduce((a, b) => a + Number(b || 0), 0),
    clientes: Object.keys(customers).length,
    pdfs: contarArchivos(ORDERS_PDF_DIR),
    comprobantes: contarArchivos(ORDERS_PAYMENT_PROOFS_DIR),
    recibos: contarArchivos(ORDERS_RECEIPTS_DIR),
    comprasSupabase: compras,
  };
}

app.get('/api/admin/test-data', requireAdminRole('admin'), requierePermiso('datos-prueba'), async (req, res) => {
  try {
    res.json(await resumenDatosDePrueba());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/test-data/purge', requireAdminRole('admin'), requierePermiso('datos-prueba'), async (req, res) => {
  // Se RELEE el permiso de la base, no se cree al token. Los permisos viajan firmados para no
  // consultar Supabase en cada request, pero eso hace que quitar uno tarde hasta 12 horas. Para un
  // borrado irreversible eso no alcanza: si el dueño le quitó este permiso a alguien, tiene que
  // dejar de poder borrar la tienda ya. El master no pasa por acá — su rol lo autoriza siempre.
  if (req.adminRole !== 'master' && req.adminUser.sub) {
    const fresco = await adminUsers.permisosFrescos(req.adminUser.sub);
    if (!fresco || !tienePermiso(fresco, 'datos-prueba')) {
      return res.status(403).json({ error: 'Tu cuenta ya no tiene habilitada esa función.' });
    }
  }
  // Palabra exacta, tecleada a mano en el panel. Un borrado total no puede depender de un solo clic
  // ni de un JSON vacío mandado por error.
  if (String(req.body && req.body.confirmar) !== 'BORRAR TODO') {
    return res.status(400).json({ error: 'Falta la confirmación exacta.' });
  }

  try {
    const antes = await resumenDatosDePrueba();
    const orders = loadOrdersLocation();
    const orderIds = orders.map((o) => o.orderId).filter(Boolean);

    // RESPALDO PRIMERO, en el mismo disco persistente. Si algo de esto no eran pruebas, los datos
    // siguen existiendo en este archivo y se pueden restaurar a mano.
    const sello = new Date().toISOString().replace(/[:.]/g, '-');
    const respaldo = path.join(DATA_DIR, `respaldo_antes_de_borrar_${sello}.json`);
    fs.writeFileSync(
      respaldo,
      JSON.stringify({ generadoEl: new Date().toISOString(), por: req.adminUser.username, orders, customers: loadCustomers(), stockAdjustments: loadStockAdjustments() }, null, 2)
    );

    let comprasBorradas = null;
    if (isLoyaltyConfigured() && orderIds.length > 0) {
      try {
        comprasBorradas = await deletePurchasesByOrderIds(orderIds);
      } catch (err) {
        // No se aborta: lo local ya se puede limpiar igual y el respaldo está hecho. Se informa.
        comprasBorradas = { error: err.message };
      }
    }

    saveOrdersLocation([]);
    saveCustomers({});
    // Clave: sin esto, el stock de los productos de prueba quedaría descontado para siempre.
    saveStockAdjustments({});

    const vaciarDir = (dir) => {
      let n = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith('.')) continue;
          fs.unlinkSync(path.join(dir, f));
          n += 1;
        }
      } catch {
        /* la carpeta puede no existir todavía */
      }
      return n;
    };
    const pdfs = vaciarDir(ORDERS_PDF_DIR);
    const comprobantes = vaciarDir(ORDERS_PAYMENT_PROOFS_DIR);
    const recibos = vaciarDir(ORDERS_RECEIPTS_DIR);

    console.log(`DATOS DE PRUEBA BORRADOS por ${req.adminUser.username}: ${antes.pedidos} pedidos. Respaldo: ${respaldo}`);
    res.json({
      ok: true,
      antes,
      borrado: { pedidos: orders.length, pdfs, comprobantes, recibos, comprasSupabase: comprasBorradas },
      respaldo: path.basename(respaldo),
      despues: await resumenDatosDePrueba(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/categories/:key/paused', requireAdminRole('admin'), (req, res) => {
  if (!puedePausarCategorias(req)) {
    return res.status(403).json({ error: 'Tu cuenta no tiene autorizado pausar categorías. Pedíselo al master.' });
  }

  const clave = claveCategoria(req.params.key);
  if (!clave) return res.status(400).json({ error: 'Categoría no válida.' });

  const paused = req.body && req.body.paused === true;
  const pausadas = loadPausedCategories();

  if (paused) {
    const productos = loadProducts();
    const existe = productos.find((p) => claveCategoria(p.category || 'General') === clave);
    // Sin productos que la usen no hay nada que ocultar, y aceptar la pausa dejaría basura en el
    // archivo que después aparece como una categoría fantasma en la pantalla.
    if (!existe && !pausadas[clave]) {
      return res.status(404).json({ error: 'Esa categoría no existe en el catálogo.' });
    }
    pausadas[clave] = {
      pausedAt: new Date().toISOString(),
      by: req.adminUser.username,
      nombreOriginal: existe ? String(existe.category || 'General').trim() : clave,
    };
  } else {
    delete pausadas[clave];
  }

  savePausedCategories(pausadas);
  console.log(`Categoría ${clave} ${paused ? 'PAUSADA' : 'reactivada'} por ${req.adminUser.username}`);

  const productos = loadProducts();
  res.json({
    ok: true,
    key: clave,
    paused,
    ocultos: productos.filter((p) => pausadas[claveCategoria(p.category || 'General')]).length,
  });
});

/**
 * Vista previa: NO modifica nada. Se mira antes de borrar, para que quede claro qué se va a tocar.
 */
app.get('/api/admin/products/demo-media', requireAdminRole('admin'), (req, res) => {
  const details = loadDetails();
  const catalogo = new Map(loadProducts().map((p) => [p.id, p]));

  const afectados = Object.entries(details)
    .map(([id, entry]) => ({ id, campos: mediaDePrueba(entry) }))
    .filter((x) => x.campos.length > 0)
    .map((x) => ({
      id: x.id,
      title: catalogo.get(x.id)?.title ?? '(no está en el catálogo)',
      campos: x.campos,
      urls: x.campos.map((c) => details[x.id][c]),
    }));

  res.json({ total: afectados.length, productos: afectados });
});

app.get('/api/admin/products/:id', requireAdminRole('admin'), (req, res) => {
  const product = getMergedProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json({ product });
});

// --- Limpieza del material de prueba que quedó en el catálogo ---
//
// El 2026-08-16 se detectaron 12 productos en producción mostrando a los clientes fotos de banco de
// imágenes (images.pexels.com) y el mismo video de ejemplo de W3Schools. Quedaron de pruebas
// anteriores; viven en product_details.json, que está en el disco de Render y por eso no se ve en
// el repo.
//
// SOLO borra lo que coincide con estos dominios. Una foto real subida desde el panel vive en
// Supabase Storage y no matchea, así que no hay forma de que este endpoint borre trabajo bueno.
// Si algún día se usa Pexels a propósito, sacarlo de la lista ANTES de correr esto.
const DOMINIOS_DE_PRUEBA = /(^|\/\/|\.)(pexels\.com|w3schools\.com)\//i;
const CAMPOS_MEDIA = ['image', 'image2', 'image3', 'image4', 'video'];

/** Devuelve qué campos de un producto apuntan a material de prueba. */
function mediaDePrueba(entry) {
  if (!entry) return [];
  return CAMPOS_MEDIA.filter((c) => entry[c] && DOMINIOS_DE_PRUEBA.test(String(entry[c])));
}

/**
 * Borra los campos de media que apuntan a los dominios de prueba. El resto de la ficha —material,
 * color, medidas, peso, descripción— **no se toca**: son datos cargados a mano que cuestan trabajo.
 * Al quedar el campo vacío, `mergeProductWithDetails` deja de sobreescribir y el producto vuelve a
 * mostrar la foto que venga de PLADE (o ninguna, si PLADE no tiene).
 */
app.post('/api/admin/products/demo-media/clean', requireAdminRole('admin'), (req, res) => {
  const details = loadDetails();
  const limpiados = [];

  for (const [id, entry] of Object.entries(details)) {
    const campos = mediaDePrueba(entry);
    if (campos.length === 0) continue;
    for (const c of campos) delete entry[c];
    // Si la ficha se queda sin nada, se saca del archivo en vez de dejar un objeto vacío.
    if (Object.keys(entry).length === 0) delete details[id];
    else details[id] = entry;
    limpiados.push({ id, campos });
  }

  if (limpiados.length > 0) saveDetails(details);
  console.log(`Limpieza de material de prueba: ${limpiados.length} productos afectados.`);
  res.json({ limpiados: limpiados.length, productos: limpiados });
});

/** Descripción y especificaciones. Solo se tocan los campos que vengan en el body. */
app.patch('/api/admin/products/:id/details', requireAdminRole('admin'), (req, res) => {
  const product = loadProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const details = loadDetails();
  const entry = { ...(details[product.id] || {}) };

  for (const field of ['description', 'material', 'color', 'video']) {
    if (req.body[field] === undefined) continue;
    const value = String(req.body[field] ?? '').trim();
    // Cadena vacía = borrar ese campo (el usuario limpió el input), a diferencia del importador
    // masivo, donde una celda vacía significa "no tocar".
    if (value) entry[field] = value;
    else delete entry[field];
  }
  for (const field of ['width', 'height', 'length', 'weight']) {
    if (req.body[field] === undefined) continue;
    const value = parseOptionalNumber(req.body[field]);
    if (value === null) delete entry[field];
    else entry[field] = value;
  }

  details[product.id] = entry;
  saveDetails(details);

  const merged = getMergedProducts().find((p) => p.id === product.id);
  res.json({ product: merged });
});

/**
 * Carga masiva de fichas por TOKEN, hermana de `/admin/details-upload` pero sin la contraseña.
 *
 * El importador de planilla exige `ADMIN_PASSWORD` en cada envío, así que solo lo puede usar quien
 * la escriba a mano. Este hace lo mismo con la sesión del panel, que es la que ya tiene el dueño
 * abierta — pensado para rescates puntuales como las fotos 2-4 que PLADE guarda en `img_1..img_3`
 * y que `getInventario` no devuelve.
 *
 * **Una sola escritura para todo el lote, no una por producto.** Con 357 fichas, guardar en cada
 * vuelta dejaría 357 ventanas con el archivo a medio actualizar mientras la tienda lo está leyendo,
 * y 357 oportunidades de cortarse por la mitad. Se arma todo en memoria y se graba una vez.
 *
 * **Un campo vacío NO borra**, igual que en la planilla: este endpoint agrega o pisa, nunca limpia.
 * Para borrar está el PATCH de arriba, producto por producto, que es donde ese gesto es deliberado.
 */
app.post('/api/admin/details/bulk', requireAdminRole('admin'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'Falta `items`: se espera un arreglo.' });
  if (items.length === 0) return res.status(400).json({ error: 'El arreglo `items` vino vacío.' });
  if (items.length > 5000) return res.status(413).json({ error: 'Máximo 5000 fichas por lote.' });

  const conocidos = new Set(loadProducts().map((p) => p.id));
  const details = loadDetails();

  let actualizados = 0;
  let camposEscritos = 0;
  const desconocidos = [];

  for (const item of items) {
    const id = String(item?.id ?? '').trim();
    if (!id) continue;
    // Un detalle huérfano no se puede mostrar en la tienda: se reporta en vez de guardarlo.
    if (!conocidos.has(id)) {
      if (desconocidos.length < 25) desconocidos.push(id);
      continue;
    }

    const entry = { ...(details[id] || {}) };
    let tocado = false;

    for (const field of DETAIL_TEXT_FIELDS) {
      const value = String(item[field] ?? '').trim();
      if (!value) continue;
      if (entry[field] === value) continue;
      entry[field] = value;
      tocado = true;
      camposEscritos++;
    }
    for (const field of DETAIL_NUMBER_FIELDS) {
      if (item[field] === undefined || item[field] === null || item[field] === '') continue;
      const value = parseOptionalNumber(item[field]);
      if (value === null || entry[field] === value) continue;
      entry[field] = value;
      tocado = true;
      camposEscritos++;
    }

    if (!tocado) continue;
    details[id] = entry;
    actualizados++;
  }

  if (actualizados > 0) saveDetails(details);
  console.log(`Carga masiva de fichas: ${actualizados} productos, ${camposEscritos} campos escritos.`);
  res.json({ recibidos: items.length, actualizados, camposEscritos, desconocidos });
});

app.post('/api/admin/products/:id/images', requireAdminRole('admin'), upload.single('file'), async (req, res) => {
  if (!productImages.isImagesConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no se pueden guardar fotos.' });
  }
  const product = loadProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen.' });

  const slot = String(req.body.slot || 'image');
  try {
    const url = await productImages.uploadProductImage(product.id, slot, req.file.buffer);
    const details = loadDetails();
    details[product.id] = { ...(details[product.id] || {}), [slot]: url };
    saveDetails(details);
    res.json({ slot, url, product: getMergedProducts().find((p) => p.id === product.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// El video es el quinto elemento de la ficha, igual que en PLADE. Va aparte de las fotos porque
// tiene su propio campo (`video`), su propio límite de tamaño y no se puede comprimir en el
// navegador como las imágenes. `uploadVideo` es un multer propio: el de las fotos corta en 10MB.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: productImages.MAX_VIDEO_BYTES },
});

app.post('/api/admin/products/:id/video', requireAdminRole('admin'), uploadVideo.single('file'), async (req, res) => {
  if (!productImages.isImagesConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no se pueden guardar videos.' });
  }
  const product = loadProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún video.' });

  try {
    const url = await productImages.uploadProductVideo(product.id, req.file.buffer);
    const details = loadDetails();
    details[product.id] = { ...(details[product.id] || {}), video: url };
    saveDetails(details);
    res.json({ url, product: getMergedProducts().find((p) => p.id === product.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id/video', requireAdminRole('admin'), async (req, res) => {
  if (!productImages.isImagesConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado.' });
  }
  const product = loadProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  try {
    await productImages.deleteProductVideo(product.id);
    const details = loadDetails();
    if (details[product.id]) {
      delete details[product.id].video;
      saveDetails(details);
    }
    res.json({ ok: true, product: getMergedProducts().find((p) => p.id === product.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/products/:id/images/:slot', requireAdminRole('admin'), async (req, res) => {
  if (!productImages.isImagesConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado.' });
  }
  const product = loadProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const slot = req.params.slot;
  if (!productImages.isValidSlot(slot)) return res.status(400).json({ error: 'Slot inválido.' });

  try {
    await productImages.deleteProductImage(product.id, slot);
    const details = loadDetails();
    if (details[product.id]) {
      // Se borra la clave en vez de dejarla vacía, así mergeProductWithDetails() vuelve a mostrar
      // lo que traiga PLADE en ese slot (relevante sobre todo para `image`).
      delete details[product.id][slot];
      saveDetails(details);
    }
    res.json({ ok: true, product: getMergedProducts().find((p) => p.id === product.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function scanOrderSummary(order) {
  return {
    orderId: order.orderId,
    createdAt: order.createdAt,
    nombre: order.nombre || null,
    telefono: order.telefono || null,
    total: order.total ?? null,
    paymentMethod: order.paymentMethod,
    reference: order.reference || null,
    paymentHolderName: order.paymentHolderName || null,
    proofUrl: order.proofUrl || null,
    items: order.items || [],
    dispatchedAt: order.dispatchedAt || null,
    dispatchedBy: order.dispatchedBy || null,
  };
}

// Escanea el código de barras del recibo (codifica el orderId crudo, ver generateOrderPdfBuffer más
// arriba) a la salida de la tienda: confirma los datos del pedido y lo marca como despachado — una
// sola vez. Si ya se había escaneado antes, NO lo vuelve a marcar y avisa que ya se procesó, para
// que la misma compra no pueda "salir" dos veces.
/**
 * Marcador de la pantalla de escaneo: cuántas salidas se hicieron hoy y cuántas quedan.
 *
 * Endpoint aparte de /api/admin/counter a propósito: ese es solo para master/admin autorizados
 * porque incluye montos, y quien está en la puerta tiene rol `salidas`. Acá no viaja ninguna cifra
 * de dinero, solo conteos operativos — se puede abrir a todos los que escanean.
 */
app.get('/api/admin/scan/stats', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  const desde = startOfTodayVenezuela();
  const orders = loadOrdersLocation();

  const hechasHoy = orders.filter((o) => {
    const t = new Date(o.dispatchedAt || 0).getTime();
    return Number.isFinite(t) && t >= desde && !o.cancelledAt;
  }).length;

  const pendientes = orders.filter((o) => !o.cancelledAt && !o.dispatchedAt);

  res.json({
    hechasHoy,
    // Faltantes = todo lo que no salió, de cualquier fecha: un pedido de ayer que el cliente no
    // retiró sigue esperando en la puerta. El de hoy va aparte, como referencia.
    faltantes: pendientes.length,
    faltantesDeHoy: pendientes.filter((o) => new Date(o.createdAt).getTime() >= desde).length,
    desde: new Date(desde).toISOString(),
  });
});

app.post('/api/admin/scan', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Falta el código escaneado.' });

  const orders = loadOrdersLocation();
  const order = orders.find((o) => o.orderId === code);
  if (!order) {
    return res.status(404).json({ error: 'No se encontró ningún pedido con ese código.' });
  }
  if (order.dispatchedAt) {
    return res.status(409).json({
      error: 'Esta compra ya está procesada y entregada/enviada, no se puede repetir.',
      order: scanOrderSummary(order),
    });
  }

  order.dispatchedAt = new Date().toISOString();
  // Antes guardaba solo el rol ("admin"/"salidas"), que con cuentas compartidas era todo lo que se
  // podía saber. Ahora guarda el usuario real; el rol queda como respaldo para los logins por
  // variable de entorno, donde no hay una persona identificada.
  order.dispatchedBy = req.adminUser.username || req.adminRole;
  saveOrdersLocation(orders);
  broadcastContador();
  res.json({ ok: true, order: scanOrderSummary(order) });
});

/**
 * Compara dos secretos en tiempo constante. Sin esto, el tiempo de respuesta filtra cuántos
 * caracteres del principio coinciden y la contraseña se puede adivinar carácter por carácter.
 */
function secretsMatch(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual exige el mismo largo; comparar el largo aparte no filtra nada útil.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Autenticación del panel HTML viejo (todo lo que cuelga de /admin en ESTE backend; el panel nuevo
 * vive en cristal44.com/admin y usa tokens).
 *
 * Por qué existe: hasta el 2026-08-09 este panel solo pedía contraseña en los POST. Los GET estaban
 * completamente abiertos, así que `GET /admin/purchases` publicaba las ventas reales —fecha, monto,
 * país— y, peor, el orderId COMPLETO de cada una enlazado a `/api/orders/:id/pdf`. Esos PDFs se
 * sirven sin credenciales a propósito (el orderId aleatorio es la llave, así el cliente abre su
 * recibo desde WhatsApp), y contienen nombre, cédula, teléfono y dirección del comprador. O sea que
 * cualquiera con la URL del backend —que es pública, va en el bundle del frontend— podía recorrer
 * la tabla y bajarse los datos personales de todos los clientes. Verificado en producción.
 *
 * Se usa Basic Auth y no un formulario con sesión porque son páginas HTML servidas de una: el
 * navegador ya sabe pedir las credenciales y reenviarlas, sin agregar cookies ni estado de sesión.
 * Solo se valida la contraseña, ignorando el usuario, para no cambiarle el modelo mental a quien ya
 * usaba este panel ("la contraseña de administración").
 */
function requireAdminPage(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep !== -1 && secretsMatch(decoded.slice(sep + 1), ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Panel - El Imperio del Cristal", charset="UTF-8"');
  res.status(401).send('Acceso restringido. Se necesita la contraseña de administración.');
}

// Cubre /admin y todo lo que cuelgue de ahí. NO afecta a /api/*: la tienda y el panel nuevo no
// pasan por acá (el panel nuevo usa /api/admin/* con token, verificado antes de aplicar esto).
app.use('/admin', requireAdminPage);

app.get('/admin', (req, res) => {
  const products = loadProducts();
  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Cargar inventario</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 1.4rem; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input[type=file], input[type=password] { display: block; margin-top: 4px; padding: 8px; width: 100%; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; }
    .status { margin-top: 16px; padding: 10px; border-radius: 6px; background: #f3f4f6; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.85rem; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    a.link-btn { display: inline-block; margin-top: 16px; color: #4f46e5; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Cargar inventario (CSV / Excel)</h1>
  <p>Sube el archivo exportado desde tu panel de facturación. Columnas esperadas (en cualquier orden): <b>Nombre, Precio, Existencia, Categoria, Codigo, Descripcion, Imagen</b> (las últimas 3 son opcionales). También reconoce, si las incluyes: <b>Ancho, Alto, Largo, Material, Peso, Color</b>.</p>
  <form action="/admin/upload" method="post" enctype="multipart/form-data">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>
    <label>Archivo (.csv, .xlsx, .xls)</label>
    <input type="file" name="file" accept=".csv,.xlsx,.xls" required>
    <button type="submit">Subir y reemplazar inventario</button>
  </form>
  <div class="status">Productos actualmente cargados: <b>${products.length}</b>
    &nbsp;·&nbsp; con foto: <b>${products.filter((p) => p.image).length}</b>
    &nbsp;·&nbsp; con descripción: <b>${products.filter((p) => p.description && String(p.description).trim()).length}</b>
  </div>

  <h1 style="margin-top:36px">Cargar descripciones e imágenes adicionales</h1>
  <p>
    PLADE solo envía <b>una</b> imagen por producto y ninguna descripción larga, así que esos datos se
    cargan por acá. A diferencia del formulario de arriba, esto <b>no reemplaza el inventario</b>: se
    guarda en una capa aparte que se fusiona al mostrar el catálogo, por lo que
    <b>la sincronización con PLADE no lo pisa</b>.
  </p>
  <p>
    Columna obligatoria: <b>Codigo</b> (el mismo código interno del producto).<br>
    Columnas opcionales, las que quieras incluir: <b>Descripcion, Imagen, Imagen2, Imagen3, Imagen4,
    Video, Material, Color, Ancho, Alto, Largo, Peso</b>.<br>
    Una celda vacía deja el valor que ya estuviera cargado — no lo borra.
  </p>
  <form action="/admin/details-upload" method="post" enctype="multipart/form-data">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>
    <label>Archivo (.csv, .xlsx, .xls)</label>
    <input type="file" name="file" accept=".csv,.xlsx,.xls" required>
    <button type="submit">Cargar descripciones e imágenes</button>
  </form>
  <a class="link-btn" href="/admin/details-template.csv">Descargar planilla de ejemplo (.csv) &rarr;</a>

  <div class="status" style="margin-top:36px">
    <b>Sincronización con PLADE SOFTWARE:</b>
    ${isPladeConfigured() ? 'activa (cada 30 min)' : 'no configurada (faltan variables de entorno PLADE_USER/PLADE_PASSWORD/PLADE_TOKEN)'}<br>
    ${lastPladeSync
      ? (lastPladeSync.error
          ? `Último intento (${lastPladeSync.at}): <span style="color:#b91c1c">error — ${escapeHtml(lastPladeSync.error)}</span>`
          : `Última sincronización exitosa: ${lastPladeSync.at} — ${lastPladeSync.count} productos`)
      : 'Todavía no se ha sincronizado en esta sesión del servidor.'}
  </div>
  ${isPladeConfigured() ? `
  <form action="/admin/sync-plade" method="post">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>
    <button type="submit">Sincronizar con PLADE ahora</button>
  </form>
  ` : ''}

  <div class="status">
    <b>Recordatorio de carrito abandonado por correo:</b>
    ${isCartReminderConfigured() ? 'configurado (Resend)' : 'no configurado (faltan RESEND_API_KEY/CART_REMINDER_FROM_EMAIL)'}
  </div>
  ${isCartReminderConfigured() ? `
  <form action="/admin/send-cart-reminders" method="post">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>
    <button type="submit">Enviar recordatorios ahora</button>
  </form>
  ` : ''}

  ${products.length ? `
  <table>
    <tr><th>ID</th><th>Nombre</th><th>Precio</th><th>Stock</th><th>Categoría</th></tr>
    ${products.slice(0, 20).map(p => `<tr><td>${escapeHtml(p.id)}</td><td>${escapeHtml(p.title)}</td><td>$${p.price.toFixed(2)}</td><td>${p.stock ?? '-'}</td><td>${escapeHtml(p.category)}</td></tr>`).join('')}
  </table>
  ${products.length > 20 ? `<p>... y ${products.length - 20} más.</p>` : ''}
  ` : ''}
  <a class="link-btn" href="/admin/products">Completar/editar especificaciones de productos (material, color, medidas, peso) &rarr;</a><br>
  <a class="link-btn" href="/admin/purchases">Ver/anular compras del nivel de fidelidad &rarr;</a>
</body>
</html>`);
});

app.post('/admin/upload', upload.single('file'), (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin">Volver</a>');
  }
  if (!req.file) {
    return res.status(400).send('No se recibió ningún archivo. <a href="/admin">Volver</a>');
  }

  try {
    const workbook = readWorkbookAutoEncoding(req.file.buffer);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).send('El archivo no tiene filas de datos. <a href="/admin">Volver</a>');
    }

    const headers = Object.keys(rows[0]);
    const columnMap = buildColumnMap(headers);

    if (!columnMap.name) {
      return res.status(400).send(
        `No se encontró una columna de nombre de producto. Columnas detectadas: ${headers.join(', ')}. ` +
        `Renombra la columna del nombre a "Nombre" e intenta de nuevo. <a href="/admin">Volver</a>`
      );
    }

    const products = rowsToProducts(rows, columnMap);
    replaceProductsCatalog(products);

    res.send(`Inventario actualizado: ${products.length} productos cargados. <a href="/admin">Volver</a>`);
  } catch (err) {
    res.status(500).send(`Error procesando el archivo: ${err.message}. <a href="/admin">Volver</a>`);
  }
});

function csvCell(value) {
  const s = String(value ?? '');
  // Los títulos del catálogo traen comas y comillas — sin escapar, la planilla queda corrida.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Planilla para el importador de detalles. No es un ejemplo vacío: viene precargada con los
 * productos que HOY no tienen foto, que son los que hay que atacar primero (Google necesita una
 * imagen para mostrar un resultado enriquecido de producto). La columna Nombre va solo como
 * referencia para quien llena la planilla — el importador la ignora, matchea por Codigo.
 */
app.get('/admin/details-template.csv', (req, res) => {
  const sinFoto = getMergedProducts().filter((p) => !p.image);
  const headers = ['Codigo', 'Nombre', 'Descripcion', 'Imagen', 'Imagen2', 'Imagen3', 'Imagen4', 'Video', 'Material', 'Color', 'Ancho', 'Alto', 'Largo', 'Peso'];
  const lines = [headers.join(',')];
  for (const p of sinFoto) {
    lines.push([csvCell(p.id), csvCell(p.title), '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="productos-sin-foto.csv"');
  // BOM para que Excel en Windows abra los acentos bien en vez de mostrarlos como "Ã±".
  res.send('﻿' + lines.join('\r\n'));
});

/**
 * Carga masiva de descripciones e imágenes adicionales a product_details.json.
 *
 * NO confundir con /admin/upload: ese reemplaza el catálogo CRUDO y la sincronización con PLADE lo
 * pisa a los 30 minutos. Este escribe en la capa de detalles, que se fusiona al LEER
 * (mergeProductWithDetails) y por lo tanto sobrevive a toda sincronización.
 *
 * Fusiona campo por campo: una celda vacía NO borra lo que ya estaba cargado, y las columnas que no
 * estén en la planilla ni se tocan. Así se puede subir una planilla solo con descripciones sin
 * perder las medidas/material que alguien ya cargó a mano desde /admin/products.
 */
app.post('/admin/details-upload', upload.single('file'), (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin">Volver</a>');
  }
  if (!req.file) {
    return res.status(400).send('No se recibió ningún archivo. <a href="/admin">Volver</a>');
  }

  try {
    const workbook = readWorkbookAutoEncoding(req.file.buffer);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    if (rows.length === 0) {
      return res.status(400).send('El archivo no tiene filas de datos. <a href="/admin">Volver</a>');
    }

    const headers = Object.keys(rows[0]);
    const columnMap = buildColumnMap(headers, DETAIL_FIELD_SYNONYMS);

    if (!columnMap.sku) {
      return res.status(400).send(
        `No se encontró la columna de código de producto. Columnas detectadas: ${escapeHtml(headers.join(', '))}. ` +
        `Renombra la columna del código a "Codigo" e intenta de nuevo. <a href="/admin">Volver</a>`
      );
    }

    const editables = [...DETAIL_TEXT_FIELDS, ...DETAIL_NUMBER_FIELDS].filter((f) => columnMap[f]);
    if (editables.length === 0) {
      return res.status(400).send(
        `La planilla no tiene ninguna columna de datos reconocida (descripcion, imagen2, imagen3, imagen4, video, ` +
        `material, color, ancho, alto, largo, peso). Columnas detectadas: ${escapeHtml(headers.join(', '))}. ` +
        `<a href="/admin">Volver</a>`
      );
    }

    // Se valida contra el catálogo crudo: un código que no exista ahí no se puede mostrar en la
    // tienda, así que conviene reportarlo en vez de guardar un detalle huérfano.
    const knownIds = new Set(loadProducts().map((p) => p.id));
    const details = loadDetails();

    let actualizados = 0;
    let camposEscritos = 0;
    const desconocidos = [];

    for (const row of rows) {
      const id = String(row[columnMap.sku] ?? '').trim();
      if (!id) continue;
      if (!knownIds.has(id)) {
        if (desconocidos.length < 25) desconocidos.push(id);
        continue;
      }

      const entry = { ...(details[id] || {}) };
      let cambio = false;

      for (const field of DETAIL_TEXT_FIELDS) {
        if (!columnMap[field]) continue;
        const value = String(row[columnMap[field]] ?? '').trim();
        if (!value) continue; // celda vacía = "no tocar", no "borrar"
        if (entry[field] !== value) cambio = true;
        entry[field] = value;
        camposEscritos++;
      }
      for (const field of DETAIL_NUMBER_FIELDS) {
        if (!columnMap[field]) continue;
        const value = parseOptionalNumber(row[columnMap[field]]);
        if (value === null) continue;
        if (entry[field] !== value) cambio = true;
        entry[field] = value;
        camposEscritos++;
      }

      if (cambio) {
        details[id] = entry;
        actualizados++;
      }
    }

    saveDetails(details);

    const avisoDesconocidos = desconocidos.length
      ? `<p style="color:#b45309">${desconocidos.length === 25 ? 'Al menos 25' : desconocidos.length} código(s) de la ` +
        `planilla no existen en el catálogo y se omitieron: ${escapeHtml(desconocidos.join(', '))}` +
        `${desconocidos.length === 25 ? ' …' : ''}</p>`
      : '';

    res.send(
      `<p>Detalles actualizados: <b>${actualizados}</b> producto(s), ${camposEscritos} campo(s) escrito(s).</p>` +
      `<p>Columnas reconocidas: ${escapeHtml(editables.join(', '))}.</p>` +
      avisoDesconocidos +
      `<p>Estos datos se fusionan al leer el catálogo, así que <b>no los pisa la sincronización con PLADE</b>.</p>` +
      `<a href="/admin">Volver</a>`
    );
  } catch (err) {
    res.status(500).send(`Error procesando el archivo: ${escapeHtml(err.message)}. <a href="/admin">Volver</a>`);
  }
});

app.post('/admin/sync-plade', async (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin">Volver</a>');
  }
  if (!isPladeConfigured()) {
    return res.status(400).send('PLADE no está configurado (faltan PLADE_USER/PLADE_PASSWORD/PLADE_TOKEN). <a href="/admin">Volver</a>');
  }
  try {
    const count = await syncProductsFromPlade();
    res.send(`Sincronizado con PLADE: ${count} productos actualizados. <a href="/admin">Volver</a>`);
  } catch (err) {
    res.status(500).send(`Error sincronizando con PLADE: ${err.message}. <a href="/admin">Volver</a>`);
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

app.get('/admin/products', (req, res) => {
  const products = getMergedProducts();
  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Especificaciones de productos</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 1.4rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 0.85rem; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    a { color: #4f46e5; }
  </style>
</head>
<body>
  <h1>Especificaciones de productos</h1>
  <p>Completa manualmente material, color, medidas y peso de los productos que quieras — estos datos no vienen del Excel de facturación. Se conservan aunque vuelvas a subir un nuevo inventario.</p>
  <table>
    <tr><th>ID</th><th>Nombre</th><th>Material</th><th>Color</th><th>Medidas (An x Al x La cm)</th><th>Peso (g)</th><th></th></tr>
    ${products.map((p) => `<tr>
      <td>${escapeHtml(p.id)}</td>
      <td>${escapeHtml(p.title)}</td>
      <td>${escapeHtml(p.material ?? '—')}</td>
      <td>${escapeHtml(p.color ?? '—')}</td>
      <td>${p.width ?? '—'} x ${p.height ?? '—'} x ${p.length ?? '—'}</td>
      <td>${p.weight ?? '—'}</td>
      <td><a href="/admin/products/${encodeURIComponent(p.id)}/edit">Editar</a></td>
    </tr>`).join('')}
  </table>
  <p><a href="/admin">&larr; Volver</a></p>
</body>
</html>`);
});

app.get('/admin/products/:id/edit', (req, res) => {
  const products = getMergedProducts();
  const product = products.find((p) => p.id === req.params.id);
  if (!product) {
    return res.status(404).send('Producto no encontrado. <a href="/admin/products">Volver</a>');
  }

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Editar ${escapeHtml(product.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input, textarea { display: block; margin-top: 4px; padding: 8px; width: 100%; box-sizing: border-box; font-family: inherit; }
    button { margin-top: 16px; padding: 10px 20px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer; }
    .row { display: flex; gap: 8px; }
    .row > div { flex: 1; }
  </style>
</head>
<body>
  <h1>${escapeHtml(product.title)}</h1>
  <form method="post" action="/admin/products/${encodeURIComponent(product.id)}">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>

    <label>Descripción breve</label>
    <textarea name="description" rows="3" placeholder="Descripción del producto">${escapeHtml(product.description ?? '')}</textarea>

    <label>Material</label>
    <input type="text" name="material" value="${escapeHtml(product.material ?? '')}" placeholder="Ej: Cristal soplado">

    <label>Color</label>
    <input type="text" name="color" value="${escapeHtml(product.color ?? '')}" placeholder="Ej: Transparente, Ámbar">

    <label>Medidas (cm)</label>
    <div class="row">
      <div><input type="number" step="0.1" name="width" value="${product.width ?? ''}" placeholder="Ancho"></div>
      <div><input type="number" step="0.1" name="height" value="${product.height ?? ''}" placeholder="Alto"></div>
      <div><input type="number" step="0.1" name="length" value="${product.length ?? ''}" placeholder="Largo"></div>
    </div>

    <label>Peso (gramos)</label>
    <input type="number" step="1" name="weight" value="${product.weight ?? ''}" placeholder="Ej: 250">

    <label>Foto principal (URL)</label>
    <input type="url" name="image" value="${escapeHtml(product.image ?? '')}" placeholder="URL foto principal">

    <label>Fotos adicionales (URL)</label>
    <input type="url" name="image2" value="${escapeHtml(product.image2 ?? '')}" placeholder="URL foto 2">
    <input type="url" name="image3" value="${escapeHtml(product.image3 ?? '')}" placeholder="URL foto 3">
    <input type="url" name="image4" value="${escapeHtml(product.image4 ?? '')}" placeholder="URL foto 4">

    <label>Video (URL, ej. mp4 directo o link de YouTube)</label>
    <input type="url" name="video" value="${escapeHtml(product.video ?? '')}" placeholder="URL del video">

    <button type="submit">Guardar</button>
  </form>
  <p><a href="/admin/products">&larr; Volver</a></p>
</body>
</html>`);
});

app.post('/admin/products/:id', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin/products">Volver</a>');
  }

  const products = loadProducts();
  const product = products.find((p) => p.id === req.params.id);
  if (!product) {
    return res.status(404).send('Producto no encontrado. <a href="/admin/products">Volver</a>');
  }

  const details = loadDetails();
  details[product.id] = {
    description: req.body.description ? String(req.body.description).trim() : null,
    material: req.body.material ? String(req.body.material).trim() : null,
    color: req.body.color ? String(req.body.color).trim() : null,
    width: parseOptionalNumber(req.body.width),
    height: parseOptionalNumber(req.body.height),
    length: parseOptionalNumber(req.body.length),
    weight: parseOptionalNumber(req.body.weight),
    image: req.body.image ? String(req.body.image).trim() : null,
    image2: req.body.image2 ? String(req.body.image2).trim() : null,
    image3: req.body.image3 ? String(req.body.image3).trim() : null,
    image4: req.body.image4 ? String(req.body.image4).trim() : null,
    video: req.body.video ? String(req.body.video).trim() : null,
  };
  saveDetails(details);

  res.send(`Especificaciones guardadas para "${escapeHtml(product.title)}". <a href="/admin/products">Volver</a>`);
});

app.get('/api/products', (req, res) => {
  res.json(soloCategoriasActivas(getMergedProducts()));
});

// Lote de productos por ID (ej. "Últimos productos visitados" en tienda_web) — un solo request en
// vez de una llamada por producto. Tiene que ir ANTES de /api/products/:id para que Express no
// interprete "batch" como un id.
app.get('/api/products/batch', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return res.json([]);
  const idSet = new Set(ids);
  res.json(soloCategoriasActivas(getMergedProducts()).filter((p) => idSet.has(p.id)));
});

// Muestra aleatoria de productos con imagen y stock — usado por tienda_web para sugerir productos
// ("Quizás pueda interesarte") en el carrito/checkout, excluyendo lo que el cliente ya tiene en el
// carrito o ya vio. Con `maxStock` filtra a solo productos con poco stock (0 < stock < maxStock),
// para el rail de "Últimas unidades" — sin este parámetro, cualquier producto con stock cuenta.
// También tiene que ir ANTES de /api/products/:id.
// Cuántos de los mejor surtidos entran en el sorteo cuando se pide `orden=mas-stock`. Se sortea
// entre ellos en vez de mostrar los 8 primeros a secas: si no, TODOS los clientes verían siempre
// los mismos ocho productos y el rail dejaría de ser una sugerencia para ser un cartel fijo.
const ANCHO_MAS_STOCK = 100;

app.get('/api/products/random', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);
  const exclude = new Set(String(req.query.exclude || '').split(',').map((s) => s.trim()).filter(Boolean));
  const maxStock = req.query.maxStock ? Math.max(1, parseInt(req.query.maxStock, 10) || 0) : null;
  // `orden=mas-stock`: sugerir lo que sobra, no lo que se está acabando. Lo pidió el dueño el
  // 2026-09-02 — en el paso de pago las sugerencias salían casi todas con el aviso rojo de "últimas
  // unidades", que al lado del botón de pagar transmite una tienda vaciándose.
  const masStock = req.query.orden === 'mas-stock';

  const pool = soloCategoriasActivas(getMergedProducts()).filter((p) => {
    if (exclude.has(p.id) || !p.image) return false;
    // Solo lo que el cliente puede comprar DE VERDAD. Antes entraban los de `stock === null` y los
    // de precio 0: desde que esos salen como "Disponible próximamente" (ver 2.32), sugerirlos era
    // ofrecer en la caja algo que no se puede meter al carrito.
    if (!p.price || Number(p.price) <= 0) return false;
    const unidades = unidadesComprables(p.stock);
    if (unidades === null || unidades < 1) return false;
    if (maxStock !== null) return unidades < maxStock;
    return true;
  });

  // Se sortea sobre una copia: `splice` va vaciando el arreglo y no debe tocar el pool original.
  const candidatos = masStock
    ? [...pool].sort((a, b) => Number(b.stock) - Number(a.stock)).slice(0, ANCHO_MAS_STOCK)
    : [...pool];

  const picked = [];
  while (picked.length < limit && candidatos.length > 0) {
    const i = Math.floor(Math.random() * candidatos.length);
    picked.push(candidatos.splice(i, 1)[0]);
  }
  res.json(picked);
});

// Un solo producto por ID — evita que la página de cada producto tenga que descargar el
// catálogo completo (varios MB) solo para mostrar uno. Importante: NO usa getMergedProducts()
// (fusiona los ~8700 productos completos en cada llamada) porque el build estático de
// tienda_web pega a este endpoint una vez por producto (~8700 veces seguidas) — con el merge
// completo cada request quedaba haciendo ~8700 spreads de objeto de más, y esa carga sostenida
// terminó tumbando el backend (ECONNRESET) a mitad del build. Acá se busca el producto crudo
// primero (barato) y solo se fusionan detalles/reviews para ese único producto.
app.get('/api/products/:id', (req, res) => {
  const raw = loadProducts().find((p) => p.id === req.params.id);
  if (!raw) return res.status(404).json({ error: 'Producto no encontrado.' });
  // Mismo 404 que un producto inexistente, a propósito: si su categoría está pausada, la ficha no
  // existe para el cliente. Sin esto, un enlace guardado o un resultado viejo de Google seguiría
  // mostrándolo —y dejándolo comprar— aunque no aparezca en ninguna lista.
  if (categoriasPausadasSet().has(claveCategoria(raw.category || 'General'))) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }
  const merged = mergeProductWithDetails(raw, loadDetails());
  const stock = applyPendingStock(merged.stock, raw.id, loadStockAdjustments());
  res.json({ ...merged, stock, ...ratingSummary(loadReviews()[raw.id]) });
});

app.get('/api/categories', (req, res) => {
  const products = soloCategoriasActivas(loadProducts());
  // Ordenadas alfabéticamente. Antes salían en el orden en que aparecían los productos en el
  // catálogo, que es tanto como decir al azar: el cliente veía GENERAL, ACERO, ACRILICO, ALAMBRE…
  // y más abajo CRISTAL CHECO CINDY antes que CRISTAL CHECO. Con 125 categorías en un desplegable,
  // sin orden no se encuentra nada. El frontend NO reordena (ver CategoryDropdown), así que el
  // orden tiene que salir bien de acá.
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))].sort(compararCategorias);
  res.json(categories);
});

// Cuántos productos puede comprar HOY un cliente. Lo consume el contador de la portada.
//
// Endpoint aparte y no un campo en /api/products a propósito: el catálogo pesa 2,4 MB y el
// contador se refresca solo cada minuto en cada pestaña abierta. Mandar el catálogo entero para
// mostrar un número sería descargar megabytes por un dato de cuatro cifras.
//
// "Disponible" es exactamente lo mismo que decide la banda azul/roja de la tienda: hace falta
// stock de 1 unidad ENTERA o más y un precio de verdad. Los tres descartes tienen su razón:
//   - stock null      -> PLADE no lleva la cuenta; se muestra "Disponible próximamente" (ver 2.32)
//   - stock 0.8       -> no se puede vender una unidad, así que para el cliente no existe
//   - precio 0        -> ficha a medio cargar; tampoco se vende
// Si esta regla cambia, tiene que cambiar a la vez en tienda_web/lib/disponibilidad.ts.
app.get('/api/stats/disponibles', (req, res) => {
  const ajustes = loadStockAdjustments();
  // soloCategoriasActivas: lo que está en una categoría pausada no se puede comprar, así que no
  // cuenta. Sin esto, pausar una categoría dejaba el contador prometiendo mercancía invisible.
  const productos = soloCategoriasActivas(loadProducts());
  let disponibles = 0;
  for (const p of productos) {
    if (!p.price || Number(p.price) <= 0) continue;
    // Contra el stock EFECTIVO —descontando pedidos que PLADE todavía no procesó— porque es el
    // número que ve el comprador en la ficha. Si no, el contador diría una cosa y el producto otra.
    const unidades = unidadesComprables(applyPendingStock(p.stock, p.id, ajustes));
    if (unidades !== null && unidades >= 1) disponibles += 1;
  }
  // Medio minuto de caché: con varias pestañas abiertas refrescando, esto lo absorbe Cloudflare en
  // vez de llegar acá. Para un contador de catálogo, medio minuto de retraso no se nota.
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ disponibles, total: productos.length, actualizado: new Date().toISOString() });
});

// --- Simple in-memory rate limiter, per IP, reused for chat and review submissions ---
function makeRateLimiter(limit, windowMs) {
  const byIp = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    const entry = byIp.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      byIp.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  };
}

const isChatRateLimited = makeRateLimiter(20, 60 * 60 * 1000); // 20 messages/hour
// Generoso a propósito: una persona navegando 40 páginas en una hora es normal, y pasarse solo
// significa que se dejan de contar sus páginas de más, no que se le bloquee el sitio.
const isVisitRateLimited = makeRateLimiter(120, 60 * 60 * 1000);
// La comprobación de carrito pega a PLADE. 30 por hora deja rehacer el checkout varias veces sin
// convertir la tienda en una fuente de carga para el sistema del negocio.
const isCartCheckRateLimited = makeRateLimiter(30, 60 * 60 * 1000);
const isReviewRateLimited = makeRateLimiter(5, 60 * 60 * 1000); // 5 reviews/hour
const isOrderRateLimited = makeRateLimiter(10, 60 * 60 * 1000); // 10 pedidos/hora/IP

// Registro interno (no es un backend de pedidos real, ver checkout simulado): guarda ESTADO/CIUDAD/
// PARROQUIA para estadística de ventas por ubicación, y CEDULA/TELEFONO/CORREO en una lista de
// clientes deduplicada para poder contactarlos a futuro (publicidad, avisos).
// Uso multer directo adentro del handler (en vez de como middleware de ruta) para poder
// convertir un error suyo (imagen demasiado pesada, tipo de archivo no permitido) en una
// respuesta JSON prolija en vez de que caiga en el manejador de errores HTML por default de
// Express — no hay ningún middleware de errores general en este servidor.
app.post('/api/orders', (req, res) => {
  uploadPaymentProof.single('paymentProof')(req, res, async (uploadErr) => {
  if (uploadErr) {
    return res.status(400).json({ error: 'La captura del pago no se pudo subir (¿pesa más de 8MB o no es una imagen?).' });
  }
  if (isOrderRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Demasiados pedidos registrados. Intenta de nuevo más tarde.' });
  }

  const body = req.body || {};
  const estado = String(body.estado ?? '').trim();
  const ciudad = String(body.ciudad ?? '').trim();
  const parroquia = String(body.parroquia ?? '').trim();
  const address = String(body.address ?? '').trim();
  const idType = String(body.idType ?? '').trim();
  const cedula = String(body.cedula ?? '').trim();
  const nombre = String(body.nombre ?? '').trim();
  const telefono = String(body.telefono ?? '').trim();
  const correo = String(body.correo ?? '').trim();
  const deliveryMethod = String(body.deliveryMethod ?? '');
  const paymentMethod = String(body.paymentMethod ?? '');
  const reference = body.reference ? String(body.reference).trim() : '';
  const paymentHolderName = body.paymentHolderName ? String(body.paymentHolderName).trim() : '';
  const pickupStore = body.pickupStore ? String(body.pickupStore) : '';
  const courier = body.courier ? String(body.courier) : '';
  const deliveryZone = body.deliveryZone ? String(body.deliveryZone) : '';
  const deliveryFee = Number.isFinite(Number(body.deliveryFee)) && Number(body.deliveryFee) > 0 ? Number(body.deliveryFee) : 0;
  const destinationCountry = body.destinationCountry ? String(body.destinationCountry).trim() : '';
  const country = String(body.country ?? 'VE').trim() || 'VE';
  // Va como string JSON dentro del multipart (el archivo adjunto obliga a mandar el pedido como
  // form-data en vez de JSON puro — ver submitOrder() en tienda_web/lib/api.ts).
  let items;
  try {
    items = JSON.parse(body.items || '[]');
  } catch {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  const total = Number(body.total);
  const bcvRate = Number.isFinite(Number(body.bcvRate)) && Number(body.bcvRate) > 0 ? Number(body.bcvRate) : null;
  const trmRate = Number.isFinite(Number(body.trmRate)) && Number(body.trmRate) > 0 ? Number(body.trmRate) : null;
  // Solo el uuid de Supabase — cualquier descuento/nivel que venga del cliente (si viniera) se
  // ignora por completo más abajo. El backend recalcula el descuento real contra Supabase.
  const userId = body.userId ? String(body.userId).trim() : '';

  if (!estado || !ciudad || !parroquia || !address || !cedula || !telefono || !correo) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }
  if (items.length === 0 || !Number.isFinite(total)) {
    return res.status(400).json({ error: 'Faltan los productos o el total del pedido.' });
  }
  // Efectivo se paga al recibir el pedido — no hay captura de pago que pedir en ese momento.
  if (paymentMethod !== 'cash' && !req.file) {
    return res.status(400).json({ error: 'Falta la captura del pago.' });
  }

  // EL PRECIO Y EL NOMBRE SE TOMAN DEL CATÁLOGO, NO DE LO QUE MANDÓ EL NAVEGADOR.
  //
  // Antes era `price: Number(item?.price) || 0` — el precio venía del cliente y nadie lo
  // contrastaba. Eso permitía dos abusos con una petición hecha a mano:
  //   1. Declarar un precio de 0,01 y llevarse mercancía real: el comprobante, el descuento de
  //      stock y la factura que va a PLADE quedaban todos con ese precio inventado.
  //   2. Al revés, declarar una compra enorme para que `recordPurchase` escriba ese monto en
  //      `purchases` y saltar a nivel DIAMANTE — 20% de descuento permanente sin pagar nada.
  //      (Se limita solo porque anular el pedido después lo saca del cálculo, ver migración 004.)
  //
  // La tienda muestra `product.price` sin modificar —el descuento de fidelidad se aplica al total,
  // no al artículo— así que el precio del catálogo es exactamente el que vio el comprador.
  const catalogoPorId = new Map(loadProducts().map((p) => [p.id, p]));
  const desconocidos = [];
  const normalizedItems = items.map((item) => {
    const id = String(item?.id ?? '').trim() || '—';
    const delCatalogo = catalogoPorId.get(id);
    if (!delCatalogo) desconocidos.push(id);
    return {
      id,
      title: delCatalogo ? delCatalogo.title : String(item?.title ?? '').trim() || 'Producto',
      // Tope absoluto de cordura: la cantidad no tenía techo y se podía pedir un millón de
      // unidades para dejar el stock en negativo. 10.000 no estorba a una compra al mayor real.
      quantity: Math.min(10000, Math.max(1, Math.trunc(Number(item?.quantity) || 1))),
      price: delCatalogo ? Number(delCatalogo.price) || 0 : 0,
    };
  });

  if (catalogoPorId.size === 0) {
    console.error(`Pedido rechazado: el catálogo está vacío, no se pueden validar precios.`);
    return res.status(503).json({ error: 'El catálogo no está disponible en este momento. Intenta de nuevo en unos minutos.' });
  }
  if (desconocidos.length > 0) {
    console.error(`Pedido rechazado: productos que no están en el catálogo: ${desconocidos.join(', ')}`);
    return res.status(400).json({ error: 'Alguno de los productos ya no está disponible. Vuelve a armar tu carrito.' });
  }

  // --- Stock: el pedido NO puede salir si no hay mercancía ---
  //
  // La tienda ya deshabilita el botón de un producto agotado, pero eso no alcanza y no es la
  // protección: el carrito vive en el navegador y NO se revalida. Alguien agrega algo con stock,
  // vuelve una semana después y paga — para entonces puede estar en cero. También se podía subir la
  // cantidad con el botón "+" por encima de lo disponible.
  //
  // Importa más de lo que parece porque el checkout **crea una factura real en PLADE**
  // (submitOrderToPlade): un pedido sin mercancía ensucia la contabilidad del negocio y hay que
  // anularlo a mano allá.
  //
  // Se compara contra el stock EFECTIVO (catálogo menos lo ya comprometido por pedidos que PLADE
  // todavía no procesó), que es exactamente el número que vio el comprador. Si se mirara el stock
  // crudo, dos personas podrían llevarse la misma última unidad.
  //
  // `stock === null` significa "PLADE no lleva la cuenta de este producto", no "agotado": esos se
  // dejan pasar como siempre.
  const ajustesStock = loadStockAdjustments();
  const agotados = [];
  const insuficientes = [];
  const proximamente = [];
  for (const item of normalizedItems) {
    const delCatalogo = catalogoPorId.get(item.id);
    if (!delCatalogo) continue;
    // Sin conteo en PLADE, o sin precio: no se vende. Se reportan aparte de los agotados porque no
    // es lo mismo "se acabó" que "todavía no está a la venta".
    if (delCatalogo.stock === null || delCatalogo.stock === undefined) {
      proximamente.push({ id: item.id, title: item.title });
      continue;
    }
    if (!delCatalogo.price || Number(delCatalogo.price) <= 0) {
      proximamente.push({ id: item.id, title: item.title });
      continue;
    }
    const disponible = unidadesComprables(applyPendingStock(Number(delCatalogo.stock) || 0, item.id, ajustesStock));
    if (disponible <= 0) {
      agotados.push({ id: item.id, title: item.title });
    } else if (item.quantity > disponible) {
      insuficientes.push({ id: item.id, title: item.title, pedido: item.quantity, disponible });
    }
  }

  if (agotados.length > 0 || insuficientes.length > 0 || proximamente.length > 0) {
    console.error(
      `Pedido rechazado por stock. Agotados: ${agotados.map((x) => x.id).join(', ') || 'ninguno'}. ` +
        `Insuficientes: ${insuficientes.map((x) => `${x.id} (pide ${x.pedido}, hay ${x.disponible})`).join(', ') || 'ninguno'}. ` +
        `Todavía no a la venta: ${proximamente.map((x) => x.id).join(', ') || 'ninguno'}.`
    );
    // 409: el pedido está bien formado, pero el mundo cambió desde que se armó el carrito.
    let mensaje;
    if (agotados.length > 0) {
      mensaje = `Se agotó ${agotados.length === 1 ? 'un producto de tu carrito' : 'más de un producto de tu carrito'} mientras comprabas.`;
    } else if (proximamente.length > 0) {
      mensaje = `${proximamente.length === 1 ? 'Un producto de tu carrito' : 'Algunos productos de tu carrito'} todavía no está${proximamente.length === 1 ? '' : 'n'} a la venta.`;
    } else {
      mensaje = 'No queda suficiente cantidad de algún producto de tu carrito.';
    }
    return res.status(409).json({
      error: mensaje,
      // El detalle permite que la tienda diga QUÉ pasó con cada producto en vez de un error vago.
      agotados: agotados.concat(proximamente),
      insuficientes,
    });
  }
  const merchandiseSubtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const round2 = (n) => Math.round(n * 100) / 100;

  // El total SIEMPRE se calcula acá, con los precios del catálogo. Antes arrancaba en el `total`
  // que mandaba el navegador y solo se recalculaba si el comprador tenía sesión iniciada: un
  // invitado podía declarar el total que quisiera. Ahora el número del cliente ya no entra en
  // ningún cálculo — se sigue exigiendo en el cuerpo solo para no romper el contrato de la API.
  //
  // El descuento de fidelidad se resuelve contra Supabase con la service_role key, nunca con un
  // porcentaje mandado por el navegador. Si Supabase no está configurado o la consulta falla, el
  // pedido sale sin descuento en vez de romper el checkout.
  let finalTotal = round2(merchandiseSubtotal + deliveryFee);
  let discountApplied = null;
  let loyaltyResolved = false;
  if (userId && isLoyaltyConfigured()) {
    try {
      const loyalty = await getLoyaltyForUser(userId);
      const discountAmount = round2(merchandiseSubtotal * (loyalty.discountPercent / 100));
      finalTotal = round2(merchandiseSubtotal - discountAmount + deliveryFee);
      if (loyalty.discountPercent > 0) {
        discountApplied = { tier: loyalty.tier, percent: loyalty.discountPercent, amount: discountAmount };
      }
      loyaltyResolved = true;
    } catch (err) {
      console.error(`No se pudo calcular el nivel de fidelidad para ${userId}:`, err.message);
    }
  }

  const createdAt = new Date().toISOString();
  const orderId = crypto.randomBytes(16).toString('hex');

  let proofUrl = null;
  if (req.file) {
    // Se mira lo que el archivo ES, no lo que dice ser. Antes la extensión se elegía a partir de
    // `req.file.mimetype` —el Content-Type que declara el navegador, que se falsifica con un clic—
    // y los bytes no se revisaban nunca. O sea que este endpoint, que es PÚBLICO y no pide sesión,
    // aceptaba cualquier archivo con solo decir que era una imagen, y después lo servía desde el
    // dominio del backend. Las fotos de producto del panel ya se validaban así desde el principio;
    // la captura de pago se había quedado atrás, justo la que más lo necesita por ser abierta.
    const tipo = productImages.detectImageType(req.file.buffer);
    if (!tipo) {
      return res.status(400).json({ error: 'La captura del pago no es una imagen válida (solo JPG, PNG o WebP).' });
    }
    fs.writeFileSync(path.join(ORDERS_PAYMENT_PROOFS_DIR, `${orderId}.${tipo.ext}`), req.file.buffer);
    proofUrl = `/api/orders/${orderId}/proof`;
  }

  let pdfUrl = null;
  try {
    const pdfBuffer = await generateOrderPdfBuffer({
      orderId,
      createdAt,
      country,
      nombre,
      idType,
      cedula,
      telefono,
      correo,
      estado,
      ciudad,
      parroquia,
      address,
      deliveryMethod,
      pickupStore,
      courier,
      destinationCountry,
      paymentMethod,
      reference,
      paymentHolderName,
      deliveryZone,
      deliveryFee,
      items: normalizedItems,
      total: finalTotal,
      bcvRate,
      trmRate,
      discountApplied,
    });
    fs.writeFileSync(path.join(ORDERS_PDF_DIR, `${orderId}.pdf`), pdfBuffer);
    pdfUrl = `/api/orders/${orderId}/pdf`;
  } catch (err) {
    console.error('No se pudo generar el PDF del pedido:', err.message);
  }

  // Solo tiene sentido si hay captura de pago adjunta (efectivo no genera este segundo PDF).
  let receiptUrl = null;
  if (req.file) {
    try {
      const receiptBuffer = await generateReceiptWithProofPdfBuffer(
        {
          orderId,
          createdAt,
          country,
          nombre,
          idType,
          cedula,
          telefono,
          correo,
          estado,
          ciudad,
          parroquia,
          address,
          deliveryMethod,
          pickupStore,
          courier,
          destinationCountry,
          paymentMethod,
          reference,
          paymentHolderName,
          deliveryZone,
          deliveryFee,
          items: normalizedItems,
          total: finalTotal,
          bcvRate,
          trmRate,
          discountApplied,
        },
        req.file.buffer
      );
      fs.writeFileSync(path.join(ORDERS_RECEIPTS_DIR, `${orderId}.pdf`), receiptBuffer);
      receiptUrl = `/api/orders/${orderId}/receipt`;
    } catch (err) {
      console.error('No se pudo generar el comprobante con la captura de pago:', err.message);
    }
  }

  const orders = loadOrdersLocation();
  orders.push({
    orderId,
    estado,
    ciudad,
    parroquia,
    deliveryMethod,
    paymentMethod,
    reference,
    paymentHolderName,
    pdfUrl,
    proofUrl,
    receiptUrl,
    // Se guarda acá (no en Supabase) para poder ofrecer "Repetir compra" desde el historial sin
    // depender de una migración de esquema — mismo esquema de acceso que /pdf, /proof, /receipt
    // más abajo (el orderId al azar ES el token, ver GET /api/orders/:orderId/items).
    items: normalizedItems,
    // nombre/telefono/total no hacían falta acá hasta ahora (ya vivían en el PDF y en
    // customers.json) — se agregan para mostrarlos en la pantalla de escaneo de salidas
    // (POST /api/admin/scan) sin tener que cruzar con otro archivo.
    nombre,
    telefono,
    // Se agregan 2026-08-09 para que la ficha del pedido en el panel nuevo muestre al cliente
    // completo sin cruzar con customers.json. Los pedidos anteriores no los tienen: la pantalla
    // simplemente omite esas filas.
    cedula: `${idType}-${cedula}`,
    correo,
    total: finalTotal,
    dispatchedAt: null,
    dispatchedBy: null,
    createdAt,
  });
  saveOrdersLocation(orders);
  // El panel se entera de la venta en el instante en que el cliente termina de comprar, sin esperar
  // a que el navegador vuelva a preguntar. Va después de guardar para que la foto que se emite ya
  // incluya este pedido.
  broadcastContador();
  // El recibo sale en la tienda en cuanto el cliente termina de pagar. Va DESPUÉS de guardar el
  // pedido —nunca antes— para que no pueda existir un papel impreso de una venta que no quedó
  // registrada. `encolarImpresion` no lanza: si la impresión falla, la venta sigue en pie y el
  // recibo se puede sacar después desde el panel.
  encolarImpresion(orderId, 'pedido');
  // Y el aviso al celular, por el mismo motivo y con la misma regla: nunca lanza, así que un fallo
  // acá no puede tumbar una venta ya cobrada. Se le pasa el pedido recién guardado.
  notificarCompra(orders[orders.length - 1]);
  // Se descuenta para todo pedido que se completa (invitado o no, cualquier método de pago) —
  // mismo momento en el que ya se crea la factura real en PLADE más abajo. Si el dueño anula el
  // pedido después, se repone en POST /admin/purchases/:id (solo pedidos con userId llegan ahí).
  adjustStock(normalizedItems, -1);

  const customers = loadCustomers();
  const key = `${idType}-${cedula}`;
  const existing = customers[key];
  customers[key] = {
    idType,
    cedula,
    nombre,
    telefono,
    correo,
    firstSeen: existing?.firstSeen ?? createdAt,
    lastSeen: createdAt,
    orderCount: (existing?.orderCount ?? 0) + 1,
  };
  saveCustomers(customers);

  if (userId && loyaltyResolved) {
    // Best-effort: no bloquea la respuesta del checkout si falla, mismo espíritu que
    // submitOrderToPlade() más abajo. amount_usd = subtotal de mercancía ANTES del descuento y sin
    // el fee de delivery (ver supabase/002_purchases.sql).
    recordPurchase({ userId, orderId, amountUsd: merchandiseSubtotal, country, paymentMethod }).catch((err) => {
      console.error(`No se pudo registrar la compra ${orderId} para el nivel de fidelidad:`, err.message);
    });
  }

  const zoneNote = deliveryMethod === 'homeDelivery' && deliveryZone ? ` | Zona delivery: ${DELIVERY_ZONE_LABELS[deliveryZone] || deliveryZone} (+$${deliveryFee})` : '';
  const nota = `${nombre} | ${idType}-${cedula} | Tel: ${telefono} | Correo: ${correo} | ${estado}, ${ciudad}, ${parroquia} | ${address} | Entrega: ${deliveryMethod} | Pago: ${paymentMethod}${zoneNote}`;
  // A propósito sigue mandando el precio completo de cada ítem, sin el descuento de fidelidad
  // (decisión del dueño: no se toca la integración con PLADE en este paso — ver HANDOFF/plan).
  submitOrderToPlade({ orderId, nota, items: normalizedItems, country }).catch((err) => {
    console.error(`Error enviando pedido ${orderId} a PLADE:`, err.message);
  });

  res.status(201).json({ ok: true, orderId, pdfUrl, proofUrl, receiptUrl, discountApplied });
  });
});

// El nombre de archivo es el propio orderId (32 hex chars al azar, no adivinable ni enumerable),
// así que sirve como token de acceso: no requiere ADMIN_PASSWORD, igual que un link de
// confirmación de pedido en cualquier tienda online.
app.get('/api/orders/:orderId/pdf', (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.orderId)) {
    return res.status(400).json({ error: 'ID de pedido inválido.' });
  }
  const filePath = path.join(ORDERS_PDF_DIR, `${req.params.orderId}.pdf`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Pedido no encontrado.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="pedido-${req.params.orderId.slice(0, 8)}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

// Misma lógica de acceso que el PDF de arriba (orderId al azar como token). La extensión real no
// va en la URL (el cliente no la elige) — se prueba cada una hasta encontrar el archivo guardado.
const PROOF_CONTENT_TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
app.get('/api/orders/:orderId/proof', (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.orderId)) {
    return res.status(400).json({ error: 'ID de pedido inválido.' });
  }
  const ext = Object.keys(PROOF_CONTENT_TYPES).find((e) =>
    fs.existsSync(path.join(ORDERS_PAYMENT_PROOFS_DIR, `${req.params.orderId}${e}`))
  );
  if (!ext) {
    return res.status(404).json({ error: 'Captura de pago no encontrada.' });
  }
  const filePath = path.join(ORDERS_PAYMENT_PROOFS_DIR, `${req.params.orderId}${ext}`);
  res.setHeader('Content-Type', PROOF_CONTENT_TYPES[ext]);
  fs.createReadStream(filePath).pipe(res);
});

// Comprobante "para pantalla" (tamaño carta, con la captura del pago incrustada) — distinto del
// /pdf de arriba (ese es el térmico angosto, sin fotos, el que se imprime en tienda). Mismo
// esquema de acceso (orderId al azar como token).
app.get('/api/orders/:orderId/receipt', (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.orderId)) {
    return res.status(400).json({ error: 'ID de pedido inválido.' });
  }
  const filePath = path.join(ORDERS_RECEIPTS_DIR, `${req.params.orderId}.pdf`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Comprobante no encontrado.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="comprobante-${req.params.orderId.slice(0, 8)}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
});

// Productos comprados en un pedido puntual — usado por "Repetir compra" en el historial de
// tienda_web. Mismo esquema de acceso que /pdf, /proof, /receipt (el orderId al azar es el token).
// Pedidos de antes de que se guardara `items` (ver arriba) devuelven items: [] — el frontend no
// muestra el botón de repetir compra en ese caso.
app.get('/api/orders/:orderId/items', (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.orderId)) {
    return res.status(400).json({ error: 'ID de pedido inválido.' });
  }
  const order = loadOrdersLocation().find((o) => o.orderId === req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Pedido no encontrado.' });
  }
  res.json({ items: order.items || [] });
});

// Reportes crudos para el dueño (sin UI todavía) — protegidos con ADMIN_PASSWORD por venir con datos
// de clientes. Se usan por POST (no query string) para no dejar la contraseña en logs del servidor.
app.post('/admin/orders-stats', (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  const orders = loadOrdersLocation();
  const porEstado = {};
  const porDia = {};
  for (const o of orders) {
    porEstado[o.estado] = (porEstado[o.estado] || 0) + 1;
    const day = o.createdAt.slice(0, 10);
    porDia[day] = porDia[day] || {};
    porDia[day][o.estado] = (porDia[day][o.estado] || 0) + 1;
  }

  res.json({ total: orders.length, porEstado, porDia, orders });
});

app.post('/admin/customers', (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  const customers = loadCustomers();
  res.json({ total: Object.keys(customers).length, customers: Object.values(customers) });
});

// Panel para anular una compra que nunca se pagó de verdad (referencia falsa, "efectivo" que
// nunca se cobró) — sin esto, ese pedido seguiría contando para el nivel de fidelidad del
// cliente para siempre. El order_id de cada fila coincide con el PDF del pedido
// (/api/orders/:orderId/pdf), así se puede identificar de quién es sin guardar más datos acá.
app.get('/admin/purchases', async (req, res) => {
  let purchases = [];
  let loadError = null;
  if (isLoyaltyConfigured()) {
    try {
      purchases = await listPurchases();
    } catch (err) {
      loadError = err.message;
    }
  }

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Compras (nivel de fidelidad)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 16px; color: #222; }
    h1 { font-size: 1.4rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.85rem; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
    .cancelled { color: #b91c1c; }
    .confirmed { color: #15803d; }
    a.link-btn { display: inline-block; margin-top: 16px; color: #4f46e5; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Compras registradas (nivel de fidelidad)</h1>
  ${!isLoyaltyConfigured() ? '<p>Supabase no está configurado (faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).</p>' : ''}
  ${loadError ? `<p style="color:#b91c1c">Error cargando compras: ${escapeHtml(loadError)}</p>` : ''}
  ${purchases.length ? `
  <table>
    <tr><th>Fecha</th><th>Pedido</th><th>Monto</th><th>País</th><th>Estado</th><th></th></tr>
    ${purchases.map((p) => `
    <tr>
      <td>${new Date(p.created_at).toLocaleString('es-VE')}</td>
      <td><a href="/api/orders/${encodeURIComponent(p.order_id)}/pdf" target="_blank">${escapeHtml(p.order_id.slice(0, 12))}…</a></td>
      <td>${formatUsd(Number(p.amount_usd))}</td>
      <td>${escapeHtml(p.country)}</td>
      <td class="${p.status}">${p.status === 'confirmed' ? 'Confirmada' : 'Anulada'}</td>
      <td><a href="/admin/purchases/${encodeURIComponent(p.id)}">Ver / cambiar</a></td>
    </tr>`).join('')}
  </table>
  ` : (isLoyaltyConfigured() && !loadError ? '<p>Todavía no hay compras registradas.</p>' : '')}
</body>
</html>`);
});

app.get('/admin/purchases/:id', async (req, res) => {
  if (!isLoyaltyConfigured()) {
    return res.status(400).send('Supabase no está configurado. <a href="/admin/purchases">Volver</a>');
  }
  let purchase;
  try {
    purchase = await getPurchase(req.params.id);
  } catch (err) {
    return res.status(500).send(`Error: ${escapeHtml(err.message)}. <a href="/admin/purchases">Volver</a>`);
  }
  if (!purchase) {
    return res.status(404).send('Compra no encontrada. <a href="/admin/purchases">Volver</a>');
  }

  const isConfirmed = purchase.status === 'confirmed';
  const nextStatus = isConfirmed ? 'cancelled' : 'confirmed';
  const actionLabel = isConfirmed ? 'Anular esta compra' : 'Restaurar esta compra';

  res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Compra ${escapeHtml(purchase.order_id.slice(0, 12))}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
    label { display: block; margin-top: 12px; font-weight: 600; }
    input[type=password] { display: block; margin-top: 4px; padding: 8px; width: 100%; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 20px; background: #b91c1c; color: white; border: none; border-radius: 6px; cursor: pointer; }
    dl { margin-top: 16px; }
    dt { font-weight: 600; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Compra ${escapeHtml(purchase.order_id.slice(0, 12))}…</h1>
  <dl>
    <dt>Fecha</dt><dd>${new Date(purchase.created_at).toLocaleString('es-VE')}</dd>
    <dt>Pedido (PDF)</dt><dd><a href="/api/orders/${encodeURIComponent(purchase.order_id)}/pdf" target="_blank">Ver factura del cliente &rarr;</a></dd>
    <dt>Monto</dt><dd>${formatUsd(Number(purchase.amount_usd))}</dd>
    <dt>País</dt><dd>${escapeHtml(purchase.country)}</dd>
    <dt>Estado actual</dt><dd>${isConfirmed ? 'Confirmada (cuenta para el nivel del cliente)' : 'Anulada (no cuenta para el nivel)'}</dd>
  </dl>
  <form method="post" action="/admin/purchases/${encodeURIComponent(purchase.id)}">
    <input type="hidden" name="status" value="${nextStatus}">
    <label>Contraseña de administración</label>
    <input type="password" name="password" required>
    <button type="submit">${actionLabel}</button>
  </form>
  <p><a href="/admin/purchases">&larr; Volver</a></p>
</body>
</html>`);
});

app.post('/admin/purchases/:id', async (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin/purchases">Volver</a>');
  }
  const status = req.body?.status === 'confirmed' ? 'confirmed' : 'cancelled';
  try {
    const purchase = await getPurchase(req.params.id);
    await setPurchaseStatus(req.params.id, status);
    // Anular repone el stock que se había descontado; restaurar una compra anulada lo vuelve a
    // descontar. Solo si el estado realmente cambia (evita reponer/descontar dos veces si alguien
    // reenvía el formulario con el mismo estado que ya tenía).
    if (purchase && purchase.status !== status) {
      const order = loadOrdersLocation().find((o) => o.orderId === purchase.order_id);
      if (order?.items?.length) {
        adjustStock(order.items, status === 'cancelled' ? 1 : -1);
      }
    }
    res.redirect('/admin/purchases');
  } catch (err) {
    res.status(500).send(`Error actualizando la compra: ${escapeHtml(err.message)}. <a href="/admin/purchases">Volver</a>`);
  }
});

// Disparo manual desde el panel de admin (contraseña de siempre) del envío de recordatorios de
// carrito abandonado. Ver email-reminders.js.
app.post('/admin/send-cart-reminders', async (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).send('Contraseña incorrecta. <a href="/admin">Volver</a>');
  }
  if (!isCartReminderConfigured()) {
    return res.status(400).send('Recordatorio de carrito no configurado (faltan RESEND_API_KEY/CART_REMINDER_FROM_EMAIL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY). <a href="/admin">Volver</a>');
  }
  try {
    const result = await sendAbandonedCartReminders();
    res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Recordatorios enviados</title>
  <style>body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }</style>
</head>
<body>
  <h1>Recordatorios de carrito abandonado</h1>
  <p>Enviados: <b>${result.sent}</b><br>Sin email válido (omitidos): <b>${result.skipped}</b><br>Con error: <b>${result.failed}</b></p>
  <p><a href="/admin">&larr; Volver</a></p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`Error: ${escapeHtml(err.message)}. <a href="/admin">Volver</a>`);
  }
});

// Mismo envío que arriba, pero pensado para que lo dispare un cron externo (cron-job.org u otro)
// una vez al día: GET simple con el secreto en la query string, protegido con CRON_SECRET en vez
// de ADMIN_PASSWORD (ese secreto va a vivir guardado en la config de un servicio de terceros).
app.get('/cron/cart-reminders', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  if (!isCartReminderConfigured()) {
    return res.status(400).json({ error: 'Recordatorio de carrito no configurado.' });
  }
  try {
    const result = await sendAbandonedCartReminders();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const MAX_REVIEW_COMMENT_LENGTH = 120;

app.get('/api/products/:id/reviews', (req, res) => {
  const reviews = loadReviews();
  res.json(reviews[req.params.id] || []);
});

// Reseñas positivas recientes de todo el catálogo (no de un solo producto) — para mostrar
// testimonios reales en el catálogo en vez de contenido inventado. Solo reseñas con comentario
// (una calificación sin texto no sirve como testimonio) y, por defecto, 4-5 estrellas.
app.get('/api/reviews/recent', (req, res) => {
  const reviews = loadReviews();
  const products = loadProducts();
  const titleById = new Map(products.map((p) => [p.id, p.title]));
  const minRating = Math.min(5, Math.max(1, Math.trunc(Number(req.query.minRating)) || 4));
  const limit = Math.min(20, Math.max(1, Math.trunc(Number(req.query.limit)) || 6));

  const flattened = Object.entries(reviews)
    .flatMap(([productId, list]) => list.map((r) => ({ ...r, productId, productTitle: titleById.get(productId) || null })))
    .filter((r) => r.rating >= minRating && r.comment)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);

  res.json(flattened);
});

app.post('/api/products/:id/reviews', (req, res) => {
  const products = loadProducts();
  const product = products.find((p) => p.id === req.params.id);
  if (!product) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  if (isReviewRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Demasiadas reseñas enviadas. Intenta de nuevo más tarde.' });
  }

  const rating = Math.trunc(Number(req.body?.rating));
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'La calificación debe ser un número entero de 1 a 5.' });
  }
  if (comment.length > MAX_REVIEW_COMMENT_LENGTH) {
    return res.status(400).json({ error: `El comentario no puede superar los ${MAX_REVIEW_COMMENT_LENGTH} caracteres.` });
  }

  const reviews = loadReviews();
  if (!reviews[product.id]) reviews[product.id] = [];
  reviews[product.id].push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rating,
    comment,
    createdAt: new Date().toISOString(),
  });
  saveReviews(reviews);

  res.status(201).json({ ...ratingSummary(reviews[product.id]), reviews: reviews[product.id] });
});

// Moderación: borrar una reseña puntual (spam, prueba, contenido inapropiado).
app.delete('/api/products/:id/reviews/:reviewId', (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  const reviews = loadReviews();
  const productReviews = reviews[req.params.id];
  if (!productReviews) {
    return res.status(404).json({ error: 'Producto sin reseñas.' });
  }

  const nextReviews = productReviews.filter((r) => r.id !== req.params.reviewId);
  if (nextReviews.length === productReviews.length) {
    return res.status(404).json({ error: 'Reseña no encontrada.' });
  }

  reviews[req.params.id] = nextReviews;
  saveReviews(reviews);
  res.json({ ...ratingSummary(nextReviews), reviews: nextReviews });
});

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Falta el campo "message".' });
  }

  if (isChatRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Demasiados mensajes. Intenta de nuevo más tarde.' });
  }

  try {
    // soloCategoriasActivas: si no, el asistente recomendaría con entusiasmo productos que el
    // cliente después no puede ni abrir.
    const products = soloCategoriasActivas(getMergedProducts());
    const reply = await getChatReply(message, Array.isArray(history) ? history : [], products);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'No se pudo generar una respuesta en este momento.' });
  }
});

app.get('/api/bcv', (req, res) => {
  if (!bcvRateCache) {
    return res.status(503).json({ error: 'Todavía no se ha consultado la tasa BCV en esta sesión del servidor.' });
  }
  if (bcvRateCache.error) {
    return res.status(502).json({ error: bcvRateCache.error });
  }
  res.json({ rate: bcvRateCache.rate });
});

app.get('/api/trm', (req, res) => {
  if (!trmRateCache) {
    return res.status(503).json({ error: 'Todavía no se ha consultado la TRM en esta sesión del servidor.' });
  }
  if (trmRateCache.error) {
    return res.status(502).json({ error: trmRateCache.error });
  }
  res.json({ rate: trmRateCache.rate });
});

/**
 * Qué versión está corriendo de verdad.
 *
 * Hizo falta el 2026-09-02: `npx vercel` y el push a Render dicen que salió bien y no hay forma de
 * comprobar desde fuera si el proceso que responde es el del commit que acabás de subir. Sin esto
 * la única salida era adivinar por el comportamiento, y cuando el cambio vive detrás del login del
 * panel no hay comportamiento que mirar.
 *
 * `RENDER_GIT_COMMIT` la pone Render sola en el Environment. Fuera de Render se lee de `.git`, y si
 * tampoco está queda `null`: es un dato de diagnóstico, no una razón para que el health falle.
 *
 * Se calcula UNA vez al arrancar. Leer el disco en cada llamada sería trabajo repetido para un dato
 * que no puede cambiar sin reiniciar el proceso.
 */
function commitEnEjecucion() {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT.slice(0, 7);
  try {
    // Sin child_process: leer los dos archivos es más barato y no depende de que git esté instalado.
    const cabeza = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    if (!cabeza.startsWith('ref: ')) return cabeza.slice(0, 7); // HEAD suelto (detached)
    const ref = cabeza.slice(5).trim();
    const suelto = path.join(__dirname, '.git', ref);
    if (fs.existsSync(suelto)) return fs.readFileSync(suelto, 'utf8').trim().slice(0, 7);
    // Si la rama está empaquetada, su SHA vive en packed-refs y no como archivo propio.
    const empaquetadas = fs.readFileSync(path.join(__dirname, '.git', 'packed-refs'), 'utf8');
    const linea = empaquetadas.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    return linea ? linea.split(' ')[0].slice(0, 7) : null;
  } catch {
    return null;
  }
}

const COMMIT = commitEnEjecucion();
const ARRANCADO = new Date().toISOString();

/**
 * Qué migraciones opcionales ve la base, comprobado UNA vez al arrancar.
 *
 * El dueño corre las migraciones a mano, y hasta ahora la única forma de saber si una se corrió era
 * entrar al panel e intentar la acción. Con esto se ve desde fuera y sin credenciales — igual que el
 * commit. Cuesta una consulta al arrancar y cero por petición.
 *
 * `null` significa "no sé" (Supabase sin configurar), que no es lo mismo que "falta".
 */
let COLUMNAS_EN_BASE = null;
adminUsers
  .columnasDisponibles()
  .then((c) => {
    COLUMNAS_EN_BASE = c;
    if (c) {
      const faltan = Object.entries(c).filter(([, existe]) => !existe).map(([k]) => k);
      console.log(faltan.length === 0
        ? 'Esquema de admin_users al día.'
        : `OJO: faltan migraciones en admin_users -> ${faltan.join(', ')}`);
    }
  })
  .catch((err) => console.error('No se pudo comprobar el esquema de admin_users:', err.message));

// El SHA de un repositorio privado no abre ninguna puerta: no dice qué hay dentro y no sirve para
// autenticarse. A cambio ahorra la adivinanza en cada despliegue.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  commit: COMMIT,
  arrancado: ARRANCADO,
  // Segundos en pie. Un número chico justo después de un push es la señal de que el deploy entró.
  segundosEnPie: Math.round(process.uptime()),
  // Qué columnas opcionales ve la base. Sirve para saber si una migración se corrió sin tener que
  // entrar al panel. Son nombres de columna, no datos de nadie.
  esquema: COLUMNAS_EN_BASE,
  // Qué piezas opcionales están configuradas. Son BOOLEANOS, nunca los valores: sirve para
  // responder "¿ya puse esa variable en Render?" sin credenciales y sin exponer ningún secreto.
  configurado: {
    push: PUSH_CONFIGURADO,
    impresion: Boolean(PRINT_AGENT_TOKEN),
    plade: isPladeConfigured(),
  },
  // Cuántos aparatos tienen los avisos activados. Es un NÚMERO, no la lista: no dice de quién son
  // ni permite alcanzarlos. Responde la pregunta que si no queda sin respuesta: "¿por qué no me
  // llegó el aviso?" — si acá hay un cero, no le llegó a nadie porque no hay a quién mandarlo.
  aparatosConAvisos: (() => {
    try {
      const s = pushSubsStore.load();
      return Array.isArray(s) ? s.length : 0;
    } catch {
      return null;
    }
  })(),
}));

// ===========================================================================================
// SEDES DE LAS QUE SE TOMA EL INVENTARIO
// ===========================================================================================
//
// PLADE guarda la existencia por sucursal, y `getInventario` acepta `id_sucursal` para filtrar
// —campo NO documentado en su manual, descubierto probando el 2026-09-02—. Pero **solo admite una
// sede por consulta**: `1,5`, `1;5` y `id_sucursal[]` dan error, y `1|5` o la clave repetida se
// quedan con una sola sin avisar. Así que sumar varias es cosa nuestra: una consulta por sede.
//
// Que esto se configure desde el panel y no por variable de entorno es a propósito: el negocio
// abre y cierra sedes, y eso no debería exigir un despliegue.

/** Las sedes del negocio, para que el panel las muestre por nombre y no como números sueltos. */
const SUCURSALES_CONOCIDAS = [
  { id: 11, nombre: 'SEDE NUEVA 2026', direccion: 'Casa Prebo (con piscina)', tipo: 'ALMACÉN' },
  { id: 10, nombre: 'CASA PABLO', direccion: 'Casa Naguanagua (próximamente)', tipo: 'ALMACÉN' },
  { id: 9, nombre: 'ONLINE', direccion: 'Casa El Trigal', tipo: 'SUCURSAL' },
  { id: 7, nombre: 'NAGUANAGUA', direccion: 'CC Granja (02)', tipo: 'SUCURSAL' },
  { id: 5, nombre: 'AV BOLÍVAR', direccion: 'CC Salma, Av Bolívar Norte', tipo: 'SUCURSAL' },
  { id: 4, nombre: 'NAGUANAGUA (cerrada)', direccion: 'CC Granja (01)', tipo: 'SUCURSAL' },
  { id: 3, nombre: 'GUACARA (cerrada)', direccion: 'CC Guacara', tipo: 'SUCURSAL' },
  { id: 2, nombre: 'SAN DIEGO (cerrada)', direccion: 'CC Fin de Siglo', tipo: 'SUCURSAL' },
  { id: 1, nombre: 'DEPÓSITO GENERAL', direccion: 'Almacén principal', tipo: 'SUCURSAL' },
];

app.get('/api/admin/inventario/sedes', requireAdminRole('admin'), requierePermiso('sedes'), (req, res) => {
  res.json({
    seleccionadas: sucursalesDeInventario(),
    ocultas: sucursalesOcultas(),
    conocidas: SUCURSALES_CONOCIDAS,
    pladeConectado: isPladeConfigured(),
    ultimaSync: lastPladeSync,
  });
});

/**
 * Cuánto habría a la venta con una selección dada, SIN guardarla.
 *
 * Existe porque el número es lo único que hace tangible la decisión: pasar de todas las sedes a solo
 * Av Bolívar cuesta ~945 productos, y eso no se ve en una lista de casillas. Consulta PLADE en vivo,
 * así que tarda un segundo por sede.
 */
app.post('/api/admin/inventario/sedes/previsualizar', requireAdminRole('admin'), requierePermiso('sedes'), async (req, res) => {
  if (!isPladeConfigured()) return res.status(400).json({ error: 'PLADE no está configurado en el servidor.' });
  const ids = normalizarSucursales((req.body && req.body.sucursales) || []);
  try {
    const items = await getInventario(ids);
    const productos = items.map(mapPladeItemToProduct).filter((p) => p.id && p.title);
    // La MISMA regla que decide la banda azul/roja en la tienda (ver disponibilidad.ts y 2.32).
    let venta = 0, agotados = 0, proximamente = 0;
    for (const p of productos) {
      const u = unidadesComprables(p.stock);
      if (u !== null && u <= 0) agotados += 1;
      else if (u === null || !p.price || p.price <= 0) proximamente += 1;
      else venta += 1;
    }
    res.json({ sucursales: ids, total: productos.length, venta, agotados, proximamente });
  } catch (err) {
    res.status(502).json({ error: `PLADE no respondió: ${err.message}` });
  }
});

app.put('/api/admin/inventario/sedes', requireAdminRole('admin'), requierePermiso('sedes'), async (req, res) => {
  const ids = normalizarSucursales((req.body && req.body.sucursales) || []);

  // Se guarda YA normalizado: si alguien mandara "1|5" —que PLADE acepta quedándose con una sola
  // sede, sin error— queda descartado acá y no llega nunca al archivo.
  // Una sede que pasa a estar EN USO deja de estar oculta: no puede aportar stock desde la sombra.
  const ocultas = sucursalesOcultas().filter((id) => !ids.includes(id));
  inventoryConfigStore.save({ sucursales: ids, ocultas, actualizado: new Date().toISOString() });
  console.log(`Sedes de inventario: ${ids.length === 0 ? 'todas' : ids.join(' + ')}`);

  // Se resincroniza en el acto: sin esto el catálogo seguiría mostrando el stock viejo hasta ocho
  // minutos después, y el dueño creería que el cambio no funcionó.
  let sincronizado = null;
  let errorSync = null;
  if (isPladeConfigured()) {
    try {
      sincronizado = await syncProductsFromPlade();
    } catch (err) {
      // La configuración YA quedó guardada; lo que falló es traerla ahora. La próxima
      // sincronización automática lo intenta de nuevo. Se informa en vez de callarlo.
      errorSync = err.message;
    }
  }
  res.json({ seleccionadas: ids, sincronizado, errorSync });
});

/**
 * Ocultar sedes de la lista del panel.
 *
 * Endpoint aparte del de selección **a propósito**: esconder una sede no cambia el inventario, así
 * que no tiene por qué disparar una resincronización con PLADE (dos consultas de 2,4 MB) solo para
 * acortar una lista en pantalla.
 */
app.put('/api/admin/inventario/sedes/ocultas', requireAdminRole('admin'), requierePermiso('sedes'), (req, res) => {
  const enUso = sucursalesDeInventario();
  const pedidas = normalizarSucursales((req.body && req.body.ocultas) || []);
  const invalidas = pedidas.filter((id) => enUso.includes(id));
  if (invalidas.length > 0) {
    return res.status(400).json({
      error: `No se puede ocultar una sede que está en uso (${invalidas.join(', ')}). Desmarcala primero.`,
    });
  }
  const actual = inventoryConfigStore.load() || {};
  inventoryConfigStore.save({ ...actual, ocultas: pedidas, actualizado: new Date().toISOString() });
  res.json({ ocultas: pedidas });
});

// ===========================================================================================
// NOTIFICACIONES AL CELULAR (Web Push)
// ===========================================================================================
//
// Cuando entra una compra, además de imprimirse el recibo en la tienda, le llega un aviso al
// teléfono de quien tenga el panel instalado — **aunque la aplicación esté cerrada**. Eso es lo que
// distingue una notificación de verdad de un mensaje dentro de la página: no hace falta tener el
// panel abierto ni el navegador vivo.
//
// Cómo funciona, en corto: el navegador le pide a su propio servicio (Google, Apple, Mozilla) una
// "dirección de entrega" para ese aparato. Esa dirección se guarda acá. Para avisar, se le manda el
// mensaje a ese servicio firmado con la clave privada VAPID, y él lo entrega. **Nosotros nunca
// hablamos directo con el teléfono**, ni sabemos cuál es.
//
// En iOS solo funciona si el panel está INSTALADO en la pantalla de inicio (iOS 16.4 o superior).
// En Android y en escritorio funciona instalado o no.

const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
// El "subject" es un correo de contacto que exige el estándar: si nuestros envíos dieran problemas,
// es por donde el servicio de entrega avisaría.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:zdcompanyoficial@gmail.com';

const PUSH_CONFIGURADO = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_CONFIGURADO) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.log('Notificaciones desactivadas: faltan VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.');
}

function loadPushSubs() {
  const s = pushSubsStore.load();
  return Array.isArray(s) ? s : [];
}
function savePushSubs(subs) {
  pushSubsStore.save(subs);
}

/**
 * La clave pública, para que el navegador pueda suscribirse. **No es secreta**: viaja al cliente
 * por diseño. La privada no sale nunca de Render.
 */
app.get('/api/admin/push/clave', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  res.json({ configurado: PUSH_CONFIGURADO, clavePublica: PUSH_CONFIGURADO ? VAPID_PUBLIC : null });
});

/**
 * Guarda la "dirección de entrega" de un aparato.
 *
 * Se guarda junto a QUIÉN se suscribió, y no como una lista anónima, por dos motivos: para poder
 * mandarle a cada uno solo lo que le corresponde ver (el monto solo a quien tiene el permiso de
 * cifras), y para poder borrar las suyas si esa cuenta se desactiva.
 */
app.post('/api/admin/push/suscribir', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  if (!PUSH_CONFIGURADO) return res.status(503).json({ error: 'Las notificaciones no están configuradas en el servidor.' });

  const sub = req.body && req.body.suscripcion;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'La suscripción no tiene la forma esperada.' });
  }

  const subs = loadPushSubs();
  // El endpoint identifica al aparato. Si ya estaba, se actualiza en vez de duplicar: un mismo
  // teléfono que vuelve a activar las notificaciones no debe recibir dos avisos por cada venta.
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  const registro = {
    endpoint: sub.endpoint,
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
    usuario: req.adminUser.username || req.adminRole,
    sub: req.adminUser.sub || null,
    rol: req.adminRole,
    // Se guardan los permisos del momento de suscribirse solo como referencia; al enviar se
    // vuelven a resolver contra la cuenta, que puede haber cambiado.
    creado: i >= 0 ? subs[i].creado : new Date().toISOString(),
    actualizado: new Date().toISOString(),
    aparato: String((req.body && req.body.aparato) || '').slice(0, 80),
  };
  if (i >= 0) subs[i] = registro;
  else subs.push(registro);
  savePushSubs(subs);
  console.log(`Notificaciones activadas para ${registro.usuario} (${subs.length} aparatos en total)`);
  res.json({ ok: true, aparatos: subs.length });
});

app.post('/api/admin/push/desuscribir', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Falta el endpoint.' });
  const subs = loadPushSubs().filter((s) => s.endpoint !== endpoint);
  savePushSubs(subs);
  res.json({ ok: true, aparatos: subs.length });
});

/** Cuántos aparatos tiene esta cuenta con notificaciones activas. */
app.get('/api/admin/push/estado', requireAdminRole('admin', 'salidas', 'empleado'), (req, res) => {
  const mios = loadPushSubs().filter((s) => s.usuario === (req.adminUser.username || req.adminRole));
  res.json({
    configurado: PUSH_CONFIGURADO,
    misAparatos: mios.map((s) => ({ aparato: s.aparato, desde: s.creado })),
    totalAparatos: loadPushSubs().length,
  });
});

app.post('/api/admin/push/prueba', requireAdminRole('admin', 'salidas', 'empleado'), async (req, res) => {
  if (!PUSH_CONFIGURADO) return res.status(503).json({ error: 'Las notificaciones no están configuradas.' });
  const yo = req.adminUser.username || req.adminRole;
  const mios = loadPushSubs().filter((s) => s.usuario === yo);
  if (mios.length === 0) return res.status(400).json({ error: 'Esta cuenta no tiene ningún aparato con notificaciones activas.' });

  const enviados = await enviarATodos(mios, {
    titulo: 'Prueba de notificación',
    cuerpo: 'Si ves esto, las notificaciones funcionan.',
    url: '/admin',
    etiqueta: 'prueba',
  });
  res.json({ ok: true, enviados });
});

/**
 * Manda un aviso a una lista de aparatos y limpia los que ya no existen.
 *
 * **Un 404 o un 410 significa que esa suscripción murió** —se desinstaló la aplicación, se borraron
 * los datos del navegador, se cambió de teléfono— y hay que borrarla. Si no se limpiaran, la lista
 * crecería para siempre con direcciones muertas y cada venta gastaría envíos contra la nada.
 */
async function enviarATodos(destinos, aviso) {
  const carga = JSON.stringify(aviso);
  const muertas = [];
  let enviados = 0;

  await Promise.all(
    destinos.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, carga, { TTL: 3600 });
        enviados += 1;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) muertas.push(s.endpoint);
        else console.error(`Push falló para ${s.usuario}: ${err && err.message}`);
      }
    })
  );

  if (muertas.length > 0) {
    savePushSubs(loadPushSubs().filter((s) => !muertas.includes(s.endpoint)));
    console.log(`Se limpiaron ${muertas.length} suscripciones muertas.`);
  }
  return enviados;
}

/**
 * Avisa de una compra nueva a todo el que tenga notificaciones activas y permiso para ver pedidos.
 *
 * **Nunca lanza.** Se llama desde la creación del pedido, y un fallo acá no puede tumbar una venta
 * que el cliente ya pagó — igual que con la impresión.
 *
 * **El monto solo va a quien tiene el permiso de cifras** (`contador`). Una notificación se ve en la
 * pantalla bloqueada, sin desbloquear el teléfono: si a un empleado no se le muestran los montos en
 * el panel, no tiene sentido que se los muestre el aviso.
 */
function notificarCompra(pedido) {
  if (!PUSH_CONFIGURADO) return;
  try {
    const subs = loadPushSubs();
    if (subs.length === 0) return;

    const conMonto = [];
    const sinMonto = [];
    for (const s of subs) {
      const cuenta = { role: s.rol, permissions: null };
      if (!tienePermiso(cuenta, 'pedidos')) continue;
      (tienePermiso(cuenta, 'contador') ? conMonto : sinMonto).push(s);
    }

    const donde = [pedido.ciudad, pedido.estado].filter(Boolean).join(', ');
    const base = {
      url: `/admin/pedidos?buscar=${encodeURIComponent(pedido.orderId)}`,
      // La etiqueta agrupa: si entran tres ventas seguidas, no quedan tres avisos apilados sino el
      // último. Con `renotify` el teléfono vuelve a sonar igual.
      etiqueta: 'compra',
    };

    if (conMonto.length > 0) {
      enviarATodos(conMonto, {
        ...base,
        titulo: `Nueva compra · $${(Number(pedido.total) || 0).toFixed(2)}`,
        cuerpo: `${pedido.nombre || 'Cliente'}${donde ? ` — ${donde}` : ''}\nPedido ${pedido.orderId}`,
      }).catch((err) => console.error('No se pudo notificar la compra:', err.message));
    }
    if (sinMonto.length > 0) {
      enviarATodos(sinMonto, {
        ...base,
        titulo: 'Nueva compra',
        cuerpo: `Pedido ${pedido.orderId}${donde ? ` — ${donde}` : ''}`,
      }).catch((err) => console.error('No se pudo notificar la compra:', err.message));
    }
  } catch (err) {
    console.error('No se pudo notificar la compra:', err.message);
  }
}

// ===========================================================================================
// IMPRESIÓN EN LA TIENDA — cola + canal para el agente
// ===========================================================================================
//
// El problema de fondo: este servidor vive en Render, en internet, y la impresora vive en la tienda
// con una IP privada (192.168.x.x) que no existe fuera de ese local. **Desde acá no hay forma de
// alcanzarla.** La alternativa —abrir la impresora a internet con un redireccionamiento de puerto—
// sería un agujero de seguridad de primer orden: el puerto 9100 no pide autenticación de ninguna
// clase, así que cualquiera que lo encuentre puede lanzar trabajos o usar la impresora como puerta
// de entrada a la red del negocio.
//
// Por eso hay un **agente**: un programa que corre en una PC de la tienda y llama HACIA AFUERA. Se
// queda esperando en `/api/print/stream`, y cuando entra un pedido el servidor le avisa por ahí.
// Sin puertos abiertos, sin IP fija y sin tocar el router.
//
// El recorrido completo de un pedido:
//
//   cliente paga  ->  encolarImpresion()  ->  aviso por SSE  ->  el agente pide los bytes
//                                                                     |
//              se marca 'impreso'  <-  el agente reporta  <-  los manda a la impresora
//
// **La numeración de estados importa para no imprimir dos veces**, que es el fallo caro acá: un
// pedido reimpreso es un pedido que se despacha dos veces. Ver `PRINT_ESTADOS`.

// Un trabajo pasa por: pendiente -> imprimiendo -> impreso (o error).
//
// `imprimiendo` existe justamente para lo que puede salir mal: el agente pide los bytes, la PC se
// apaga a mitad, y nadie sabe si el papel salió o no. Ese trabajo NO se reintenta solo — se queda
// visible en el panel para que una persona decida, porque solo una persona puede mirar si el recibo
// está en la bandeja. Reintentar a ciegas es exactamente cómo se imprime dos veces.
const PRINT_ESTADOS = ['pendiente', 'imprimiendo', 'impreso', 'error'];

// Cuántos trabajos se conservan. Los viejos ya impresos no sirven para nada salvo ocupar disco; se
// podan por el extremo antiguo cada vez que se encola uno nuevo.
const PRINT_MAX_TRABAJOS = 500;

// El agente se identifica con su propio secreto, separado del ADMIN_PASSWORD. Si mañana hay que
// cambiar el del agente (se cambia la PC de la tienda, se va un empleado) no debe obligar a cambiar
// la contraseña del panel, ni al revés. Sin token configurado el canal queda cerrado del todo:
// preferible que la impresión no funcione a que cualquiera lea los pedidos del día.
const PRINT_AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN || '';

const PRINT_CONFIG_POR_DEFECTO = {
  activo: false,
  anchoPapel: 80,      // 80mm = 48 caracteres; 58mm = 32
  acentos: false,      // ver sinAcentos() en escpos-recibo.js
  cortar: true,
  copias: 1,
  // El QR del número de pedido. Encendido por defecto: la Xprinter XP-80C del local lo soporta y
  // sirve para escanear la salida sin teclear. Se apaga si la impresora no lo dibuja — el número
  // sale igual en texto grande justo arriba, así que apagarlo no deja el recibo inservible.
  qr: true,
  qrTamano: 6,
  modo: 'red',         // 'red' = TCP a IP:9100 | 'windows' = cola de impresión de la PC
  ip: '',
  puerto: 9100,
  nombreCola: '',
};

function loadPrintConfig() {
  return { ...PRINT_CONFIG_POR_DEFECTO, ...(printConfigStore.load() || {}) };
}
function savePrintConfig(config) {
  printConfigStore.save(config);
}
function loadPrintQueue() {
  const q = printQueueStore.load();
  return Array.isArray(q) ? q : [];
}
function savePrintQueue(q) {
  printQueueStore.save(q);
}

// --- Aviso en vivo al agente -------------------------------------------------------------------
// Mismo mecanismo que el contador de ventas del panel (ver /api/admin/counter/stream): una conexión
// abierta que el servidor usa para empujar. Se prefiere a que el agente pregunte cada X segundos
// porque el recibo tiene que salir MIENTRAS el cliente todavía está ahí, no un minuto después.
const agentesConectados = new Set();

function avisarAgentes(evento) {
  for (const res of agentesConectados) {
    try {
      res.write(`data: ${JSON.stringify(evento)}\n\n`);
    } catch {
      /* la limpieza la hace el manejador de 'close' */
    }
  }
}

/**
 * Mete un pedido en la cola de impresión.
 *
 * **Nunca lanza.** Se llama desde la creación del pedido, y un fallo acá no puede tumbar una venta
 * que el cliente ya pagó: si la impresión falla, el pedido igual queda registrado y se puede
 * reimprimir desde el panel. Es la regla de siempre — lo accesorio no rompe lo principal.
 */
function encolarImpresion(orderId, motivo = 'pedido') {
  try {
    const config = loadPrintConfig();
    // Con la impresión apagada no se acumulan trabajos: al prenderla, el dueño se encontraría con
    // una tanda de recibos viejos saliendo de golpe.
    if (!config.activo) return null;

    const cola = loadPrintQueue();
    const trabajo = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      orderId,
      motivo,                 // 'pedido' | 'reimpresion' | 'prueba'
      estado: 'pendiente',
      creado: new Date().toISOString(),
      entregadoEn: null,
      terminadoEn: null,
      error: null,
    };
    cola.push(trabajo);
    savePrintQueue(cola.slice(-PRINT_MAX_TRABAJOS));
    avisarAgentes({ tipo: 'trabajo', id: trabajo.id });
    return trabajo;
  } catch (err) {
    console.error('No se pudo encolar la impresión:', err.message);
    return null;
  }
}

// --- Autenticación del agente ------------------------------------------------------------------
function requireAgenteImpresion(req, res, next) {
  if (!PRINT_AGENT_TOKEN) {
    return res.status(503).json({ error: 'La impresión no está configurada en el servidor.' });
  }
  const cabecera = String(req.headers.authorization || '');
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : '';
  // Comparación de largo constante: con `!==` el tiempo de respuesta filtra cuántos caracteres del
  // token son correctos, y con eso se adivina de a uno. Es barato hacerlo bien.
  const a = Buffer.from(token);
  const b = Buffer.from(PRINT_AGENT_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  return next();
}

// Lo último que se supo del agente, para que el panel pueda decir "conectado" o "sin señal desde
// las 3:40". Vive en memoria a propósito: si Render reinicia, el agente se reconecta solo en
// segundos y el dato se rehace. Guardarlo en disco sería escribir en cada latido para nada.
let estadoAgente = { ultimaConexion: null, impresorasVistas: [], version: null };

// --- Endpoints del AGENTE ----------------------------------------------------------------------

// Canal abierto. El agente se queda escuchando acá y el servidor le empuja los avisos.
app.get('/api/print/stream', requireAgenteImpresion, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Sin esto el proxy de Render bufferea el stream y no llega nada hasta que se cierra.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  agentesConectados.add(res);
  estadoAgente.ultimaConexion = new Date().toISOString();

  // Por si quedó trabajo de cuando la PC estaba apagada: se avisa al conectar, sin esperar a que
  // entre un pedido nuevo.
  res.write(`data: ${JSON.stringify({ tipo: 'hola', pendientes: loadPrintQueue().filter((t) => t.estado === 'pendiente').length })}\n\n`);

  const latido = setInterval(() => {
    try {
      res.write(': ping\n\n');
      estadoAgente.ultimaConexion = new Date().toISOString();
    } catch {
      /* ver 'close' */
    }
  }, SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(latido);
    agentesConectados.delete(res);
  });
});

// Qué impresora usar. El agente lo relee en cada trabajo, así un cambio desde el panel surte efecto
// sin reiniciar nada en la tienda.
app.get('/api/print/config', requireAgenteImpresion, (req, res) => {
  const c = loadPrintConfig();
  res.json({ activo: c.activo, modo: c.modo, ip: c.ip, puerto: c.puerto, nombreCola: c.nombreCola });
});

// Los trabajos que faltan por imprimir, del más viejo al más nuevo: el orden en que entraron los
// pedidos es el orden en que conviene atenderlos.
app.get('/api/print/jobs', requireAgenteImpresion, (req, res) => {
  estadoAgente.ultimaConexion = new Date().toISOString();
  const pendientes = loadPrintQueue()
    .filter((t) => t.estado === 'pendiente')
    .map((t) => ({ id: t.id, orderId: t.orderId, motivo: t.motivo, creado: t.creado }));
  res.json(pendientes);
});

/**
 * Los bytes ESC/POS de un trabajo.
 *
 * **Pedirlos marca el trabajo como `imprimiendo`**, y solo se entregan si estaba `pendiente`. Es lo
 * que impide que dos agentes —o el mismo tras un reintento— saquen el mismo recibo dos veces.
 */
app.get('/api/print/jobs/:id/bytes', requireAgenteImpresion, (req, res) => {
  const cola = loadPrintQueue();
  const trabajo = cola.find((t) => t.id === req.params.id);
  if (!trabajo) return res.status(404).json({ error: 'Trabajo no encontrado.' });
  if (trabajo.estado !== 'pendiente') {
    return res.status(409).json({ error: `El trabajo ya está en estado "${trabajo.estado}".` });
  }

  const pedido = trabajo.motivo === 'prueba'
    ? pedidoDePrueba()
    : loadOrdersLocation().find((o) => o.orderId === trabajo.orderId);
  if (!pedido) {
    trabajo.estado = 'error';
    trabajo.error = 'El pedido ya no existe.';
    trabajo.terminadoEn = new Date().toISOString();
    savePrintQueue(cola);
    return res.status(404).json({ error: 'El pedido ya no existe.' });
  }

  const config = loadPrintConfig();
  let bytes;
  try {
    bytes = construirRecibo(pedido, config);
  } catch (err) {
    trabajo.estado = 'error';
    trabajo.error = `No se pudo componer el recibo: ${err.message}`;
    trabajo.terminadoEn = new Date().toISOString();
    savePrintQueue(cola);
    return res.status(500).json({ error: trabajo.error });
  }

  trabajo.estado = 'imprimiendo';
  trabajo.entregadoEn = new Date().toISOString();
  savePrintQueue(cola);
  estadoAgente.ultimaConexion = trabajo.entregadoEn;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(bytes);
});

// El agente cuenta cómo le fue. Hasta que llega esto, el trabajo se queda en `imprimiendo`.
app.post('/api/print/jobs/:id/resultado', requireAgenteImpresion, (req, res) => {
  const cola = loadPrintQueue();
  const trabajo = cola.find((t) => t.id === req.params.id);
  if (!trabajo) return res.status(404).json({ error: 'Trabajo no encontrado.' });

  const ok = req.body && req.body.ok === true;
  trabajo.estado = ok ? 'impreso' : 'error';
  trabajo.error = ok ? null : String((req.body && req.body.error) || 'Error desconocido en el agente.').slice(0, 300);
  trabajo.terminadoEn = new Date().toISOString();
  savePrintQueue(cola);
  estadoAgente.ultimaConexion = trabajo.terminadoEn;
  if (!ok) console.error(`Impresión fallida (${trabajo.orderId}): ${trabajo.error}`);
  res.json({ ok: true });
});

// Latido con lo que el agente ve. Las impresoras que reporta son las que el panel ofrece en la
// lista: es preferible a que el dueño escriba un nombre a mano y se equivoque en un espacio.
app.post('/api/print/agente', requireAgenteImpresion, (req, res) => {
  estadoAgente = {
    ultimaConexion: new Date().toISOString(),
    impresorasVistas: Array.isArray(req.body && req.body.impresoras)
      ? req.body.impresoras.map((x) => String(x).slice(0, 120)).slice(0, 40)
      : estadoAgente.impresorasVistas,
    version: req.body && req.body.version ? String(req.body.version).slice(0, 20) : estadoAgente.version,
  };
  res.json({ ok: true });
});

// --- Pedido de prueba --------------------------------------------------------------------------
// Datos inventados a propósito y marcados como tales: sirve para ver si la impresora responde y si
// el papel sale bien cortado, sin tener que esperar una venta real.
function pedidoDePrueba() {
  return {
    orderId: 'PRUEBA',
    createdAt: new Date().toISOString(),
    nombre: 'Impresion de prueba',
    deliveryMethod: 'Retiro en tienda',
    paymentMethod: 'Prueba',
    items: [
      { id: 'TEST1', title: 'Si lees esto, la impresora funciona', price: 1, quantity: 1 },
      { id: 'TEST2', title: 'Revisa que el papel corte bien', price: 2, quantity: 2 },
    ],
    total: 5,
  };
}

// --- Endpoints del PANEL -----------------------------------------------------------------------

function estadoDeImpresion() {
  const cola = loadPrintQueue();
  const ultimos = cola.slice(-25).reverse();
  const desde = estadoAgente.ultimaConexion ? Date.now() - new Date(estadoAgente.ultimaConexion).getTime() : null;
  return {
    config: loadPrintConfig(),
    // Sin token no hay agente posible: el panel debe decirlo claro en vez de mostrar "desconectado"
    // y dejar al dueño buscando el problema en la tienda.
    tokenConfigurado: Boolean(PRINT_AGENT_TOKEN),
    agente: {
      conectado: agentesConectados.size > 0,
      ultimaConexion: estadoAgente.ultimaConexion,
      // Un agente que no da señales en dos minutos está caído: el latido va cada 25 segundos.
      silencioSegundos: desde === null ? null : Math.round(desde / 1000),
      impresorasVistas: estadoAgente.impresorasVistas,
      version: estadoAgente.version,
    },
    pendientes: cola.filter((t) => t.estado === 'pendiente').length,
    atascados: cola.filter((t) => t.estado === 'imprimiendo').length,
    conError: cola.filter((t) => t.estado === 'error').length,
    ultimos,
  };
}

app.get('/api/admin/print', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  res.json(estadoDeImpresion());
});

app.put('/api/admin/print/config', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  const actual = loadPrintConfig();
  const body = req.body || {};
  const entero = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
  };
  const nueva = {
    activo: body.activo === undefined ? actual.activo : Boolean(body.activo),
    anchoPapel: body.anchoPapel === undefined ? actual.anchoPapel : (Number(body.anchoPapel) === 58 ? 58 : 80),
    acentos: body.acentos === undefined ? actual.acentos : Boolean(body.acentos),
    cortar: body.cortar === undefined ? actual.cortar : Boolean(body.cortar),
    qr: body.qr === undefined ? actual.qr : Boolean(body.qr),
    qrTamano: body.qrTamano === undefined ? actual.qrTamano : entero(body.qrTamano, actual.qrTamano, 3, 10),
    copias: body.copias === undefined ? actual.copias : entero(body.copias, actual.copias, 1, 3),
    modo: body.modo === 'windows' ? 'windows' : (body.modo === 'red' ? 'red' : actual.modo),
    // Se valida la forma de la IP acá y no solo en la pantalla: una IP mal escrita deja al agente
    // reintentando contra la nada y el síntoma que se ve es "no imprime", que no dice dónde mirar.
    ip: body.ip === undefined ? actual.ip : String(body.ip).trim().slice(0, 45),
    puerto: body.puerto === undefined ? actual.puerto : entero(body.puerto, actual.puerto, 1, 65535),
    nombreCola: body.nombreCola === undefined ? actual.nombreCola : String(body.nombreCola).trim().slice(0, 120),
  };
  if (nueva.modo === 'red' && nueva.ip && !/^(\d{1,3}\.){3}\d{1,3}$/.test(nueva.ip)) {
    return res.status(400).json({ error: 'La dirección IP no tiene un formato válido (ej. 192.168.1.50).' });
  }
  if (nueva.activo && nueva.modo === 'red' && !nueva.ip) {
    return res.status(400).json({ error: 'Falta la dirección IP de la impresora.' });
  }
  if (nueva.activo && nueva.modo === 'windows' && !nueva.nombreCola) {
    return res.status(400).json({ error: 'Falta elegir la impresora de la lista.' });
  }
  savePrintConfig(nueva);
  // El agente relee la configuración en cada trabajo, pero avisarle evita que el primer recibo tras
  // el cambio salga por la impresora vieja.
  avisarAgentes({ tipo: 'config' });
  res.json(estadoDeImpresion());
});

app.post('/api/admin/print/prueba', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  const config = loadPrintConfig();
  if (!config.activo) return res.status(400).json({ error: 'La impresión está apagada. Actívala primero.' });
  const trabajo = encolarImpresion('PRUEBA', 'prueba');
  if (!trabajo) return res.status(500).json({ error: 'No se pudo encolar la prueba.' });
  res.json({ ok: true, id: trabajo.id, agenteConectado: agentesConectados.size > 0 });
});

app.post('/api/admin/print/reimprimir/:orderId', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  const pedido = loadOrdersLocation().find((o) => o.orderId === req.params.orderId);
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado.' });
  const trabajo = encolarImpresion(pedido.orderId, 'reimpresion');
  if (!trabajo) return res.status(400).json({ error: 'La impresión está apagada. Actívala primero.' });
  res.json({ ok: true, id: trabajo.id, agenteConectado: agentesConectados.size > 0 });
});

// Un trabajo atascado en `imprimiendo` vuelve a `pendiente` — pero lo decide una persona, después
// de mirar si el recibo salió o no. Automatizarlo es exactamente cómo se imprime dos veces.
app.post('/api/admin/print/reintentar/:id', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  const cola = loadPrintQueue();
  const trabajo = cola.find((t) => t.id === req.params.id);
  if (!trabajo) return res.status(404).json({ error: 'Trabajo no encontrado.' });
  if (trabajo.estado === 'impreso') return res.status(409).json({ error: 'Ese trabajo ya se imprimió.' });
  trabajo.estado = 'pendiente';
  trabajo.error = null;
  trabajo.entregadoEn = null;
  trabajo.terminadoEn = null;
  savePrintQueue(cola);
  avisarAgentes({ tipo: 'trabajo', id: trabajo.id });
  res.json({ ok: true, agenteConectado: agentesConectados.size > 0 });
});

/**
 * Cómo va la impresión de recibos HOY, para quien está en el mostrador.
 *
 * Va en la pantalla de escaneo y no en la de impresión a propósito: **quien despacha es el primero
 * que se entera de que un recibo no salió**, porque tiene el pedido delante y no tiene papel. Que
 * tenga que avisarle al dueño para que entre a otra pantalla a reimprimir es una vuelta larga por
 * un problema de diez segundos.
 *
 * Por eso lo puede ver y usar cualquiera con la función `scan`, no hace falta el permiso de
 * `impresion` — que es el de CONFIGURAR la impresora, otra cosa.
 */
app.get('/api/admin/scan/impresion', requireAdminRole('admin', 'salidas', 'empleado'), requierePermiso('scan'), (req, res) => {
  const config = loadPrintConfig();
  if (!config.activo) {
    // Con la impresión apagada no hay nada que reportar, y mostrar ceros haría pensar que falló.
    return res.json({ activa: false });
  }

  const desde = startOfTodayVenezuela();
  const deHoy = loadPrintQueue().filter((t) => {
    const t0 = new Date(t.creado).getTime();
    return Number.isFinite(t0) && t0 >= desde;
  });

  // Las pruebas no son ventas: contarlas inflaría el número que mira quien despacha.
  const ventas = deHoy.filter((t) => t.motivo !== 'prueba');

  const problemas = ventas
    .filter((t) => t.estado === 'error' || t.estado === 'imprimiendo')
    .map((t) => ({
      id: t.id,
      orderId: t.orderId,
      estado: t.estado,
      error: t.error,
      creado: t.creado,
    }))
    .reverse();

  res.json({
    activa: true,
    impresos: ventas.filter((t) => t.estado === 'impreso').length,
    enCola: ventas.filter((t) => t.estado === 'pendiente').length,
    problemas,
    agenteConectado: agentesConectados.size > 0,
    ultimaSenalDelAgente: estadoAgente.ultimaConexion,
    desde: new Date(desde).toISOString(),
  });
});

/**
 * Reintenta la impresión de un recibo desde el mostrador.
 *
 * Deliberadamente MÁS ESTRECHO que el reintento del panel de impresión: solo acepta trabajos que
 * fallaron o quedaron a medias. Quien despacha no debería poder reimprimir un recibo que ya salió
 * bien —eso es lo que genera pedidos despachados dos veces—, así que un trabajo en estado `impreso`
 * se rechaza aunque el id sea válido.
 */
app.post('/api/admin/scan/reimprimir/:id', requireAdminRole('admin', 'salidas', 'empleado'), requierePermiso('scan'), (req, res) => {
  const cola = loadPrintQueue();
  const trabajo = cola.find((t) => t.id === req.params.id);
  if (!trabajo) return res.status(404).json({ error: 'Ese trabajo de impresión ya no existe.' });
  if (trabajo.estado === 'impreso') {
    return res.status(409).json({ error: 'Ese recibo ya se imprimió. Si hace falta otra copia, pedila al panel de impresión.' });
  }
  if (trabajo.estado === 'pendiente') {
    return res.status(409).json({ error: 'Ese recibo ya está en cola, esperando a la impresora.' });
  }

  trabajo.estado = 'pendiente';
  trabajo.error = null;
  trabajo.entregadoEn = null;
  trabajo.terminadoEn = null;
  savePrintQueue(cola);
  avisarAgentes({ tipo: 'trabajo', id: trabajo.id });
  console.log(`Reimpresión pedida desde el mostrador: ${trabajo.orderId} (${req.adminUser.username})`);
  res.json({ ok: true, agenteConectado: agentesConectados.size > 0 });
});

// El recibo en texto, para verlo en pantalla sin gastar papel. Sale del mismo código que compone lo
// que se imprime, así que no puede desfasarse (ver escpos-recibo.js).
app.get('/api/admin/print/vista-previa', requireAdminRole('admin'), requierePermiso('impresion'), (req, res) => {
  const config = loadPrintConfig();
  const pedido = req.query.orderId
    ? loadOrdersLocation().find((o) => o.orderId === req.query.orderId)
    : pedidoDePrueba();
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado.' });
  res.json({ texto: previsualizarRecibo(pedido, config), anchoPapel: config.anchoPapel });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inventory backend listening on port ${PORT}`));
