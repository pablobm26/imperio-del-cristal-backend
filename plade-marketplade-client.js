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

/**
 * Sucursales de las que se toma el inventario.
 *
 * **`id_sucursal` NO está en el manual de PLADE** — se descubrió probando el 2026-09-02, después de
 * que el manual mostrara que `getInventario` solo acepta cuatro campos. Comprobado contra la cuenta
 * real: sin filtro la suma de existencias da 418.180 unidades; con `id_sucursal=5` da 118.943 y con
 * `id_sucursal=7`, 61.275. Filtra de verdad.
 *
 * Los otros dos nombres candidatos **no sirven**: `id_almacen` e `id_est` se envían sin error y
 * devuelven el total de todas las sedes. Que no den error es justamente lo que los hace peligrosos.
 *
 * ⚠️ **Un `id_sucursal` vacío devuelve el TOTAL de todas las sedes, sin avisar.** Por eso acá se
 * valida a entero positivo y, si no queda ninguno válido, **no se manda el campo en absoluto** en
 * vez de mandarlo vacío. La diferencia entre "no filtrar" y "filtrar mal" tiene que ser explícita.
 */
function normalizarSucursales(valor) {
  const lista = Array.isArray(valor) ? valor : [valor];
  const limpias = [];
  for (const v of lista) {
    const n = Number(String(v ?? '').trim());
    // Entero positivo o nada. Un "1|5" o un "1,5" llegan acá como NaN y se descartan — PLADE los
    // acepta en silencio quedándose con UNA sola sede, que es el peor resultado posible: parece
    // que funcionó.
    if (Number.isInteger(n) && n > 0 && !limpias.includes(n)) limpias.push(n);
  }
  return limpias;
}

/**
 * Suma el inventario de varias sucursales, producto por producto.
 *
 * PLADE **no combina sedes en una sola consulta**: se probó con `1,5`, `1;5`, `id_sucursal[]` y la
 * clave repetida. Las dos primeras dan error y las otras se quedan con una sola sede sin avisar.
 * Así que se consulta una vez por sede y se suma acá.
 *
 * `existencia` en `null` significa "PLADE no lleva la cuenta de este producto". Se conserva el
 * `null` **solo si TODAS las sedes lo tienen así**; si alguna da un número, las demás cuentan como
 * cero. Si se tratara el null como cero desde el principio, un producto sin conteo pasaría a figurar
 * como agotado, que es una afirmación distinta y falsa (ver 2.32 del HANDOFF).
 */
function combinarSucursales(respuestas) {
  const base = new Map();
  for (const items of respuestas) {
    for (const item of items) {
      const clave = String(item.codigo_interno ?? item.id_plade ?? '').trim();
      if (!clave) continue;
      const n = item.existencia === null || item.existencia === undefined || item.existencia === ''
        ? null
        : Number(item.existencia);
      const previo = base.get(clave);
      if (!previo) {
        // El resto de campos (nombre, precio, categoría, foto) es igual en todas las sedes: solo
        // cambia la existencia. Se toma la primera respuesta como base.
        base.set(clave, { ...item, existencia: n, _algunNumero: Number.isFinite(n) });
        continue;
      }
      if (Number.isFinite(n)) {
        previo.existencia = (previo._algunNumero ? Number(previo.existencia) : 0) + n;
        previo._algunNumero = true;
      }
    }
  }
  return [...base.values()].map(({ _algunNumero, ...item }) => ({
    ...item,
    existencia: _algunNumero ? item.existencia : null,
  }));
}

/**
 * Catálogo completo: stock, categoría, imagen y precio reales desde PLADE.
 *
 * @param {number[]} sucursales IDs de las sedes a sumar. Vacío = todas (comportamiento histórico).
 *
 * **Si falla una sola de las consultas, falla todo.** Es deliberado: devolver la suma de las sedes
 * que sí respondieron sería un número creíble y equivocado, y el catálogo se actualizaría con menos
 * stock del real —dejando de vender mercancía que hay— sin que nadie note nada. Al lanzar, el
 * llamador conserva el catálogo anterior, que es viejo pero coherente.
 */
async function getInventario(sucursales = []) {
  const { user, password, token } = credentialsFromEnv();
  const ids = normalizarSucursales(sucursales);

  if (ids.length === 0) {
    const body = await pladeRequest({ user, password, token, request: 'getInventario' });
    return body.items || [];
  }

  // En serie y no en paralelo: cada respuesta pesa 2,4 MB y son el sistema con el que el negocio
  // factura a diario. Dos consultas seguidas de un segundo no le hacen nada; dos simultáneas cada
  // ocho minutos son ruido innecesario sobre su servidor.
  const respuestas = [];
  for (const id of ids) {
    const body = await pladeRequest({ user, password, token, request: 'getInventario', id_sucursal: id });
    const items = body.items || [];
    if (items.length === 0) {
      throw new Error(`La sucursal ${id} devolvió un catálogo vacío — se aborta para no borrar el stock.`);
    }
    respuestas.push(items);
  }

  return respuestas.length === 1 ? respuestas[0] : combinarSucursales(respuestas);
}

/**
 * Convierte un item de PLADE al formato Product que ya usa el resto del backend.
 * `codigo_interno` se mantiene como `id` (coincide con los IDs que ya vienen del CSV histórico,
 * así reseñas y specs manuales guardadas por ID siguen aplicando). `id_plade` se conserva aparte
 * porque savePedidoExterno lo pedirá como `idp` al armar un pedido (fase siguiente, no implementada).
 */
/**
 * Normaliza la existencia que manda PLADE.
 *
 * Antes se truncaba con Math.trunc, y eso rompía los productos que se venden POR MEDIDA — paracord,
 * hilo chino, piel de serpiente, cadenas por metro. Un rollo con 0,8 metros quedaba en 0 y la
 * tienda lo daba por agotado teniendo mercancía; y a 290 productos con fracción se les perdía el
 * resto en cada sincronización.
 *
 * Se redondea a dos decimales, y no más, por un motivo concreto: PLADE devuelve restos de
 * aritmética de punto flotante como `2.220446049250313e-15` o `-3.55e-15`, que son cero disfrazado.
 * Sin el redondeo, ese `2.22e-15` es mayor que cero y el producto se ofrecería como disponible.
 */
function normalizarExistencia(valor) {
  if (valor === undefined || valor === null) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  // El corte va contra el valor CRUDO, antes de redondear: si se redondeara primero, un 0,009 se
  // convertiría en 0,01 y volvería a colarse como mercancía existente.
  if (Math.abs(n) < 0.01) return 0;
  return Math.round(n * 100) / 100;
}

function mapPladeItemToProduct(item) {
  const existencia = normalizarExistencia(item.existencia);
  return {
    id: String(item.codigo_interno ?? item.id_plade ?? '').trim(),
    title: String(item.descripcion ?? '').trim(),
    description: '',
    price: Number(item.precio) || 0,
    stock: existencia,
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
// ESTADO (2026-07-18): tras 16 pruebas reales con la estructura anterior (id_almacen/idalm por
// producto, fec_fac, precio_p_detail, nom_mv), PLADE confirmó un bug de su lado — el pedido se
// creaba (`r:true`) pero el producto nunca quedaba guardado en la factura. Soporte de PLADE
// respondió el 2026-07-18 con una estructura de campos distinta (ver abajo) — probar #17 con
// esta nueva estructura antes de asumir que el bug sigue igual.
//
// Cambios de la estructura anterior según la respuesta de soporte:
// - Ya NO se envía id_almacen (a nivel de pedido) ni productos[x][idalm] — soporte no los incluyó.
// - fec_fac → fecha (mismo formato de fecha/hora).
// - Nuevo campo `dolar` (tasa BCV / valor de $1 en Bs), tanto a nivel de pedido como por producto.
// - precio_p_detail → precio_p_detal ("precio para detal", no el inglés "detail").
// - productos[x][nom_mv] eliminado — solo se manda nom_inv.
//
// Valores confirmados contra la cuenta real (no adivinar, ver project_plade_integration.md):
// - idc: el campo que mandamos acá NUNCA lo respetó savePedidoExterno. Se probó con 29869, con 381,
//   sin el campo y en distintos órdenes (≈23 facturas reales el 17-18/07/2026): la orden siempre
//   cayó en el cliente 381, porque PLADE lo resuelve del usuario de la API (id_usuario 1500,
//   "PLADE ALIANZAS") y no del cuerpo del pedido. Antes del 2026-07-18 la cuenta 381 era
//   "CARLOS CASTELLANOS" (cuenta interna de PLADE, mal atribuida); cuando se les reportó, PLADE NO
//   arregló la API — editaron el registro 381 para renombrarlo "CLIENTE DEL E-COMMERCE"
//   (confirmado con getFactura en la factura 85817).
//   2026-08-09: el dueño creó un cliente nuevo, id 2509 (RIF sin la J), y pidió que las ventas web
//   queden bajo ese. Se cambió el valor enviado a 2509 y se PROBÓ con una factura real (88408):
//   `getFactura` devolvió `id_cliente: "381"`, `idc: "381"`, `nom_cli: "CLIENTE DEL E-COMMERCE"` y
//   `cod_cli: "21024060"` (= el usuario de la API). O sea que **sigue ignorándose**, igual que en
//   julio — no cambió nada del lado de PLADE en estas 3 semanas. No dio error 500 y la línea de
//   producto guardó bien, así que mandar 2509 es inofensivo: se deja como declaración de intención,
//   listo para cuando PLADE lo respete.
//   Para que las ventas caigan de verdad en 2509 hace falta que soporte de PLADE re-apunte el
//   usuario de la API (id_usuario 1500, "PLADE ALIANZAS") a esa ficha — que es exactamente lo que
//   hicieron en julio, cuando en vez de arreglar el campo editaron el registro 381. Pedido
//   redactado en PEDIDO-SOPORTE-PLADE.md (raíz del repo).
//   Cómo re-verificar después de que contesten: crear una venta real y leerla con getFactura; si
//   `fac.id_cliente` vuelve 2509, quedó. No hace falta tocar código.
// - id_almacen: 1 → "ALMACEN PRINCIPAL". Igual que idc, savePedidoExterno ignora lo que se envíe acá
//   (se probó con 9 "ONLINE" y sin enviarlo, mismo resultado siempre) — se deja en 1 explícito por
//   la misma razón que idc.
// - id_iva: 4 confirmado = "Exento" (0%), tanto desde una factura real con producto como desde el
//   tráfico de red del propio panel de PLADE.
// - id_iva: 5 = "IVA 16%" (dato dado por el dueño 2026-07-18, confirmado contra factura real 85815).

const GENERIC_CLIENT_IDC = process.env.PLADE_GENERIC_CLIENT_IDC || '2509';
const ONLINE_ALMACEN_ID = process.env.PLADE_ONLINE_ALMACEN_ID || '1';
const ID_IVA_EXENTO = 4;
const ID_IVA_16 = 5;

function resolveIdIva(ivaRate) {
  if (!ivaRate || ivaRate <= 0) return ID_IVA_EXENTO;
  if (ivaRate === 16) return ID_IVA_16;
  throw new Error(
    `No hay un id_iva confirmado para la tasa ${ivaRate}% — solo Exento (0%, id_iva=4) e IVA 16% (id_iva=5) están confirmados.`
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
    request: 'savePedidoExterno',
    token,
    idc: GENERIC_CLIENT_IDC,
    id_almacen: ONLINE_ALMACEN_ID,
    dolar: order.bcvRate,
    fecha: formatPladeDateTime(now),
    vencimiento: formatPladeDate(now),
  };

  order.items.forEach((item, i) => {
    const precioBs = Math.round(item.price * order.bcvRate * 100) / 100;
    Object.assign(fields, {
      [`productos[${i}][idp]`]: item.idPlade,
      [`productos[${i}][can]`]: item.quantity,
      [`productos[${i}][can_des]`]: item.quantity,
      [`productos[${i}][idalm]`]: ONLINE_ALMACEN_ID,
      [`productos[${i}][dolar]`]: order.bcvRate,
      [`productos[${i}][precio]`]: item.price,
      [`productos[${i}][precio_bs]`]: precioBs,
      [`productos[${i}][precio_p_detal]`]: item.price,
      [`productos[${i}][precio_original_bs]`]: precioBs,
      [`productos[${i}][ivap]`]: 0,
      [`productos[${i}][id_iva]`]: resolveIdIva(item.ivaRate),
      [`productos[${i}][tipo_precio]`]: '',
      [`productos[${i}][compuesto]`]: 0,
      [`productos[${i}][tipo_elemento]`]: -1,
      [`productos[${i}][nom_inv]`]: item.title,
      [`productos[${i}][porcentaje_transporte]`]: 0,
      [`productos[${i}][id_presentacion]`]: 1,
      [`productos[${i}][factor]`]: 1,
      [`productos[${i}][presentacion]`]: 'UNIDAD',
    });
  });

  fields.nota = order.nota || '';
  fields.codigo_pedido = order.orderId;

  return pladeRequest(fields);
}

module.exports = {
  normalizarSucursales,
  getInventario,
  mapPladeItemToProduct,
  isPladeConfigured,
  getFactura,
  saveOrderToPlade,
  resolveIdIva,
  PLADE_HOST,
};
