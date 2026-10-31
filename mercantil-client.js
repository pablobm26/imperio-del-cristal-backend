// Cliente de las APIs de Mercantil Banco. Dos operaciones, que son dos formas distintas de cobrar:
//
//   1. buscarPagoMovil()  POST /mobile-payment/search  — REACTIVA. El cliente ya hizo el Pago
//      Móvil desde su banco y nosotros preguntamos "¿entró este pago?". Sirve para dejar de
//      revisar comprobantes a mano, pero el cliente igual se va de la tienda a pagar.
//
//   2. cobrarC2P()        POST /payment/c2p           — ACTIVA. El cliente no se va a ningún
//      lado: escribe su teléfono, su cédula, su banco y una clave temporal que pide por los
//      canales de SU banco, y el cobro se ejecuta en línea con respuesta inmediata. Esto es lo
//      que de verdad automatiza el pago móvil. Requiere estar afiliado al servicio C2P.
//
//   anularC2P() revierte un cobro C2P con su referencia.
//
// Propuesta completa (vías, arquitectura y reglas de conciliación): PROPUESTA-PAGO-MOVIL-MERCANTIL.md
// en la raíz del proyecto. El algoritmo de cifrado y la forma de cada request salen del código
// oficial del banco (github.com/apimercantil/api-playground), no de documentación de terceros.
//
// ESTE MÓDULO NO ESTÁ CONECTADO AL CHECKOUT TODAVÍA. Es la pieza sin estado de la Vía B; falta la
// máquina de estados del pedido (crear → verificar → facturar), que es la parte delicada porque hoy
// crear el pedido ya factura en PLADE. Mientras `isMercantilConfigured()` dé false, nada de esto
// corre: el checkout sigue con la confirmación manual de siempre.
//
// ⚠️ EL REPOSITORIO ES PÚBLICO. Las cinco credenciales van SOLO en variables de entorno de Render.
// El clientId es, por sí solo, la autenticación entera del comercio: quien lo tenga puede llamar a
// la API en nombre de Imperio del Cristal. Nunca puede salir del servidor ni llegar al navegador.

const crypto = require('crypto');

// Sandbox por defecto a propósito: que una variable sin configurar nunca apunte a producción.
const MERCANTIL_BASE_URL =
  process.env.MERCANTIL_BASE_URL || 'https://apimbu.mercantilbanco.com/mercantil-banco/sandbox/v1';

const TIMEOUT_MS = 20000;

function credentialsFromEnv() {
  const clientId = process.env.MERCANTIL_CLIENT_ID;
  const merchantId = process.env.MERCANTIL_MERCHANT_ID;
  const integratorId = process.env.MERCANTIL_INTEGRATOR_ID;
  const terminalId = process.env.MERCANTIL_TERMINAL_ID;
  const secretKey = process.env.MERCANTIL_SECRET_KEY;
  if (!clientId || !merchantId || !integratorId || !terminalId || !secretKey) {
    throw new Error(
      'Faltan credenciales de Mercantil: MERCANTIL_CLIENT_ID, MERCANTIL_MERCHANT_ID, ' +
        'MERCANTIL_INTEGRATOR_ID, MERCANTIL_TERMINAL_ID y MERCANTIL_SECRET_KEY.'
    );
  }
  return { clientId, merchantId, integratorId, terminalId, secretKey };
}

function isMercantilConfigured() {
  return Boolean(
    process.env.MERCANTIL_CLIENT_ID &&
      process.env.MERCANTIL_MERCHANT_ID &&
      process.env.MERCANTIL_INTEGRATOR_ID &&
      process.env.MERCANTIL_TERMINAL_ID &&
      process.env.MERCANTIL_SECRET_KEY
  );
}

/**
 * Cifrado de los campos sensibles (cédula/RIF, teléfonos, clave de pago).
 *
 * Copiado tal cual del ejemplo oficial de Mercantil: AES-128-ECB sin IV, con la llave armada a
 * partir de `SHA-256(secretKey)` en hexadecimal, tomando **la primera mitad de esa cadena hex**
 * (32 caracteres = 16 bytes). La salida va en Base64.
 *
 * No parece un cifrado moderno y no lo es (ECB, sin IV, sin autenticación), pero es exactamente el
 * que el banco espera: cambiarlo "para mejorarlo" hace que el gateway rechace todo.
 */
function encrypt(message, secretKey) {
  const hash = crypto.createHash('sha256');
  hash.update(secretKey);
  const keyString = hash.copy().digest('hex');
  const firstHalf = keyString.slice(0, keyString.length / 2);
  const keyHex = Buffer.from(firstHalf, 'hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', keyHex, null);
  return cipher.update(message, 'utf8', 'base64') + cipher.final('base64');
}

/**
 * Teléfono al formato del banco: `58` + operadora + número, sin guiones ni cero inicial.
 * `0414-5633683` → `584145633683`. Si no quedan 10 dígitos después de quitar el 0, es un número
 * que el banco no va a encontrar, así que se corta acá en vez de mandar basura cifrada.
 */
function formatPhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('58')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length !== 10) {
    throw new Error(`Teléfono con formato inesperado para Mercantil: "${phone}"`);
  }
  return `58${digits}`;
}

/** Cédula o RIF con su letra y sin guiones: `V-13818713` → `V13818713`, `J-12345678-9` → `J123456789`. */
function formatId(id) {
  const limpio = String(id ?? '')
    .toUpperCase()
    .replace(/[^0-9VEJPG]/g, '');
  if (!/^[VEJPG]\d{6,10}$/.test(limpio)) {
    throw new Error(`Cédula/RIF con formato inesperado para Mercantil: "${id}"`);
  }
  return limpio;
}

/** Fecha en `YYYY-MM-DD` según el huso de Venezuela, que es el que ve el banco. */
function fechaVenezuela(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Busca un Pago Móvil recibido en la cuenta del comercio.
 *
 * ⚠️ LOS NOMBRES ESTÁN AL REVÉS DE LO QUE UNO SUPONE. En el código oficial del banco,
 * `destination_*` es **el cliente** (quien envía el pago) y `origin_*` es **el comercio**. Ponerlo
 * al revés no da error de validación: simplemente no encuentra nada, que es el peor síntoma posible.
 *
 * @param {object} p
 * @param {number} p.montoBs         Monto EXACTO en bolívares que se le mostró al cliente. No
 *                                   recalcular con la tasa de hoy: si la tasa cambió, la búsqueda
 *                                   falla por céntimos.
 * @param {string} p.referencia      Referencia del pago (el checkout pide los últimos 6 dígitos).
 * @param {string} p.telefonoCliente Teléfono desde el que pagó el cliente.
 * @param {string} [p.cedulaCliente] Cédula del cliente; se manda cifrada solo si viene.
 * @param {string} [p.fecha]         `YYYY-MM-DD`. Por defecto, hoy en Venezuela.
 * @returns {Promise<{ok: boolean, encontrado: boolean, respuesta: any, error?: string}>}
 */
async function buscarPagoMovil({ montoBs, referencia, telefonoCliente, cedulaCliente, fecha }) {
  const { clientId, merchantId, integratorId, terminalId, secretKey } = credentialsFromEnv();

  if (!Number.isFinite(Number(montoBs)) || Number(montoBs) <= 0) {
    throw new Error('buscarPagoMovil necesita un monto en bolívares mayor que cero.');
  }
  if (!String(referencia ?? '').trim()) {
    throw new Error('buscarPagoMovil necesita la referencia del pago.');
  }

  const telefonoComercio = process.env.MERCANTIL_MERCHANT_PHONE;
  if (!telefonoComercio) {
    throw new Error('Falta MERCANTIL_MERCHANT_PHONE (el teléfono afiliado de la cuenta jurídica).');
  }

  const search_by = {
    amount: Number(Number(montoBs).toFixed(2)),
    currency: 'ves',
    // destination = CLIENTE, origin = COMERCIO. Ver la advertencia de arriba.
    destination_mobile_number: encrypt(formatPhone(telefonoCliente), secretKey),
    origin_mobile_number: encrypt(formatPhone(telefonoComercio), secretKey),
    payment_reference: String(referencia).trim(),
    trx_date: fecha || fechaVenezuela(),
  };
  // OJO: el ejemplo oficial de /mobile-payment/search NO manda `destination_id`. Se deja detrás de
  // una variable porque mandar un campo que el API no espera es una forma conocida de que la
  // búsqueda no devuelva nada, y eso se ve igual que "el pago no existe".
  // Ver search-c2p/modules/searchC2p.js en github.com/apimercantil/api-playground.
  if (cedulaCliente && process.env.MERCANTIL_SEARCH_WITH_ID === '1') {
    search_by.destination_id = encrypt(formatId(cedulaCliente), secretKey);
  }
  // La colección de Postman del banco escribe este campo con una "n" de más
  // (`destinantion_mobile_number`). El código oficial del playground usa el nombre correcto, así
  // que lo más probable es que el typo esté en la documentación; se deja la variable por si el
  // gateway de certificación resulta esperar el nombre con el error.
  if (process.env.MERCANTIL_TYPO_DESTINATION === '1') {
    search_by.destinantion_mobile_number = search_by.destination_mobile_number;
    delete search_by.destination_mobile_number;
  }

  const body = {
    merchant_identify: {
      integratorId: Number(integratorId),
      merchantId: Number(merchantId),
      terminalId: String(terminalId),
    },
    client_identify: {
      ipaddress: '127.0.0.1',
      browser_agent: 'cristal44-backend',
      mobile: { manufacturer: 'server' },
    },
    search_by,
  };

  let res;
  let payload;
  try {
    res = await fetch(`${MERCANTIL_BASE_URL}/mobile-payment/search`, {
      method: 'POST',
      headers: { 'X-IBM-Client-ID': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    payload = await res.json().catch(() => null);
  } catch (err) {
    // Un problema de red NO es un pago rechazado. Quien llame a esto tiene que reintentar y, si
    // nunca responde, dejar el pedido en revisión manual — nunca perder la venta.
    return { ok: false, encontrado: false, respuesta: null, error: `Red/timeout: ${err.message}` };
  }

  if (!res.ok) {
    return {
      ok: false,
      encontrado: false,
      respuesta: payload,
      error: `HTTP ${res.status}: ${payload?.error_list?.[0]?.description || res.statusText}`,
    };
  }

  // La forma exacta de la respuesta (y la lista de códigos de error) está detrás del login del
  // portal del banco y hay que fijarla en la fase de sandbox — ver la propuesta, sección 2.1. Por
  // eso acá no se asume ninguna estructura: se devuelve cruda y se marca "encontrado" solo si el
  // banco trae algo reconocible. Quien concilie decide con `respuesta` en la mano.
  const encontrado = Boolean(
    payload && (payload.transaction_list?.length > 0 || payload.payment_reference || payload.amount)
  );
  return { ok: true, encontrado, respuesta: payload };
}

// --------------------------------------------------------------------------------------------
// C2P: cobrar en línea, sin comprobante
// --------------------------------------------------------------------------------------------

/**
 * Códigos de respuesta del API de C2P, según api_c2p_tipo_de_errores_0.pdf del banco.
 *
 * ⚠️ EL 401 NO ES UN PROBLEMA DE CREDENCIALES. El banco devuelve 401 para rechazos de NEGOCIO:
 * fondos insuficientes, clave temporal errada, límite diario excedido, banco no afiliado, cédula
 * o teléfono que no corresponden. Tratarlo como "mis credenciales están mal" lleva a reintentar
 * y a alertar al dueño por un cliente que simplemente no tenía saldo.
 */
const C2P_APROBADO = '0000';

function clasificarRespuestaC2P(status, payload) {
  const codigo = payload?.error_list?.[0]?.code || payload?.code || null;
  const descripcion = payload?.error_list?.[0]?.description || payload?.description || null;
  if (status === 200 && (!codigo || codigo === C2P_APROBADO)) {
    return { resultado: 'aprobado', codigo: codigo || C2P_APROBADO, descripcion };
  }
  if (status === 401) {
    // Rechazo del banco emisor. El pedido NO se cobró; hay que dejar que el cliente reintente.
    return { resultado: 'rechazado', codigo, descripcion };
  }
  if (status === 400) {
    // Nuestra mensajería está mal armada: es un bug nuestro, no del cliente.
    return { resultado: 'mensaje_invalido', codigo, descripcion };
  }
  return { resultado: 'error_banco', codigo, descripcion };
}

/**
 * Cobra (o anula) por Pago Móvil C2P. El dinero se mueve en esta llamada: no es una consulta.
 *
 * @param {object} p
 * @param {number} p.montoBs          Monto en bolívares. Separador decimal ".".
 * @param {string} p.telefonoCliente  Teléfono afiliado del cliente pagador.
 * @param {string} p.cedulaCliente    Cédula/RIF del cliente pagador (V12345678).
 * @param {number|string} p.bancoCliente Código del banco donde está afiliado ESE teléfono.
 * @param {string} p.claveC2P         Clave temporal de compra que el cliente pide a su banco.
 * @param {string} p.invoiceNumber    Nuestro identificador del pedido. Es lo único que después
 *                                    permite amarrar el movimiento bancario con la venta.
 * @param {string} [p.ipCliente]      IP del cliente pagador (el banco la exige).
 * @param {string} [p.navegadorCliente]
 * @param {('compra'|'anulacion')} [p.tipo]
 * @param {string} [p.referencia]     Referencia del cobro original; obligatoria si tipo=anulacion.
 * @returns {Promise<{ok:boolean, resultado:string, codigo:string|null, descripcion:string|null,
 *                     referencia:string|null, respuesta:any, error?:string}>}
 */
async function cobrarC2P({
  montoBs,
  telefonoCliente,
  cedulaCliente,
  bancoCliente,
  claveC2P,
  invoiceNumber,
  ipCliente,
  navegadorCliente,
  tipo = 'compra',
  referencia,
}) {
  const { clientId, merchantId, integratorId, terminalId, secretKey } = credentialsFromEnv();

  if (!Number.isFinite(Number(montoBs)) || Number(montoBs) <= 0) {
    throw new Error('cobrarC2P necesita un monto en bolívares mayor que cero.');
  }
  if (!invoiceNumber) {
    throw new Error('cobrarC2P necesita invoice_number: es lo que amarra el cobro con el pedido.');
  }
  if (!bancoCliente) {
    throw new Error('cobrarC2P necesita el código del banco del cliente (destination_bank_id).');
  }
  if (tipo === 'compra' && !claveC2P) {
    throw new Error('cobrarC2P necesita la clave temporal de compra del cliente.');
  }
  if (tipo === 'anulacion' && !referencia) {
    throw new Error('Una anulación necesita la referencia del cobro original.');
  }

  const telefonoComercio = process.env.MERCANTIL_MERCHANT_PHONE;
  if (!telefonoComercio) {
    throw new Error('Falta MERCANTIL_MERCHANT_PHONE (el teléfono afiliado de la cuenta jurídica).');
  }

  const body = {
    merchant_identify: {
      integratorId: Number(integratorId),
      merchantId: Number(merchantId),
      terminalId: String(terminalId),
    },
    client_identify: {
      // El banco pide la IP del CLIENTE PAGADOR, no la del servidor. Si se manda la del servidor,
      // todos los cobros salen desde la misma IP y el banco lo puede leer como fraude.
      ipaddress: ipCliente || '127.0.0.1',
      browser_agent: String(navegadorCliente || 'cristal44').slice(0, 80),
      mobile: { manufacturer: 'web' },
    },
    transaction_c2p: {
      amount: Number(Number(montoBs).toFixed(2)),
      currency: 'ves',
      // destination = CLIENTE (a quien se le cobra), origin = COMERCIO (quien cobra).
      destination_bank_id: Number(String(bancoCliente).replace(/\D/g, '')),
      destination_id: encrypt(formatId(cedulaCliente), secretKey),
      destination_mobile_number: encrypt(formatPhone(telefonoCliente), secretKey),
      origin_mobile_number: encrypt(formatPhone(telefonoComercio), secretKey),
      payment_reference: tipo === 'anulacion' ? String(referencia) : '',
      trx_type: tipo,
      payment_method: 'c2p',
      invoice_number: String(invoiceNumber),
      twofactor_auth: tipo === 'compra' ? encrypt(String(claveC2P), secretKey) : '',
    },
  };

  let res;
  let payload;
  try {
    res = await fetch(`${MERCANTIL_BASE_URL}/payment/c2p`, {
      method: 'POST',
      headers: { 'X-IBM-Client-ID': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    payload = await res.json().catch(() => null);
  } catch (err) {
    // ⚠️ UN TIMEOUT NO ES UN COBRO FALLIDO. La petición pudo haber llegado y el dinero pudo
    // haberse movido: quien llame a esto NO puede reintentar a ciegas ni dar el pedido por
    // impago. Hay que consultar con buscarPagoMovil() usando el mismo monto antes de decidir.
    return {
      ok: false,
      resultado: 'indeterminado',
      codigo: null,
      descripcion: null,
      referencia: null,
      respuesta: null,
      error: `Red/timeout: ${err.message}`,
    };
  }

  const { resultado, codigo, descripcion } = clasificarRespuestaC2P(res.status, payload);
  return {
    ok: resultado === 'aprobado',
    resultado,
    codigo,
    descripcion,
    referencia: payload?.transaction_c2p?.payment_reference || payload?.payment_reference || null,
    respuesta: payload,
  };
}

module.exports = {
  MERCANTIL_BASE_URL,
  isMercantilConfigured,
  encrypt,
  formatPhone,
  formatId,
  fechaVenezuela,
  buscarPagoMovil,
  cobrarC2P,
  clasificarRespuestaC2P,
  C2P_APROBADO,
};
