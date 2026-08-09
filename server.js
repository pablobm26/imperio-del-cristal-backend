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
const { getInventario, mapPladeItemToProduct, isPladeConfigured, saveOrderToPlade } = require('./plade-marketplade-client');
const adminUsers = require('./admin-users');
const productImages = require('./product-images');
const {
  isLoyaltyConfigured,
  getLoyaltyForUser,
  recordPurchase,
  listPurchases,
  getPurchase,
  setPurchaseStatus,
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

// Allow the Flutter web build (served from a different origin/port) to call the API.
app.use('/api', cors());

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
function applyPendingStock(stock, productId, adjustments) {
  const pending = adjustments[productId];
  if (!pending || stock === null || stock === undefined) return stock;
  return Math.max(0, stock - pending);
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

// --- Sincronización con PLADE SOFTWARE (getInventario) ---
// Solo se activa si PLADE_USER/PLADE_PASSWORD/PLADE_TOKEN están configurados como variables de
// entorno; sin ellas, el catálogo sigue viniendo del CSV subido manualmente en /admin (sin cambios
// de comportamiento para quien no tenga PLADE conectado). Escribe directo a PRODUCTS_FILE, así que
// el resto del backend (getMergedProducts, /api/products, /api/categories) no necesita saber de
// dónde vino el catálogo.
const PLADE_SYNC_INTERVAL_MS = 30 * 60 * 1000; // cada 30 min alcanza para un catálogo que no cambia segundo a segundo
let lastPladeSync = null; // { at: string, count: number } | { at: string, error: string }

async function syncProductsFromPlade() {
  const items = await getInventario();
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
    return data; // { role, sub, username, exp }
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
    if (!data || !allowedRoles.includes(data.role)) {
      return res.status(401).json({ error: 'No autorizado.' });
    }
    req.adminRole = data.role;
    req.adminUser = { sub: data.sub || null, username: data.username || data.role };
    next();
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
  const user = await adminUsers.findActiveUser(username);
  if (user) {
    const ok = await adminUsers.verifyPassword(password, user.password_hash);
    if (!ok) return null;
    adminUsers.touchLastLogin(user.id).catch((err) =>
      console.error('No se pudo actualizar last_login_at:', err.message)
    );
    return { role: user.role, sub: user.id, username: user.username, fullName: user.full_name };
  }

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return { role: 'admin', sub: null, username: ADMIN_USERNAME, fullName: 'Administrador' };
  }
  if (username === SALIDAS_USERNAME && password === SALIDAS_PASSWORD) {
    return { role: 'salidas', sub: null, username: SALIDAS_USERNAME, fullName: 'Salidas' };
  }
  return null;
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Falta usuario o contraseña.' });
  }

  let account;
  try {
    account = await authenticateAdmin(username, password);
  } catch (err) {
    // Supabase caído o mal configurado: se avisa en el log, pero al usuario se le da el mismo
    // mensaje genérico que a una credencial inválida, para no filtrar el estado de la infra.
    console.error('Error validando el login del panel:', err.message);
    return res.status(500).json({ error: 'No se pudo validar el acceso. Intentá de nuevo.' });
  }

  if (!account) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  res.json({
    token: signAdminToken(account.role, { sub: account.sub, username: account.username }),
    role: account.role,
    username: account.username,
    fullName: account.fullName,
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
  if (!adminUsers.isAdminUsersConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no hay tabla de usuarios todavía.' });
  }
  const { username, fullName, password, role } = req.body || {};
  try {
    res.status(201).json({ user: await adminUsers.createUser({ username, fullName, password, role }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', requireAdminRole('admin'), async (req, res) => {
  if (!adminUsers.isAdminUsersConfigured()) {
    return res.status(503).json({ error: 'Supabase no está configurado: no hay tabla de usuarios todavía.' });
  }
  const { role, active, password } = req.body || {};

  // Nadie puede desactivarse ni degradarse a sí mismo: es la forma más fácil de quedarse afuera
  // del panel sin querer. Que lo haga otro administrador.
  if (req.adminUser.sub && req.adminUser.sub === req.params.id && (active === false || (role && role !== 'admin'))) {
    return res.status(400).json({ error: 'No podés desactivar ni cambiarle el rol a tu propia cuenta.' });
  }

  try {
    // Guarda contra quedarse sin ningún administrador activo. Se chequea antes de escribir.
    if (active === false || (role && role !== 'admin')) {
      const target = (await adminUsers.listUsers()).find((u) => u.id === req.params.id);
      if (target && target.role === 'admin' && target.active && (await adminUsers.countActiveAdmins()) <= 1) {
        return res.status(400).json({ error: 'Es el último administrador activo. Creá otro antes de tocar esta cuenta.' });
      }
    }

    if (password !== undefined) await adminUsers.resetPassword(req.params.id, password);
    const user =
      role !== undefined || active !== undefined
        ? await adminUsers.updateUser(req.params.id, { role, active })
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

// --- Dashboard del panel nuevo ---
//
// Se calcula al vuelo sobre orders_location.json y el catálogo cacheado en memoria: con ~8700
// productos y decenas de pedidos es cuestión de milisegundos, y evita mantener contadores
// persistidos que se pueden desincronizar. Si el volumen de pedidos crece mucho, el candidato a
// optimizar es este recorrido, no el del catálogo.

/** Umbral de "poco stock". Mismo criterio que el rail de "últimas piezas" del checkout. */
const LOW_STOCK_THRESHOLD = 5;

function startOfDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
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

app.get('/api/admin/products', requireAdminRole('admin', 'empleado'), (req, res) => {
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

app.get('/api/admin/products/:id', requireAdminRole('admin', 'empleado'), (req, res) => {
  const product = getMergedProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json({ product });
});

/** Descripción y especificaciones. Solo se tocan los campos que vengan en el body. */
app.patch('/api/admin/products/:id/details', requireAdminRole('admin', 'empleado'), (req, res) => {
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

app.post('/api/admin/products/:id/images', requireAdminRole('admin', 'empleado'), upload.single('file'), async (req, res) => {
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

app.post('/api/admin/products/:id/video', requireAdminRole('admin', 'empleado'), uploadVideo.single('file'), async (req, res) => {
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

app.delete('/api/admin/products/:id/video', requireAdminRole('admin', 'empleado'), async (req, res) => {
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

app.delete('/api/admin/products/:id/images/:slot', requireAdminRole('admin', 'empleado'), async (req, res) => {
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
app.post('/api/admin/scan', requireAdminRole('admin', 'salidas'), (req, res) => {
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
    ${products.slice(0, 20).map(p => `<tr><td>${p.id}</td><td>${p.title}</td><td>$${p.price.toFixed(2)}</td><td>${p.stock ?? '-'}</td><td>${p.category}</td></tr>`).join('')}
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
  res.json(getMergedProducts());
});

// Lote de productos por ID (ej. "Últimos productos visitados" en tienda_web) — un solo request en
// vez de una llamada por producto. Tiene que ir ANTES de /api/products/:id para que Express no
// interprete "batch" como un id.
app.get('/api/products/batch', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (ids.length === 0) return res.json([]);
  const idSet = new Set(ids);
  res.json(getMergedProducts().filter((p) => idSet.has(p.id)));
});

// Muestra aleatoria de productos con imagen y stock — usado por tienda_web para sugerir productos
// ("Quizás pueda interesarte") en el carrito/checkout, excluyendo lo que el cliente ya tiene en el
// carrito o ya vio. Con `maxStock` filtra a solo productos con poco stock (0 < stock < maxStock),
// para el rail de "Últimas unidades" — sin este parámetro, cualquier producto con stock cuenta.
// También tiene que ir ANTES de /api/products/:id.
app.get('/api/products/random', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);
  const exclude = new Set(String(req.query.exclude || '').split(',').map((s) => s.trim()).filter(Boolean));
  const maxStock = req.query.maxStock ? Math.max(1, parseInt(req.query.maxStock, 10) || 0) : null;
  const pool = getMergedProducts().filter((p) => {
    if (exclude.has(p.id) || !p.image) return false;
    if (maxStock !== null) return p.stock !== null && p.stock > 0 && p.stock < maxStock;
    return p.stock === null || p.stock > 0;
  });
  const picked = [];
  while (picked.length < limit && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
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
  const merged = mergeProductWithDetails(raw, loadDetails());
  const stock = applyPendingStock(merged.stock, raw.id, loadStockAdjustments());
  res.json({ ...merged, stock, ...ratingSummary(loadReviews()[raw.id]) });
});

app.get('/api/categories', (req, res) => {
  const products = loadProducts();
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  res.json(categories);
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

  const normalizedItems = items.map((item) => ({
    id: String(item?.id ?? '').trim() || '—',
    title: String(item?.title ?? '').trim() || 'Producto',
    quantity: Math.max(1, Math.trunc(Number(item?.quantity) || 1)),
    price: Number(item?.price) || 0,
  }));
  const merchandiseSubtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const round2 = (n) => Math.round(n * 100) / 100;

  // Nivel de fidelidad: si hay userId, el backend recalcula el total autoritativo contra Supabase
  // (con la service_role key) en vez de confiar en el `total` que mandó el navegador. Si Supabase
  // no está configurado o la consulta falla, se degrada a comportamiento de invitado (usa el total
  // del cliente, sin descuento) en vez de romper el checkout.
  let finalTotal = total;
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
    const ext = req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    fs.writeFileSync(path.join(ORDERS_PAYMENT_PROOFS_DIR, `${orderId}${ext}`), req.file.buffer);
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
    const products = getMergedProducts();
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inventory backend listening on port ${PORT}`));
