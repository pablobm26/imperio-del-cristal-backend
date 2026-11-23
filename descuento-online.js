// Descuento por compra online — UN solo porcentaje para todos los clientes registrados.
//
// Reemplaza (2026-10-08) al programa de niveles de fidelidad (PLATA/ORO/PLATINO/DIAMANTE), que no
// funcionó: ningún cliente llegó al primer nivel. Ahora todo el que compra con sesión iniciada (y
// el checkout ya la exige) recibe el mismo descuento inmediato, para que comprar online salga más
// barato que en la tienda física.
//
// **Este archivo es la única fuente del porcentaje.** La tienda lo pide a GET /api/descuento-online
// para mostrarlo; el número que de verdad se cobra se calcula acá, al crear el pedido. Se cambia con
// la variable de entorno DESCUENTO_ONLINE_PCT en Render (sin tocar código); sin la variable, 10.
//
// **Se calcula por producto, no sobre el total**, para que el recibo pueda mostrar el descuento de
// cada artículo y para que la factura que va a PLADE (precio unitario ya descontado) sume EXACTAMENTE
// lo mismo que cobró la tienda. El precio unitario con descuento se redondea a centavos y todo lo
// demás se deriva de ahí; la tienda usa la misma fórmula (tienda_web/lib/descuento-online.ts).
//
// **Se suma a cualquier otra promoción:** se aplica sobre el precio vigente del catálogo, así que si
// un producto ya viene rebajado desde PLADE, el 10% va encima de ese precio rebajado. El delivery
// nunca se descuenta.
//
// **Compra mínima (regla del dueño, 2026-10-09):** el descuento solo aplica si el subtotal de
// mercancía —precio de catálogo, ANTES del descuento y SIN delivery— es igual o mayor a
// DESCUENTO_ONLINE_MINIMO (variable en Render; sin ella, $30). Por debajo, el pedido sale a precio
// completo. La tienda usa el mismo umbral, que lee de GET /api/descuento-online.

const round2 = (n) => Math.round(n * 100) / 100;

function porcentajeDescuentoOnline() {
  const crudo = process.env.DESCUENTO_ONLINE_PCT;
  const n = crudo === undefined || crudo === '' ? 10 : Number(crudo);
  // Fuera de rango o mal escrito: se cae a 0 (sin descuento) en vez de cobrar algo raro. Mejor
  // perder el descuento un rato que vender con un 900% por un error de tipeo.
  if (!Number.isFinite(n) || n < 0 || n > 90) {
    console.error(`DESCUENTO_ONLINE_PCT inválido (${crudo}); se aplica 0%.`);
    return 0;
  }
  return n;
}

function minimoDescuentoOnline() {
  const crudo = process.env.DESCUENTO_ONLINE_MINIMO;
  const n = crudo === undefined || crudo === '' ? 30 : Number(crudo);
  // Mal escrito: se mantiene el mínimo de siempre en vez de regalar el descuento a todo pedido.
  if (!Number.isFinite(n) || n < 0) {
    console.error(`DESCUENTO_ONLINE_MINIMO inválido (${crudo}); se usa $30.`);
    return 30;
  }
  return n;
}

const ETIQUETA = 'Descuento compra online';

/**
 * BLACK FRIDAY 2026 (pedido del dueño el 2026-11-23). Del 27 nov 12:00 a. m. al 28 nov 11:59:59 p. m.
 * hora de Venezuela (UTC-4), la tienda online cobra 20% de descuento en toda la mercancía, SIN
 * mínimo de compra, en lugar del 10% desde $30. **No aplica a compras con Cashea** (la nota del
 * aviso): con Cashea rige la regla normal de siempre. Fuera de esas fechas esto no hace nada.
 * Las mismas fechas están en tienda_web/lib/promos.ts (el aviso y el contador): cambiarlas juntas.
 */
const BLACK_FRIDAY = {
  inicio: Date.UTC(2026, 10, 27, 4, 0, 0),
  fin: Date.UTC(2026, 10, 29, 3, 59, 59),
  percent: 20,
  minimo: 0,
  excluye: ['cashea'],
  etiqueta: 'Descuento Black Friday',
  tier: 'BLACKFRIDAY',
};

function promoActiva(ahora = Date.now()) {
  return ahora >= BLACK_FRIDAY.inicio && ahora <= BLACK_FRIDAY.fin ? BLACK_FRIDAY : null;
}

/**
 * Regla de descuento que corresponde a un pedido: la de Black Friday si está en curso y el método de
 * pago no está excluido; si no, la normal (DESCUENTO_ONLINE_PCT desde DESCUENTO_ONLINE_MINIMO).
 */
function reglaDescuento({ metodoPago, ahora } = {}) {
  const promo = promoActiva(ahora);
  if (promo && !promo.excluye.includes(String(metodoPago || ''))) {
    return { percent: promo.percent, minimo: promo.minimo, label: promo.etiqueta, tier: promo.tier };
  }
  return { percent: porcentajeDescuentoOnline(), minimo: minimoDescuentoOnline(), label: ETIQUETA, tier: 'ONLINE' };
}

/** Lo que la tienda pide a GET /api/descuento-online para mostrar el descuento antes de pagar. */
function configPublica(ahora = Date.now()) {
  const promo = promoActiva(ahora);
  const general = reglaDescuento({ ahora });
  return {
    percent: general.percent,
    minimo: general.minimo,
    normal: { percent: porcentajeDescuentoOnline(), minimo: minimoDescuentoOnline() },
    promo: promo ? { nombre: 'Black Friday', etiqueta: promo.etiqueta, excluye: promo.excluye, fin: new Date(promo.fin).toISOString() } : null,
  };
}

/**
 * Aplica el descuento a los artículos ya normalizados (precio del catálogo).
 * Devuelve los artículos con `onlinePrice` (precio unitario con descuento) y `onlineDiscount`
 * (descuento total de esa línea), más el resumen `discountApplied` (null si el porcentaje es 0).
 * `price` se conserva como el precio de lista, que es lo que el recibo muestra tachado.
 */
function aplicarDescuentoOnline(items, opciones = {}) {
  // Firma vieja (items, percent, minimo): se respeta por si algo la sigue usando.
  const regla =
    typeof opciones === 'number'
      ? { percent: opciones, minimo: arguments[2] ?? minimoDescuentoOnline(), label: ETIQUETA, tier: 'ONLINE' }
      : reglaDescuento(opciones);
  const { percent, minimo } = regla;
  const subtotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
  if (!percent || subtotal < minimo) {
    return { items, discountApplied: null };
  }
  const conDescuento = items.map((item) => {
    const onlinePrice = round2(item.price * (1 - percent / 100));
    const onlineDiscount = round2((item.price - onlinePrice) * item.quantity);
    return { ...item, onlinePrice, onlineDiscount };
  });
  const amount = round2(conDescuento.reduce((s, i) => s + i.onlineDiscount, 0));
  return {
    items: conDescuento,
    // `tier: 'ONLINE'` se mantiene por compatibilidad con lo que lee el panel en pedidos viejos.
    discountApplied: amount > 0 ? { tier: regla.tier, label: regla.label, percent, amount } : null,
  };
}

/** Texto de la línea de descuento — sirve también para pedidos viejos hechos con niveles. */
function etiquetaDescuento(discountApplied) {
  if (!discountApplied) return '';
  const nombre = discountApplied.label || `Descuento nivel ${discountApplied.tier}`;
  return `${nombre} (-${discountApplied.percent}%)`;
}

module.exports = { porcentajeDescuentoOnline, minimoDescuentoOnline, aplicarDescuentoOnline, reglaDescuento, configPublica, promoActiva, etiquetaDescuento, ETIQUETA_DESCUENTO_ONLINE: ETIQUETA };
