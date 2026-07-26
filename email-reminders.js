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

function renderReminderEmail(items) {
  const itemsHtml = items
    .map((item) => `<li>${item.quantity} x ${escapeHtml(item.title)} — $${Number(item.price).toFixed(2)}</li>`)
    .join('');
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #222;">
      <h2>Dejaste algo en tu carrito</h2>
      <p>Todavía tenemos estos productos guardados para vos en El Imperio del Cristal:</p>
      <ul>${itemsHtml}</ul>
      <p>
        <a href="${STORE_URL}/checkout" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">
          Terminar mi compra
        </a>
      </p>
    </div>
  `;
}

async function sendEmail(to, items) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: CART_REMINDER_FROM_EMAIL,
      to,
      subject: 'Dejaste algo en tu carrito - El Imperio del Cristal',
      html: renderReminderEmail(items),
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
