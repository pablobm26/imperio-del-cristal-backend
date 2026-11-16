// Espejo de tienda_web/lib/payment-info.ts — usado solo por chat.js para que el asistente de IA
// pueda dar los datos de pago exactos. Hay que actualizar los dos archivos a la vez si cambian
// (no se pudo compartir uno solo: son dos proyectos/runtimes separados).
module.exports = {
  zelleEmail: 'gior09pacia@gmail.com',
  zelleHolder: 'GIORMARY PACIA',
  zinliEmail: 'fabiannopacia@gmail.com',
  binancePayId: '1088198677',
  binancePayEmail: 'fabiannopacia@gmail.com',
  // WhatsApp de atención al cliente. Espejo de tienda_web/lib/social-links.ts (ahí está la fuente
  // de verdad). Antes chat.js usaba el teléfono del Pago Móvil para esto, que es otra cosa: es el
  // número de una cuenta bancaria, no el de soporte.
  soporteWhatsapp: '+58 424-4576249',
  // Cashea en pausa mientras se completa la afiliación del comercio. Mientras el aviso no esté
  // vacío, chat.js lo anuncia como «próximamente» y el servidor rechaza un pedido con ese método
  // (la lista del checkout lo deshabilita, pero una petición hecha a mano no pasa por ahí).
  casheaPausaAviso: 'Activo en los próximos días, en proceso de afiliación',
  // Pago Movil: dos cuentas, una activa a la vez, y mandan las fechas (ver payment-info.ts, que
  // es el espejo de esto). Hasta el 01/01/2027 cobra la personal de Banesco; a partir de ahi
  // vuelve la juridica de Mercantil.
  pagoMovilJuridicoDesde: '2027-01-01T04:00:00Z',
  pagoMovilJuridicoPhone: '0414-5633683',
  pagoMovilJuridicoRif: 'J-50215248-2',
  pagoMovilJuridicoBank: 'MERCANTIL (0105)',
  pagoMovilJuridicoHolder: 'EL IMPERIO DEL CRISTAL 44, C.A.',
  // Cuenta PERSONAL (cedula), no de la empresa: el chat no debe presentarla como tal.
  pagoMovilBanescoHasta: '2027-01-01T04:00:00Z',
  pagoMovilPhone: '0412-7246239',
  pagoMovilCedula: 'V-13810097',
  pagoMovilBank: 'BANESCO (0134)',
};
