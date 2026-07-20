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

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Allow the Flutter web build (served from a different origin/port) to call the API.
app.use('/api', cors());

// Si DATA_DIR apunta a un disco persistente de Render (ver README), los datos sobreviven a los
// redeploys. Sin esa variable, cae de vuelta a la carpeta local del repo (efímera en Render free).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const DETAILS_FILE = path.join(DATA_DIR, 'product_details.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders_location.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ORDERS_PDF_DIR = path.join(DATA_DIR, 'orders_pdfs');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(DETAILS_FILE)) fs.writeFileSync(DETAILS_FILE, '{}');
if (!fs.existsSync(REVIEWS_FILE)) fs.writeFileSync(REVIEWS_FILE, '{}');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, '{}');
if (!fs.existsSync(ORDERS_PDF_DIR)) fs.mkdirSync(ORDERS_PDF_DIR, { recursive: true });

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
};
const PICKUP_STORE_LABELS = {
  avBolivarNorte: 'Sede Valencia, C.C. Salva Market',
  avUniversidad: 'Sede Naguanagua, C.C. La Granja',
};
const PAYMENT_METHOD_LABELS = {
  card: 'Tarjeta de Crédito/Débito',
  cash: 'Efectivo contra entrega',
  zinli: 'Zinli (Panamá)',
  zelle: 'Zelle (USD)',
  binance: 'Binance (USDT)',
  pagoMovil: 'Pago Móvil (Bs)',
};
const COURIER_LABELS = { mrw: 'MRW', zoom: 'Zoom', tealca: 'Tealca' };
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
  if (order.deliveryMethod === 'nationalShipping' && order.courier) {
    doc.text(`Empresa de envío: ${COURIER_LABELS[order.courier] || order.courier}`);
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

  doc.font('Helvetica-Bold').fontSize(11).text(`Total: ${formatUsd(order.total)}`, { align: 'right' });
  if (order.bcvRate) {
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

function getMergedProducts() {
  const products = loadProducts();
  const details = loadDetails();
  const reviews = loadReviews();
  return products.map((p) => {
    const merged = mergeProductWithDetails(p, details);
    return { ...merged, ...ratingSummary(reviews[p.id]) };
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
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
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
async function submitOrderToPlade({ orderId, nota, items }) {
  if (!isPladeConfigured()) return;
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

  ${products.length ? `
  <table>
    <tr><th>ID</th><th>Nombre</th><th>Precio</th><th>Stock</th><th>Categoría</th></tr>
    ${products.slice(0, 20).map(p => `<tr><td>${p.id}</td><td>${p.title}</td><td>$${p.price.toFixed(2)}</td><td>${p.stock ?? '-'}</td><td>${p.category}</td></tr>`).join('')}
  </table>
  ${products.length > 20 ? `<p>... y ${products.length - 20} más.</p>` : ''}
  ` : ''}
  <a class="link-btn" href="/admin/products">Completar/editar especificaciones de productos (material, color, medidas, peso) &rarr;</a>
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
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));

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

// Un solo producto por ID — evita que la página de cada producto tenga que descargar el
// catálogo completo (varios MB) solo para mostrar uno.
app.get('/api/products/:id', (req, res) => {
  const product = getMergedProducts().find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
  res.json(product);
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
app.post('/api/orders', async (req, res) => {
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
  const pickupStore = body.pickupStore ? String(body.pickupStore) : '';
  const courier = body.courier ? String(body.courier) : '';
  const deliveryZone = body.deliveryZone ? String(body.deliveryZone) : '';
  const deliveryFee = Number.isFinite(Number(body.deliveryFee)) && Number(body.deliveryFee) > 0 ? Number(body.deliveryFee) : 0;
  const items = Array.isArray(body.items) ? body.items : [];
  const total = Number(body.total);
  const bcvRate = Number.isFinite(Number(body.bcvRate)) && Number(body.bcvRate) > 0 ? Number(body.bcvRate) : null;

  if (!estado || !ciudad || !parroquia || !address || !cedula || !telefono || !correo) {
    return res.status(400).json({ error: 'Faltan campos requeridos.' });
  }
  if (items.length === 0 || !Number.isFinite(total)) {
    return res.status(400).json({ error: 'Faltan los productos o el total del pedido.' });
  }

  const normalizedItems = items.map((item) => ({
    id: String(item?.id ?? '').trim() || '—',
    title: String(item?.title ?? '').trim() || 'Producto',
    quantity: Math.max(1, Math.trunc(Number(item?.quantity) || 1)),
    price: Number(item?.price) || 0,
  }));

  const createdAt = new Date().toISOString();
  const orderId = crypto.randomBytes(16).toString('hex');

  let pdfUrl = null;
  try {
    const pdfBuffer = await generateOrderPdfBuffer({
      orderId,
      createdAt,
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
      paymentMethod,
      reference,
      deliveryZone,
      deliveryFee,
      items: normalizedItems,
      total,
      bcvRate,
    });
    fs.writeFileSync(path.join(ORDERS_PDF_DIR, `${orderId}.pdf`), pdfBuffer);
    pdfUrl = `/api/orders/${orderId}/pdf`;
  } catch (err) {
    console.error('No se pudo generar el PDF del pedido:', err.message);
  }

  const orders = loadOrdersLocation();
  orders.push({
    orderId,
    estado,
    ciudad,
    parroquia,
    deliveryMethod,
    paymentMethod,
    pdfUrl,
    createdAt,
  });
  saveOrdersLocation(orders);

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

  const zoneNote = deliveryMethod === 'homeDelivery' && deliveryZone ? ` | Zona delivery: ${DELIVERY_ZONE_LABELS[deliveryZone] || deliveryZone} (+$${deliveryFee})` : '';
  const nota = `${nombre} | ${idType}-${cedula} | Tel: ${telefono} | Correo: ${correo} | ${estado}, ${ciudad}, ${parroquia} | ${address} | Entrega: ${deliveryMethod} | Pago: ${paymentMethod}${zoneNote}`;
  submitOrderToPlade({ orderId, nota, items: normalizedItems }).catch((err) => {
    console.error(`Error enviando pedido ${orderId} a PLADE:`, err.message);
  });

  res.status(201).json({ ok: true, orderId, pdfUrl });
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inventory backend listening on port ${PORT}`));
