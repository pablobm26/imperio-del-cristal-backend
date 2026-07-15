const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { getChatReply } = require('./chat');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Allow the Flutter web build (served from a different origin/port) to call the API.
app.use('/api', cors());

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const DETAILS_FILE = path.join(DATA_DIR, 'product_details.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(DETAILS_FILE)) fs.writeFileSync(DETAILS_FILE, '{}');

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
const DETAIL_FIELDS = ['width', 'height', 'length', 'material', 'weight', 'color', 'image2', 'image3', 'image4', 'video'];

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
  return products.map((p) => mergeProductWithDetails(p, details));
}

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
    input { display: block; margin-top: 4px; padding: 8px; width: 100%; box-sizing: border-box; }
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

    <label>Fotos adicionales (URL) — la foto principal viene del Excel, columna "Imagen"</label>
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
    material: req.body.material ? String(req.body.material).trim() : null,
    color: req.body.color ? String(req.body.color).trim() : null,
    width: parseOptionalNumber(req.body.width),
    height: parseOptionalNumber(req.body.height),
    length: parseOptionalNumber(req.body.length),
    weight: parseOptionalNumber(req.body.weight),
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

app.get('/api/categories', (req, res) => {
  const products = loadProducts();
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  res.json(categories);
});

// --- Simple in-memory rate limiter for the chat endpoint (per IP) ---
const CHAT_RATE_LIMIT = 20; // messages
const CHAT_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const chatRateLimitByIp = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = chatRateLimitByIp.get(ip);
  if (!entry || now - entry.windowStart > CHAT_RATE_WINDOW_MS) {
    chatRateLimitByIp.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > CHAT_RATE_LIMIT;
}

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Falta el campo "message".' });
  }

  if (isRateLimited(req.ip)) {
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Inventory backend listening on port ${PORT}`));
