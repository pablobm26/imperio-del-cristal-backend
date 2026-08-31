// Usuarios del panel interno, uno por persona (tabla public.admin_users, ver
// supabase/010_admin_users.sql). Reemplaza a las dos cuentas compartidas que vivían en variables
// de entorno — esas siguen andando como respaldo, ver authenticate() en server.js.
//
// Mismo estilo tolerante que supabase-admin.js / plade-marketplade-client.js: si Supabase no está
// configurado, isAdminUsersConfigured() da false y el login cae a las variables de entorno de
// siempre, en vez de romperse. Un panel que no deja entrar a nadie es peor que uno con dos cuentas
// compartidas.

const bcrypt = require('bcryptjs');
const { supabaseAdmin, isLoyaltyConfigured } = require('./supabase-admin');

const BCRYPT_ROUNDS = 10;
// De mayor a menor. `master` está por encima de admin: ve el contador de ventas siempre y es el
// único que puede crear otros master o autorizar el contador a un admin (ver server.js).
const ROLES = ['master', 'admin', 'empleado', 'salidas'];
const MIN_PASSWORD_LENGTH = 8;

function isAdminUsersConfigured() {
  return isLoyaltyConfigured();
}

/** Los usuarios se guardan y se buscan siempre en minúsculas (lo exige el CHECK de la tabla). */
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function isValidRole(role) {
  return ROLES.includes(role);
}

/**
 * La tabla todavía no existe (nadie corrió supabase/010_admin_users.sql). Postgres lo reporta como
 * 42P01 (undefined_table) y PostgREST además como PGRST205 ("no está en el schema cache").
 */
function isMissingTable(error) {
  return error && (error.code === '42P01' || error.code === 'PGRST205');
}

/**
 * Falta una COLUMNA que el código ya pide pero la base todavía no tiene, porque la migración
 * correspondiente no se corrió. Postgres: 42703 (undefined_column); PostgREST: PGRST204.
 *
 * Por qué existe este chequeo: al agregar `can_view_counter` (migración 011) la consulta de login
 * empezó a pedir esa columna. En producción, con la migración sin correr, el error no estaba
 * contemplado, se propagaba, y el login devolvía **500 para todo el mundo** — incluidas las cuentas
 * ya creadas y el respaldo por variables de entorno. Un bloqueo total del panel.
 * Regla para el futuro: cada columna nueva que se agregue a un SELECT del login necesita este
 * camino de degradación, o el deploy tiene que ir SIEMPRE después de la migración.
 */
function isMissingColumn(error) {
  return error && (error.code === '42703' || error.code === 'PGRST204');
}

/** Columnas que existen desde la migración 010; siempre seguras de pedir. */
const COLUMNAS_BASE = 'id, username, full_name, password_hash, role, active';

/**
 * Columnas de PERMISO agregadas por migraciones posteriores, en el orden en que se agregaron.
 * Cada una puede faltar si su migración no se corrió todavía.
 *
 * Antes esto se manejaba con un `if` a mano por columna. Con dos permisos ya hacían falta dos
 * reintentos anidados, y el tercero se iba a olvidar — que es exactamente cómo se causó el apagón
 * del 2026-08-09. Acá se resuelve de una vez: se pide todo, y ante un error de columna faltante se
 * reintenta quitando la última, hasta llegar a las columnas base.
 */
const COLUMNAS_OPCIONALES = ['can_view_counter', 'can_pause_categories'];

/** Lo que se devuelve al panel tras crear o editar un usuario. Nunca incluye el hash. */
const SELECT_USUARIO =
  'id, username, full_name, role, active, can_view_counter, can_pause_categories, created_at, last_login_at';

/**
 * Crear y editar SÍ escriben las columnas de permiso, así que no se pueden degradar como las
 * lecturas: guardar a medias dejaría al dueño creyendo que dio un permiso que no se guardó. Se
 * traduce el error críptico de Postgres a una instrucción concreta.
 */
function errorSiFaltaMigracion(error) {
  if (!isMissingColumn(error)) return null;
  return new Error(
    'Falta correr una migración en Supabase (probablemente supabase/013_admin_pause_categories.sql). ' +
      'Corréla en el SQL Editor y volvé a intentar.'
  );
}

/**
 * Ejecuta `consultar(columnas)` pidiendo primero todas las opcionales y degradando de a una si la
 * base todavía no las tiene. Las que no se pudieron pedir se rellenan en `false`, para que el
 * llamador reciba SIEMPRE la misma forma de objeto y no tenga que saber qué migraciones corrieron.
 */
async function consultarDegradando(consultar, base, contexto) {
  let resultado = null;
  for (let n = COLUMNAS_OPCIONALES.length; n >= 0; n--) {
    const pedidas = COLUMNAS_OPCIONALES.slice(0, n);
    resultado = await consultar([base, ...pedidas].join(', '));

    // Falta alguna opcional: reintentar con una menos. Con n === 0 ya no hay nada que quitar y el
    // error es real (falta una columna BASE), así que se devuelve tal cual.
    if (resultado.error && isMissingColumn(resultado.error) && n > 0) continue;

    const faltantes = COLUMNAS_OPCIONALES.slice(n);
    if (!resultado.error && faltantes.length > 0) {
      console.warn(
        `${contexto}: faltan las columnas ${faltantes.join(', ')} en admin_users. ` +
          'Corré las migraciones pendientes de supabase/. Mientras tanto esos permisos quedan en false.'
      );
      if (resultado.data) {
        const rellenar = (fila) => {
          const copia = { ...fila };
          for (const c of faltantes) copia[c] = false;
          return copia;
        };
        resultado.data = Array.isArray(resultado.data) ? resultado.data.map(rellenar) : rellenar(resultado.data);
      }
    }
    return resultado;
  }
  return resultado;
}

/** Mensaje único para las pantallas de gestión cuando falta correr la migración. */
const MISSING_TABLE_MESSAGE =
  'La tabla admin_users no existe todavía. Corré supabase/010_admin_users.sql en el SQL Editor de Supabase.';

/**
 * Busca un usuario activo por nombre de usuario. Devuelve null si no existe, si está desactivado,
 * si Supabase no está configurado, o si la tabla todavía no fue creada — en todos esos casos el
 * login sigue con el respaldo por variables de entorno.
 *
 * Ese último caso importa: en producción Supabase SÍ está configurado, así que si esto lanzara al
 * no encontrar la tabla, desplegar antes de correr la migración devolvería 500 en el login y
 * dejaría a todo el mundo afuera del panel, respaldo incluido. Degradar en vez de romper hace que
 * el orden entre migración y deploy no importe.
 */
async function findActiveUser(username) {
  if (!isAdminUsersConfigured()) return null;
  const user = normalizeUsername(username);

  const consultar = (columnas) =>
    supabaseAdmin
      .from('admin_users')
      .select(columnas)
      .eq('username', user)
      .eq('active', true)
      .maybeSingle();

  const { data, error } = await consultarDegradando(consultar, COLUMNAS_BASE, 'Login');

  if (error) {
    if (isMissingTable(error)) {
      console.warn(`Login: ${MISSING_TABLE_MESSAGE} Usando el respaldo por variables de entorno.`);
      return null;
    }
    throw new Error(`No se pudo consultar admin_users: ${error.message}`);
  }
  return data || null;
}

/** Compara la contraseña contra el hash bcrypt. Nunca compara texto plano. */
async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(String(plain), hash);
}

/** Se llama después de un login exitoso. Un fallo acá no debe impedir entrar. */
async function touchLastLogin(id) {
  if (!isAdminUsersConfigured()) return;
  await supabaseAdmin.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', id);
}

/** Listado para la pantalla de usuarios. Nunca devuelve el hash. */
async function listUsers() {
  if (!isAdminUsersConfigured()) throw new Error('Supabase no está configurado.');
  const consultar = (columnas) =>
    supabaseAdmin
      .from('admin_users')
      .select(columnas)
      .order('active', { ascending: false })
      .order('username');

  const LISTA = 'id, username, full_name, role, active, created_at, last_login_at';
  // Igual que en findActiveUser: sin las migraciones de permisos la pantalla de usuarios sigue
  // funcionando, solo que sin esos permisos, en vez de romperse entera.
  const { data, error } = await consultarDegradando(consultar, LISTA, 'Usuarios');

  if (error) throw new Error(isMissingTable(error) ? MISSING_TABLE_MESSAGE : `No se pudo listar usuarios: ${error.message}`);
  return data || [];
}

async function createUser({ username, fullName, password, role, canViewCounter = false, canPauseCategories = false }) {
  if (!isAdminUsersConfigured()) throw new Error('Supabase no está configurado.');

  const user = normalizeUsername(username);
  if (user.length < 3 || user.length > 40) throw new Error('El usuario debe tener entre 3 y 40 caracteres.');
  if (!/^[a-z0-9._-]+$/.test(user)) throw new Error('El usuario solo puede tener letras, números, punto, guion y guion bajo.');
  if (!String(fullName || '').trim()) throw new Error('Falta el nombre de la persona.');
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  if (!isValidRole(role)) throw new Error(`Rol inválido. Válidos: ${ROLES.join(', ')}.`);

  const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .insert({
      username: user,
      full_name: String(fullName).trim(),
      password_hash,
      role,
      can_view_counter: Boolean(canViewCounter),
      can_pause_categories: Boolean(canPauseCategories),
    })
    .select(SELECT_USUARIO)
    .single();

  // 23505 = unique_violation. Se traduce a un mensaje entendible en vez del error crudo de Postgres.
  if (error) {
    if (error.code === '23505') throw new Error(`Ya existe un usuario "${user}".`);
    if (isMissingTable(error)) throw new Error(MISSING_TABLE_MESSAGE);
    const faltaMigracion = errorSiFaltaMigracion(error);
    if (faltaMigracion) throw faltaMigracion;
    throw new Error(`No se pudo crear el usuario: ${error.message}`);
  }
  return data;
}

/** Cambia rol y/o estado activo. No toca la contraseña — para eso está resetPassword(). */
async function updateUser(id, { role, active, canViewCounter, canPauseCategories }) {
  if (!isAdminUsersConfigured()) throw new Error('Supabase no está configurado.');

  const patch = {};
  if (role !== undefined) {
    if (!isValidRole(role)) throw new Error(`Rol inválido. Válidos: ${ROLES.join(', ')}.`);
    patch.role = role;
  }
  if (active !== undefined) patch.active = Boolean(active);
  if (canViewCounter !== undefined) patch.can_view_counter = Boolean(canViewCounter);
  if (canPauseCategories !== undefined) patch.can_pause_categories = Boolean(canPauseCategories);
  if (Object.keys(patch).length === 0) throw new Error('No hay nada que cambiar.');

  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .update(patch)
    .eq('id', id)
    .select(SELECT_USUARIO)
    .maybeSingle();
  if (error) {
    const faltaMigracion = errorSiFaltaMigracion(error);
    if (faltaMigracion) throw faltaMigracion;
    throw new Error(`No se pudo actualizar el usuario: ${error.message}`);
  }
  if (!data) throw new Error('Usuario no encontrado.');
  return data;
}

async function resetPassword(id, newPassword) {
  if (!isAdminUsersConfigured()) throw new Error('Supabase no está configurado.');
  if (String(newPassword || '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  const password_hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .update({ password_hash })
    .eq('id', id)
    .select('id, username')
    .maybeSingle();
  if (error) throw new Error(`No se pudo cambiar la contraseña: ${error.message}`);
  if (!data) throw new Error('Usuario no encontrado.');
  return data;
}

/**
 * Cuántas cuentas con poder de administración activas hay (master + admin) — para no dejar el panel
 * sin nadie que pueda gestionarlo. Cuenta las dos: un master es administrador y más.
 */
async function countActiveAdmins() {
  if (!isAdminUsersConfigured()) return 0;
  const { count, error } = await supabaseAdmin
    .from('admin_users')
    .select('id', { count: 'exact', head: true })
    .in('role', ['master', 'admin'])
    .eq('active', true);
  if (error) throw new Error(`No se pudo contar administradores: ${error.message}`);
  return count || 0;
}

module.exports = {
  ROLES,
  MIN_PASSWORD_LENGTH,
  isAdminUsersConfigured,
  normalizeUsername,
  findActiveUser,
  verifyPassword,
  touchLastLogin,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  countActiveAdmins,
};
