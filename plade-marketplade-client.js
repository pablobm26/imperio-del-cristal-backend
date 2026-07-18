// Cliente para el esquema "marketplade.php" de PLADE SOFTWARE, usado por Imperio del Cristal.
// Distinto del patrón GET /inventario/* de plade-client.js (ese es de otro cliente PLADE,
// farmaasistencia.com, y NO aplica aquí). Manual completo: E:\DESCARGAS\API IMPERIO DEL CRISTAL.pdf
//
// Todas las operaciones son POST a la misma URL con un campo `request` que elige la acción
// (getInventario, getFactura, savePedidoExterno), más `user`/`password`/`token` en el body.

const PLADE_HOST = process.env.PLADE_HOST || 'https://imperiodelcristal.pladesoftware.com/marketplade.php';

async function pladeRequest(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }

  const res = await fetch(PLADE_HOST, { method: 'POST', body: form });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body || body.r === false) {
    throw new Error(`PLADE API error: ${body?.msj || res.statusText}`);
  }
  return body;
}

function credentialsFromEnv() {
  const user = process.env.PLADE_USER;
  const password = process.env.PLADE_PASSWORD;
  const token = process.env.PLADE_TOKEN;
  if (!user || !password || !token) {
    throw new Error('Faltan PLADE_USER, PLADE_PASSWORD o PLADE_TOKEN en las variables de entorno.');
  }
  return { user, password, token };
}

function isPladeConfigured() {
  return Boolean(process.env.PLADE_USER && process.env.PLADE_PASSWORD && process.env.PLADE_TOKEN);
}

/** Catálogo completo: stock, categoría, imagen y precio reales desde PLADE. */
async function getInventario() {
  const { user, password, token } = credentialsFromEnv();
  const body = await pladeRequest({ user, password, token, request: 'getInventario' });
  return body.items || [];
}

/**
 * Convierte un item de PLADE al formato Product que ya usa el resto del backend.
 * `codigo_interno` se mantiene como `id` (coincide con los IDs que ya vienen del CSV histórico,
 * así reseñas y specs manuales guardadas por ID siguen aplicando). `id_plade` se conserva aparte
 * porque savePedidoExterno lo pedirá como `idp` al armar un pedido (fase siguiente, no implementada).
 */
function mapPladeItemToProduct(item) {
  const existencia = item.existencia !== undefined && item.existencia !== null ? Number(item.existencia) : null;
  return {
    id: String(item.codigo_interno ?? item.id_plade ?? '').trim(),
    title: String(item.descripcion ?? '').trim(),
    description: '',
    price: Number(item.precio) || 0,
    stock: existencia !== null && Number.isFinite(existencia) ? Math.trunc(existencia) : null,
    category: String(item.categoria ?? 'General').trim() || 'General',
    image: item.imagen ? String(item.imagen).trim() : '',
    width: null,
    height: null,
    length: null,
    material: null,
    weight: null,
    color: null,
    image2: null,
    image3: null,
    image4: null,
    video: null,
    idPlade: item.id_plade ? String(item.id_plade) : null,
    // Tasa de IVA tal como la da getInventario (ej. "0.00" o "16.00") — se usa para resolver
    // id_iva al armar un pedido (ver resolveIdIva más abajo). No se expone en /api/products hoy,
    // solo se guarda por si savePedidoExterno se conecta al checkout más adelante.
    ivaRate: Number(item.iva) || 0,
  };
}

/** Devuelve el detalle completo de una factura/pedido ya creado en PLADE (solo lectura). */
async function getFactura(factura) {
  const { user, password, token } = credentialsFromEnv();
  return pladeRequest({ user, password, token, request: 'getFactura', factura: String(factura) });
}

// --- Envío de pedidos (savePedidoExterno) ---
//
// ESTADO (2026-07-17): armado con todo lo confirmado en 12 pruebas reales contra la cuenta de
// Imperio del Cristal, pero PLADE tiene un bug de su lado — savePedidoExterno responde `r:true`
// y hasta devuelve de vuelta los datos del producto en `detalles`, pero el producto NUNCA queda
// realmente guardado en la factura (confirmado con getFactura las 12 veces: `productos: []`).
// NO LLAMAR saveOrderToPlade() DESDE EL CHECKOUT REAL todavía — generaría facturas reales vacías
// ($0, sin productos) en la cuenta de PLADE por cada venta. Falta que soporte de PLADE confirme
// el arreglo antes de conectar esto al flujo de compra.
//
// Valores confirmados contra la cuenta real (no adivinar, ver project_plade_integration.md):
// - idc: 29869 → "CLIENTE DEL E-COMMERCE" (cliente genérico; no existe forma de crear un cliente
//   nuevo por API — se probaron saveClienteExterno/saveCliente/guardarCliente, ninguno existe).
// - id_almacen (a nivel de pedido) / productos[x][idalm]: 9 → "ONLINE - (ABIERTO)".
// - id_iva: 4 confirmado = "Exento" (0%), tanto desde una factura real con producto como desde el
//   tráfico de red del propio panel de PLADE. El id para "IVA 16%" NO está confirmado — solo 8 de
//   8680 productos lo usan, así que se deja sin resolver a propósito (ver resolveIdIva).

const GENERIC_CLIENT_IDC = process.env.PLADE_GENERIC_CLIENT_IDC || '29869';
const ONLINE_ALMACEN_ID = process.env.PLADE_ONLINE_ALMACEN_ID || '9';
const ID_IVA_EXENTO = 4;

function resolveIdIva(ivaRate) {
  if (!ivaRate || ivaRate <= 0) return ID_IVA_EXENTO;
  throw new Error(
    `No hay un id_iva confirmado para la tasa ${ivaRate}% — solo "Exento" (0%, id_iva=4) está confirmado. ` +
    'Hay que pedirle a soporte de PLADE el id_iva real de "IVA 16%" antes de vender un producto con esa tasa por la web.'
  );
}

function formatPladeDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatPladeDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Arma (pero no garantiza que PLADE guarde de verdad, ver nota arriba) un pedido externo.
 * `order.items` = [{ idPlade, title, quantity, price, ivaRate }], `order.bcvRate` = tasa BCV del
 * momento, `order.orderId` = nuestro propio ID de pedido (mismo que ya usamos para el PDF/código
 * de barras), `order.nota` = texto libre — como no hay forma de crear un cliente real por API,
 * aquí es donde se guardan los datos reales del comprador (nombre/cédula/teléfono/dirección) para
 * que PLADE conserve esa identidad aunque el `idc` sea el cliente genérico.
 */
async function saveOrderToPlade(order) {
  const { user, password, token } = credentialsFromEnv();
  const now = new Date();

  const fields = {
    user,
    password,
    token,
    request: 'savePedidoExterno',
    idc: GENERIC_CLIENT_IDC,
    id_almacen: ONLINE_ALMACEN_ID,
    fec_fac: formatPladeDateTime(now),
    vencimiento: formatPladeDate(now),
    nota: order.nota || '',
    codigo_pedido: order.orderId,
  };

  order.items.forEach((item, i) => {
    const precioBs = Math.round(item.price * order.bcvRate * 100) / 100;
    Object.assign(fields, {
      [`productos[${i}][idp]`]: item.idPlade,
      [`productos[${i}][can]`]: item.quantity,
      [`productos[${i}][can_des]`]: item.quantity,
      [`productos[${i}][idalm]`]: ONLINE_ALMACEN_ID,
      [`productos[${i}][precio]`]: item.price,
      [`productos[${i}][precio_bs]`]: precioBs,
      [`productos[${i}][precio_p_detail]`]: item.price,
      [`productos[${i}][precio_original_bs]`]: precioBs,
      [`productos[${i}][ivap]`]: 0,
      [`productos[${i}][id_iva]`]: resolveIdIva(item.ivaRate),
      [`productos[${i}][tipo_precio]`]: '',
      [`productos[${i}][compuesto]`]: 0,
      [`productos[${i}][tipo_elemento]`]: -1,
      [`productos[${i}][nom_inv]`]: item.title,
      [`productos[${i}][nom_mv]`]: item.title,
      [`productos[${i}][id_presentacion]`]: 1,
      [`productos[${i}][factor]`]: 1,
      [`productos[${i}][presentacion]`]: 'UNIDAD',
      [`productos[${i}][porcentaje_transporte]`]: 0,
    });
  });

  return pladeRequest(fields);
}

module.exports = {
  getInventario,
  mapPladeItemToProduct,
  isPladeConfigured,
  getFactura,
  saveOrderToPlade,
  resolveIdIva,
  PLADE_HOST,
};
