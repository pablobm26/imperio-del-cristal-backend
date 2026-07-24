// Cliente de Supabase con la service_role key (bypassea RLS) — SOLO para uso del backend, nunca
// exponer esta key al navegador. Calcula el nivel de fidelidad real de un usuario y registra
// compras que cuentan para ese nivel. Ver supabase/README.md para cómo configurar el proyecto.
//
// Mismo estilo tolerante que isPladeConfigured() en plade-marketplade-client.js: si faltan las
// env vars, isLoyaltyConfigured() da false y el checkout se degrada a comportamiento de invitado
// en vez de romperse — cuentas/fidelidad es una capa opcional sobre un sitio que ya funciona sin
// login.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function isLoyaltyConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

const supabaseAdmin = isLoyaltyConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

/**
 * Nivel de fidelidad REAL de un usuario, calculado en la base de datos
 * (get_loyalty_for_user, ver supabase/003_loyalty_functions.sql). Esta es la única fuente de
 * verdad del descuento — nunca confiar en un discountPercent que mande el navegador.
 */
async function getLoyaltyForUser(userId) {
  if (!supabaseAdmin) throw new Error('Supabase no está configurado (faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).');
  const { data, error } = await supabaseAdmin
    .rpc('get_loyalty_for_user', { p_user_id: userId })
    .single();
  if (error) throw new Error(`Supabase get_loyalty_for_user: ${error.message}`);
  return {
    spend12mo: Number(data.spend_12mo),
    tier: data.tier,
    discountPercent: Number(data.discount_percent),
  };
}

/**
 * Registra una compra que cuenta para el nivel de fidelidad. Best-effort: quien llame a esto debe
 * atrapar el error y no bloquear la respuesta del checkout si falla, mismo espíritu que
 * submitOrderToPlade() en server.js.
 */
async function recordPurchase({ userId, orderId, amountUsd, country }) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from('purchases').insert({
    user_id: userId,
    order_id: orderId,
    amount_usd: amountUsd,
    country,
  });
  if (error) throw new Error(`Supabase insert purchases: ${error.message}`);
}

module.exports = { isLoyaltyConfigured, getLoyaltyForUser, recordPurchase };
