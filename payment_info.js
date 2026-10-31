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
  // Pago Móvil jurídico (Mercantil). Mismo teléfono que el Banesco de abajo a propósito: una sola
  // línea afiliada a las dos cuentas. Si quedan vacíos, chat.js no menciona el método.
  pagoMovilJuridicoPhone: '0414-5633683',
  pagoMovilJuridicoRif: 'J-50215248-2',
  pagoMovilJuridicoBank: 'MERCANTIL (0105)',
  pagoMovilJuridicoHolder: 'EL IMPERIO DEL CRISTAL 44, C.A.',
  // Pago Móvil personal (Banesco) — segunda opción.
  // Corte del Banesco personal: 31/10/2026 10:00pm hora Venezuela. Después chat.js deja de darlo.
  pagoMovilBanescoHasta: '2026-11-01T02:00:00Z',
  pagoMovilPhone: '0414-5633683',
  pagoMovilCedula: 'V-13818713',
  pagoMovilBank: 'BANESCO (0134)',
};
