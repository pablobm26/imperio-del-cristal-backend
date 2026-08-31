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
 * Se cumple cuando la función RPC todavía no existe en la base — es decir, cuando la migración
 * correspondiente no se corrió. Las migraciones las corre el dueño a mano y el deploy puede llegar
 * antes: sin este chequeo, una pantalla nueva devolvería 500 en vez de decir qué falta. Mismo
 * espíritu que isMissingColumn() en admin-users.js, escrito tras el incidente del 2026-08-09.
 * PostgREST responde PGRST202 si el RPC no está en el esquema expuesto; Postgres, 42883.
 */
function isMissingFunction(error) {
  return Boolean(error) && (error.code === 'PGRST202' || error.code === '42883');
}

/**
 * Nivel de fidelidad de TODOS los clientes de una vez, para la pantalla "Niveles de clientes" del
 * panel (ver supabase/012_admin_loyalty_levels.sql). Un solo viaje a la base: agrupar por usuario
 * llamando a getLoyaltyForUser() en un bucle sería una consulta por cliente.
 *
 * Los umbrales NO se recalculan acá. Viven en _loyalty_tier_for (supabase/003) y la función los
 * reusa, así ajustar un umbral sigue siendo editar un solo archivo SQL.
 *
 * Devuelve null si falta la migración, para que quien llame lo distinga de "no hay clientes".
 */
async function listLoyaltyLevels() {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.rpc('admin_loyalty_levels');
  if (isMissingFunction(error)) return null;
  if (error) throw new Error(`Supabase admin_loyalty_levels: ${error.message}`);
  return (data || []).map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    email: r.email,
    registeredAt: r.registered_at,
    spend12mo: Number(r.spend_12mo),
    orders12mo: Number(r.orders_12mo),
    lastPurchaseAt: r.last_purchase_at,
    tier: r.tier,
    discountPercent: Number(r.discount_percent),
    nextTier: r.next_tier,
    amountToNext: r.amount_to_next === null ? null : Number(r.amount_to_next),
  }));
}

/**
 * Registra una compra que cuenta para el nivel de fidelidad. Best-effort: quien llame a esto debe
 * atrapar el error y no bloquear la respuesta del checkout si falla, mismo espíritu que
 * submitOrderToPlade() en server.js.
 */
async function recordPurchase({ userId, orderId, amountUsd, country, paymentMethod }) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from('purchases').insert({
    user_id: userId,
    order_id: orderId,
    amount_usd: amountUsd,
    country,
    payment_method: paymentMethod || null,
  });
  if (error) throw new Error(`Supabase insert purchases: ${error.message}`);
}

/**
 * Compras recientes, para el panel /admin/purchases (anular pedidos nunca pagados que no deben
 * seguir contando para el nivel de fidelidad de nadie).
 */
async function listPurchases({ limit = 200 } = {}) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('purchases')
    .select('id, user_id, order_id, amount_usd, country, status, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Supabase list purchases: ${error.message}`);
  return data;
}

async function getPurchase(id) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('purchases')
    .select('id, user_id, order_id, amount_usd, country, status, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Supabase get purchase: ${error.message}`);
  return data;
}

async function setPurchaseStatus(id, status) {
  if (!supabaseAdmin) throw new Error('Supabase no está configurado.');
  const { error } = await supabaseAdmin.from('purchases').update({ status }).eq('id', id);
  if (error) throw new Error(`Supabase update purchase status: ${error.message}`);
}

/**
 * Cuenta las compras registradas. Se usa en la vista previa del borrado de datos de prueba, para
 * poder decir cuántas filas se van a tocar ANTES de tocarlas.
 */
async function countPurchases() {
  if (!supabaseAdmin) return 0;
  const { count, error } = await supabaseAdmin.from('purchases').select('id', { count: 'exact', head: true });
  if (error) throw new Error(`Supabase count purchases: ${error.message}`);
  return count || 0;
}

/**
 * BORRA compras por su order_id. Irreversible.
 *
 * Existe solo para limpiar pedidos de prueba antes de abrir la tienda de verdad: esas filas son las
 * que alimentan el nivel de fidelidad de cada cliente (ver supabase/003_loyalty_functions.sql), así
 * que dejarlas haría que una cuenta de prueba apareciera como DIAMANTE con un descuento real.
 *
 * Borra por `order_id` y no la tabla entera a propósito: si algún día conviven pedidos reales con
 * los de prueba, este camino sigue siendo seguro.
 */
async function deletePurchasesByOrderIds(orderIds) {
  if (!supabaseAdmin) throw new Error('Supabase no está configurado.');
  const ids = [...new Set((orderIds || []).map((x) => String(x)).filter(Boolean))];
  if (ids.length === 0) return 0;

  // En lotes: una URL con miles de ids en el filtro `in` se pasa del límite de largo de PostgREST.
  let borradas = 0;
  const TAMANO_LOTE = 100;
  for (let i = 0; i < ids.length; i += TAMANO_LOTE) {
    const lote = ids.slice(i, i + TAMANO_LOTE);
    const { data, error } = await supabaseAdmin.from('purchases').delete().in('order_id', lote).select('id');
    if (error) throw new Error(`Supabase delete purchases: ${error.message}`);
    borradas += (data || []).length;
  }
  return borradas;
}

module.exports = {
  // Se exporta el cliente para que admin-users.js reuse esta misma instancia en vez de crear otra
  // con las mismas credenciales. Es null si faltan las env vars — quien lo use tiene que chequear
  // isLoyaltyConfigured() antes (o su propio wrapper, como isAdminUsersConfigured()).
  supabaseAdmin,
  isLoyaltyConfigured,
  getLoyaltyForUser,
  listLoyaltyLevels,
  recordPurchase,
  listPurchases,
  getPurchase,
  setPurchaseStatus,
  countPurchases,
  deletePurchasesByOrderIds,
};
