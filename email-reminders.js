// Envío del recordatorio por correo de carritos abandonados (cart_reminders en Supabase, ver
// supabase/005_cart_reminders.sql y 006_cart_reminders_notify.sql). Usa la API REST de Resend
// directo con fetch (Node 18+ ya lo trae global) en vez de agregar el paquete `resend` como
// dependencia nueva. Mismo estilo tolerante que supabase-admin.js: si faltan las env vars,
// isCartReminderConfigured() da false y el panel de admin lo muestra como "no configurado" en vez
// de romperse.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CART_REMINDER_FROM_EMAIL = process.env.CART_REMINDER_FROM_EMAIL;
const STORE_URL = process.env.STORE_URL || 'https://cristal44.com';
const ABANDONED_AFTER_HOURS = 24;

function isCartReminderConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && RESEND_API_KEY && CART_REMINDER_FROM_EMAIL);
}

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Paleta de la marca (misma que tailwind.config.ts del frontend). Va escrita a mano y no importada
// porque este archivo corre en el backend, que no comparte build con la tienda.
const ORO = '#AB9E75';
const ORO_CLARO = '#C9BE97';
const NEGRO = '#0a0a0a';

/**
 * El correo se arma con tablas y estilos en línea, no con flexbox ni clases: Outlook y varios
 * clientes de escritorio ignoran las hojas de estilo y no entienden layout moderno. Es feo de
 * escribir pero es lo único que se ve igual en todas partes.
 *
 * El enlace apunta a /carrito y NO a /checkout como antes: el carrito vive en el navegador donde se
 * armó, así que si el cliente abre este correo desde el teléfono habiendo comprado en la
 * computadora, /checkout le mostraba "carrito vacío" y quedaba en la nada. /carrito es la pantalla
 * que ofrece recuperar lo guardado.
 */
function renderReminderEmail(items) {
  const total = items.reduce((suma, item) => suma + Number(item.price) * Number(item.quantity), 0);

  const filas = items
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e6e2d8;color:#2b2b2b;font-size:14px;">
            <strong style="font-weight:600;">${escapeHtml(item.title)}</strong><br>
            <span style="color:#7a7a7a;font-size:13px;">Cantidad: ${Number(item.quantity)}</span>
          </td>
          <td align="right" style="padding:10px 0;border-bottom:1px solid #e6e2d8;color:#2b2b2b;font-size:14px;white-space:nowrap;">
            $${(Number(item.price) * Number(item.quantity)).toFixed(2)}
          </td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f2ed;">
  <!-- Texto de vista previa: es lo que se lee en la bandeja antes de abrir. Oculto en el cuerpo. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Tu selección sigue guardada en El Imperio del Cristal.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ed;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e2d8;">

        <tr>
          <td align="center" style="background:${NEGRO};padding:24px 20px;">
            <img src="${STORE_URL}/logo-horizontal.jpg" alt="El Imperio del Cristal" width="200"
                 style="display:block;border:0;max-width:200px;height:auto;">
            <p style="margin:10px 0 0;color:${ORO_CLARO};font-size:12px;letter-spacing:1px;font-family:Georgia,'Times New Roman',serif;">
              ¡LO QUE PIENSAS, LO CREAS!
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:28px 24px 8px;font-family:Georgia,'Times New Roman',serif;">
            <h1 style="margin:0 0 8px;font-size:21px;color:${NEGRO};font-weight:normal;">
              Tu selección sigue guardada
            </h1>
            <p style="margin:0;font-size:15px;line-height:1.6;color:#4a4a4a;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              Apartaste estos productos y no llegaste a completar el pedido. Todavía te esperan.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                   style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              ${filas}
              <tr>
                <td style="padding:14px 0 0;font-size:15px;color:${NEGRO};font-weight:600;">Total</td>
                <td align="right" style="padding:14px 0 0;font-size:17px;color:${NEGRO};font-weight:700;white-space:nowrap;">
                  $${total.toFixed(2)}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:26px 24px 8px;">
            <a href="${STORE_URL}/carrito"
               style="display:inline-block;padding:13px 34px;background:${ORO};color:${NEGRO};text-decoration:none;border-radius:6px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;font-weight:600;">
              Ver mi carrito
            </a>
          </td>
        </tr>

        <tr>
          <td style="padding:4px 24px 26px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#8a8a8a;text-align:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              Los precios y la disponibilidad pueden cambiar: confirmamos todo al momento de tu compra.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#faf8f4;padding:18px 24px;border-top:1px solid #e6e2d8;">
            <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#7a7a7a;text-align:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              Recibes este correo porque dejaste una compra sin terminar en tu cuenta de
              <a href="${STORE_URL}" style="color:${ORO};text-decoration:none;">El Imperio del Cristal</a>.
            </p>
            <p style="margin:0;font-size:12px;line-height:1.6;color:#9a9a9a;text-align:center;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
              Si no quieres recibir estos avisos, respóndenos y dejamos de enviártelos.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Versión en texto plano. No es opcional: un correo que solo trae HTML puntúa peor en los filtros
 * de spam, y algunos clientes (y los relojes) muestran esto en vez del diseño.
 */
function renderReminderText(items) {
  const total = items.reduce((suma, item) => suma + Number(item.price) * Number(item.quantity), 0);
  const lineas = items
    .map((item) => `- ${item.quantity} x ${item.title}: $${(Number(item.price) * Number(item.quantity)).toFixed(2)}`)
    .join('\n');

  return `Tu selección sigue guardada — El Imperio del Cristal

Apartaste estos productos y no llegaste a completar el pedido:

${lineas}

Total: $${total.toFixed(2)}

Ver mi carrito: ${STORE_URL}/carrito

Los precios y la disponibilidad pueden cambiar: confirmamos todo al momento de tu compra.

Recibes este correo porque dejaste una compra sin terminar en tu cuenta.
Si no quieres recibir estos avisos, respóndenos y dejamos de enviártelos.`;
}

async function sendEmail(to, items) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // El nombre que se ve en la bandeja. Sin esto Gmail muestra solo la parte antes de la arroba
      // —"pedidos"—, que no dice nada y no construye marca. Si CART_REMINDER_FROM_EMAIL ya trae un
      // nombre entre comillas (formato `Nombre <correo@dominio>`), se respeta tal cual.
      from: CART_REMINDER_FROM_EMAIL.includes('<')
        ? CART_REMINDER_FROM_EMAIL
        : `El Imperio del Cristal <${CART_REMINDER_FROM_EMAIL}>`,
      to,
      subject: 'Retoma tu compra en cristal44.com',
      html: renderReminderEmail(items),
      text: renderReminderText(items),
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend respondió ${response.status}: ${body}`);
  }
}

/**
 * Busca carritos sin completar hace más de 24hs que todavía no recibieron un recordatorio, y les
 * manda un correo. Best-effort por fila: si falla el envío de un cliente puntual, sigue con el
 * resto y lo cuenta en `failed` en vez de frenar todo el lote.
 */
async function sendAbandonedCartReminders() {
  if (!isCartReminderConfigured()) {
    throw new Error('Recordatorio de carrito no configurado (faltan RESEND_API_KEY/CART_REMINDER_FROM_EMAIL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).');
  }

  const cutoff = new Date(Date.now() - ABANDONED_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const { data: reminders, error } = await supabaseAdmin
    .from('cart_reminders')
    .select('user_id, items, updated_at')
    .is('completed_at', null)
    .is('reminder_sent_at', null)
    .lt('updated_at', cutoff);
  if (error) throw new Error(`Supabase select cart_reminders: ${error.message}`);

  const result = { sent: 0, skipped: 0, failed: 0 };
  for (const reminder of reminders || []) {
    try {
      const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(reminder.user_id);
      const email = userData?.user?.email;
      if (userError || !email) {
        result.skipped += 1;
        continue;
      }
      await sendEmail(email, reminder.items);
      await supabaseAdmin
        .from('cart_reminders')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('user_id', reminder.user_id);
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
    }
  }
  return result;
}

module.exports = { isCartReminderConfigured, sendAbandonedCartReminders };
