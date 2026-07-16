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
  };
}

module.exports = { getInventario, mapPladeItemToProduct, isPladeConfigured, PLADE_HOST };
