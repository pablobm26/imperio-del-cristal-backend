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
 * Aplica el descuento a los artículos ya normalizados (precio del catálogo).
 * Devuelve los artículos con `onlinePrice` (precio unitario con descuento) y `onlineDiscount`
 * (descuento total de esa línea), más el resumen `discountApplied` (null si el porcentaje es 0).
 * `price` se conserva como el precio de lista, que es lo que el recibo muestra tachado.
 */
function aplicarDescuentoOnline(items, percent = porcentajeDescuentoOnline(), minimo = minimoDescuentoOnline()) {
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
    discountApplied: amount > 0 ? { tier: 'ONLINE', label: ETIQUETA, percent, amount } : null,
  };
}

/** Texto de la línea de descuento — sirve también para pedidos viejos hechos con niveles. */
function etiquetaDescuento(discountApplied) {
  if (!discountApplied) return '';
  const nombre = discountApplied.label || `Descuento nivel ${discountApplied.tier}`;
  return `${nombre} (-${discountApplied.percent}%)`;
}

module.exports = { porcentajeDescuentoOnline, minimoDescuentoOnline, aplicarDescuentoOnline, etiquetaDescuento, ETIQUETA_DESCUENTO_ONLINE: ETIQUETA };
