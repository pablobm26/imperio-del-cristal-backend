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

function normalize(header) {
  return String(header)
    .normalize('NFD')
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildColumnMap(headers) {
  const normalizedHeaders = headers.map(normalize);
  const map = {};
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
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

function loadProducts() {
  return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
}

function loadStockAdjustments() {
  return JSON.parse(fs.readFileSync(STOCK_ADJUSTMENTS_FILE, 'utf8'));
}

function saveStockAdjustments(adjustments) {
  fs.writeFileSync(STOCK_ADJUSTMENTS_FILE, JSON.stringify(adjustments, null, 2));
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
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(newProducts, null, 2));
}

function loadDetails() {
  return JSON.parse(fs.readFileSync(DETAILS_FILE, 'utf8'));
}

function saveDetails(details) {
  fs.writeFileSync(DETAILS_FILE, JSON.stringify(details, null, 2));
}

function loadReviews() {
  return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
}

function saveReviews(reviews) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
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
  doc.moveTo(doc.x, y).lineTo(doc.x + RECEIPT_CONTENT_WIDTH, y).lineWidth(0.5).strokeColor('#999').stroke();
  doc.moveDown(0.4);
}

// Dibuja todo el contenido del recibo sobre un documento ya creado. Se llama dos veces (ver
// generateOrderPdfBuffer): una para medir cuánta altura ocupa el contenido real, y otra para
// generar el PDF final con esa altura exacta — así no se imprime papel en blanco de más.
function drawReceiptBody(doc, order, barcodeBuffer) {
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text('El Imperio del Cristal', { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text('Bisutería y accesorios', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(7).fillColor('#999');
  doc.text(`Pedido: ${order.orderId}`, { align: 'center' });
  doc.text(`Fecha: ${new Date(order.createdAt).toLocaleString('es-VE')}`, { align: 'center' });
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Datos del cliente');
  doc.font('Helvetica').fontSize(8);
  doc.text(`Nombre: ${order.nombre}`);
  doc.text(`Identificación: ${order.idType}-${order.cedula}`);
  doc.text(`Teléfono: ${order.telefono}`);
  doc.text(`Correo: ${order.correo}`);
  drawReceiptDivider(doc);

  doc.font('Helvetica-Bold').fontSize(9).text('Entrega');
  doc.font('Helvetica').fontSize(8);
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
  doc.font('Helvetica').fontSize(8);
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
    doc.font('Helvetica').fontSize(7).fillColor('#666').text(item.id);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(item.title);
    doc.font('Helvetica').fontSize(8);
    doc.text(`${item.quantity} x ${formatUsd(item.price)} = ${formatUsd(item.price * item.quantity)}`);
    doc.moveDown(0.3);
  }
  drawReceiptDivider(doc);

  if (order.discountApplied) {
    const subtotal = order.total + order.discountApplied.amount - (order.deliveryFee || 0);
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(`Subtotal: ${formatUsd(subtotal)}`, { align: 'right' });
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
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(`(${formatCop(order.total * order.trmRate)})`, { align: 'right' });
  } else if (order.country !== 'US' && order.country !== 'CO' && order.bcvRate) {
    doc.font('Helvetica').fontSize(8).fillColor('#666').text(`(${formatBs(order.total * order.bcvRate)})`, { align: 'right' });
  }

  // Código de barras del número de pedido: permite escanear y validar en tienda que esta venta
  // no se procese/entregue dos veces. No es un ID de pago externo, solo el orderId propio.
  if (barcodeBuffer) {
    doc.moveDown(0.8);
    doc.fontSize(7).fillColor('#666').text('Código de verificación del pedido', { align: 'center' });
    doc.moveDown(0.2);
    doc.image(barcodeBuffer, { fit: [mm(60), mm(14)], align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(8).fillColor('#000').text(order.orderId, { align: 'center' });
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
      bcid: 'code128',
      text: order.orderId,
      scale: 2,
      height: 10,
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
      bcid: 'code128',
      text: order.orderId,
      scale: 2,
      height: 10,
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
  <div class="status">Productos actualmente cargados: <b>${products.length}</b></div>

  <div class="status">
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
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
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
