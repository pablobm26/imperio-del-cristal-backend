/**
 * Compone el recibo de un pedido para una impresora térmica de rollo (ESC/POS).
 *
 * ESC/POS es el lenguaje que hablan casi todas las térmicas de punto de venta: se le manda el texto
 * mezclado con códigos de control ("centra", "negrita", "corta el papel"). No lleva controlador ni
 * fuentes: por eso imprime en un segundo y por eso el recibo hay que armarlo carácter a carácter.
 *
 * **El recibo se compone en el SERVIDOR, no en el agente de la tienda.** El agente solo recibe
 * bytes y los escupe a la impresora. Así, cambiar el formato —mover el total, agregar una línea— se
 * hace acá y ya; si la maquetación viviera en el agente, cada ajuste obligaría a reinstalar el
 * programa en la PC de la tienda.
 *
 * **La vista previa y lo que se imprime salen de la MISMA descripción** (`componer()`): una emite
 * bytes y la otra texto. Es a propósito — una previsualización que se construye por su cuenta
 * termina mintiendo en cuanto alguien toca una de las dos.
 */

'use strict';

// --- Códigos ESC/POS ---
const ESC = 0x1b;
const GS = 0x1d;
const INICIALIZAR = Buffer.from([ESC, 0x40]);
const ALINEAR = (n) => Buffer.from([ESC, 0x61, n]); // 0 izquierda, 1 centro, 2 derecha
const NEGRITA = (on) => Buffer.from([ESC, 0x45, on ? 1 : 0]);
// GS ! n — el byte alto es el ancho y el bajo el alto. 0x11 = doble en ambos.
const TAMANO = (doble) => Buffer.from([GS, 0x21, doble ? 0x11 : 0x00]);
const AVANCE = (n) => Buffer.from([ESC, 0x64, n]); // avanza n líneas
// GS V 66 n — corte parcial tras avanzar n puntos. El avance evita que el corte caiga sobre la
// última línea: el cabezal y la cuchilla están separados unos milímetros en el chasis.
const CORTAR = Buffer.from([GS, 0x56, 66, 0x00]);

/**
 * Ancho del papel en caracteres. Es lo único que cambia entre los dos tamaños de rollo que se ven
 * en tiendas, y se equivoca fácil: con 48 en un rollo de 58mm cada línea se parte a la mitad.
 */
const ANCHOS = { 58: 32, 80: 48 };

/**
 * Quita acentos y eñes.
 *
 * No es descuido: las térmicas traen tablas de caracteres distintas según marca y hasta según lote,
 * y la que trae acentos no siempre es la que viene activa de fábrica. Un recibo que dice
 * "PRODUCCI?N" o "MU�OZ" se ve roto y no hay forma de saber de antemano cuál tabla tiene el aparato
 * del cliente. En ASCII imprime bien en todas.
 *
 * Se puede desactivar (`acentos: true`) cuando ya se probó que la impresora concreta los soporta.
 */
function sinAcentos(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ñÑ]/g, (c) => (c === 'ñ' ? 'n' : 'N'))
    .replace(/[^\x20-\x7e\n]/g, '');
}

/** Parte un texto largo en líneas que quepan, sin cortar palabras por la mitad. */
function envolver(texto, ancho) {
  const palabras = String(texto ?? '').split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const palabra of palabras) {
    // Una palabra sola más larga que el renglón (un código raro) se parte a la fuerza: preferible a
    // que la impresora la corte donde le parezca.
    if (palabra.length > ancho) {
      if (actual) { lineas.push(actual); actual = ''; }
      for (let i = 0; i < palabra.length; i += ancho) lineas.push(palabra.slice(i, i + ancho));
      continue;
    }
    if (!actual) actual = palabra;
    else if (actual.length + 1 + palabra.length <= ancho) actual += ` ${palabra}`;
    else { lineas.push(actual); actual = palabra; }
  }
  if (actual) lineas.push(actual);
  return lineas.length > 0 ? lineas : [''];
}

/** "Camisa azul" + "$12,00" separados hasta los bordes del papel. */
function aDosColumnas(izquierda, derecha, ancho) {
  const izq = String(izquierda ?? '');
  const der = String(derecha ?? '');
  const hueco = ancho - der.length;
  if (hueco < 1) return `${izq}\n${der.padStart(ancho)}`;
  const recortada = izq.length > hueco - 1 ? `${izq.slice(0, hueco - 2)}.` : izq;
  return recortada + ' '.repeat(Math.max(1, ancho - recortada.length - der.length)) + der;
}

const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const bolivares = (usd, tasa) =>
  tasa ? `Bs ${(Number(usd) * Number(tasa)).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

/** Fecha y hora de Venezuela, que es donde está la tienda y quien lee el papel. */
function fechaVenezuela(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d);
}

/**
 * Describe el recibo como una lista de instrucciones, sin decidir todavía si acaba en bytes o en
 * texto. Es el único sitio donde vive la maquetación.
 */
function componer(pedido, ancho) {
  const t = [];
  const texto = (contenido, opciones = {}) => t.push({ tipo: 'texto', contenido, ...opciones });
  const separador = (caracter = '-') => t.push({ tipo: 'separador', caracter });
  const vacio = (n = 1) => t.push({ tipo: 'vacio', n });

  // --- Encabezado ---
  texto('EL IMPERIO DEL CRISTAL', { alineacion: 'centro', negrita: true, doble: true });
  texto('Bisuteria y accesorios', { alineacion: 'centro' });
  vacio();

  // El número de pedido va grande porque es el dato que se busca a distancia, con el papel en la
  // mano y varios recibos sobre el mostrador.
  texto(`PEDIDO ${pedido.orderId || ''}`, { alineacion: 'centro', negrita: true, doble: true });
  texto(fechaVenezuela(pedido.createdAt), { alineacion: 'centro' });
  separador('=');

  // --- Cliente ---
  if (pedido.nombre) texto(`Cliente: ${pedido.nombre}`);
  if (pedido.cedula) texto(`CI: ${pedido.cedula}`);
  if (pedido.telefono) texto(`Tel: ${pedido.telefono}`);

  // --- Entrega ---
  const entrega = [pedido.deliveryMethod, pedido.deliveryZone].filter(Boolean).join(' - ');
  if (entrega) texto(`Entrega: ${entrega}`);
  const donde = [pedido.parroquia, pedido.ciudad, pedido.estado].filter(Boolean).join(', ');
  if (donde) texto(`Destino: ${donde}`);

  // --- Pago ---
  if (pedido.paymentMethod) texto(`Pago: ${pedido.paymentMethod}`);
  if (pedido.reference) texto(`Referencia: ${pedido.reference}`);
  if (pedido.paymentHolderName) texto(`Titular: ${pedido.paymentHolderName}`);
  separador();

  // --- Artículos ---
  texto('ARTICULOS', { negrita: true });
  separador();
  let unidades = 0;
  for (const item of pedido.items || []) {
    const cantidad = Number(item.quantity) || 0;
    unidades += cantidad;
    // El nombre en su propia línea y la cuenta debajo: con nombres de 40 caracteres, meter todo en
    // un renglón obliga a recortar el nombre justo donde se distinguen dos productos parecidos.
    texto(`${item.title || item.id || ''}`);
    const detalle = `${cantidad} x ${dinero(item.price)}`;
    texto(aDosColumnas(`  ${item.id ? `[${item.id}] ` : ''}${detalle}`, dinero(cantidad * (Number(item.price) || 0)), ancho), { crudo: true });
  }
  separador();

  // --- Totales ---
  const subtotal = (pedido.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
  texto(aDosColumnas(`Subtotal (${unidades} pza${unidades === 1 ? '' : 's'})`, dinero(subtotal), ancho), { crudo: true });
  if (pedido.deliveryFee) texto(aDosColumnas('Envio', dinero(pedido.deliveryFee), ancho), { crudo: true });
  if (pedido.discountApplied) {
    texto(aDosColumnas(`Descuento ${pedido.discountApplied}%`, `-${dinero(subtotal * (Number(pedido.discountApplied) / 100))}`, ancho), { crudo: true });
  }
  separador('=');
  texto(aDosColumnas('TOTAL', dinero(pedido.total), ancho), { crudo: true, negrita: true });
  const enBs = bolivares(pedido.total, pedido.bcvRate);
  if (enBs) texto(aDosColumnas('', enBs, ancho), { crudo: true });
  separador('=');

  // --- Pie ---
  vacio();
  texto('Gracias por tu compra', { alineacion: 'centro' });
  texto('cristal44.com', { alineacion: 'centro' });
  vacio(2);
  t.push({ tipo: 'corte' });
  return t;
}

/** Aplica el ancho y los acentos, y devuelve los renglones ya listos con su estilo. */
function aRenglones(instrucciones, ancho, acentos) {
  const limpiar = (s) => (acentos ? String(s ?? '') : sinAcentos(s));
  const salida = [];
  for (const ins of instrucciones) {
    if (ins.tipo === 'separador') { salida.push({ texto: ins.caracter.repeat(ancho) }); continue; }
    if (ins.tipo === 'vacio') { for (let i = 0; i < ins.n; i++) salida.push({ texto: '' }); continue; }
    if (ins.tipo === 'corte') { salida.push({ corte: true }); continue; }

    // A doble tamaño caben la mitad de caracteres: envolver con el ancho normal desbordaría.
    const anchoUtil = ins.doble ? Math.floor(ancho / 2) : ancho;
    const partes = ins.crudo ? [limpiar(ins.contenido)] : envolver(limpiar(ins.contenido), anchoUtil);
    for (const parte of partes) {
      salida.push({ texto: parte, alineacion: ins.alineacion, negrita: ins.negrita, doble: ins.doble });
    }
  }
  return salida;
}

/**
 * Los bytes que se le mandan a la impresora.
 *
 * @param {object} pedido
 * @param {{ anchoPapel?: 58|80, acentos?: boolean, cortar?: boolean, copias?: number }} opciones
 */
function construirRecibo(pedido, opciones = {}) {
  const ancho = ANCHOS[opciones.anchoPapel] || ANCHOS[80];
  const renglones = aRenglones(componer(pedido, ancho), ancho, Boolean(opciones.acentos));
  const partes = [INICIALIZAR];

  for (const r of renglones) {
    if (r.corte) {
      // Sin cuchilla el comando no molesta, pero se puede apagar para las que cortan a mano.
      if (opciones.cortar !== false) partes.push(AVANCE(3), CORTAR);
      continue;
    }
    partes.push(ALINEAR(r.alineacion === 'centro' ? 1 : r.alineacion === 'derecha' ? 2 : 0));
    if (r.negrita) partes.push(NEGRITA(true));
    if (r.doble) partes.push(TAMANO(true));
    partes.push(Buffer.from(`${r.texto}\n`, 'ascii'));
    if (r.doble) partes.push(TAMANO(false));
    if (r.negrita) partes.push(NEGRITA(false));
  }

  const uno = Buffer.concat(partes);
  const copias = Math.min(Math.max(parseInt(opciones.copias, 10) || 1, 1), 3);
  return copias === 1 ? uno : Buffer.concat(Array(copias).fill(uno));
}

/**
 * El MISMO recibo en texto plano, para verlo en el panel sin gastar papel.
 *
 * Sale de `componer()`, igual que la versión que se imprime: si alguien cambia la maquetación, la
 * vista previa cambia sola. Lo que no puede reflejar es el doble tamaño —en pantalla se marca con
 * un margen— ni el corte del papel.
 */
function previsualizarRecibo(pedido, opciones = {}) {
  const ancho = ANCHOS[opciones.anchoPapel] || ANCHOS[80];
  const renglones = aRenglones(componer(pedido, ancho), ancho, Boolean(opciones.acentos));
  return renglones
    .map((r) => {
      if (r.corte) return `${'>'.repeat(ancho)}\n[ aqui corta el papel ]`;
      let linea = r.texto;
      if (r.alineacion === 'centro') linea = linea.padStart(Math.floor((ancho - linea.length) / 2) + linea.length);
      else if (r.alineacion === 'derecha') linea = linea.padStart(ancho);
      return linea.replace(/\s+$/, '');
    })
    .join('\n');
}

module.exports = { construirRecibo, previsualizarRecibo, ANCHOS };
