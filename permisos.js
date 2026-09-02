/**
 * Qué puede hacer cada cuenta del panel.
 *
 * **Por qué esto existe.** Hasta ahora cada permiso nuevo era una COLUMNA nueva en `admin_users`
 * (`can_view_counter`, `can_pause_categories`) y por tanto una migración de Supabase que el dueño
 * tiene que correr a mano. Además, agregar una columna al SELECT del login ya tumbó el panel entero
 * una vez (2026-08-09, ver admin-users.js). Con una lista guardada en un solo campo, **agregar una
 * función nueva es una línea en este archivo y nada más**: ni migración, ni riesgo en el login.
 *
 * **El modelo.** El `role` sigue siendo el nivel grueso y define lo que una cuenta puede hacer *por
 * defecto*. La lista de permisos es una lista explícita que lo reemplaza cuando existe:
 *
 *   permisos === null  ->  vale lo que da el rol (todas las cuentas viejas caen acá)
 *   permisos === [...]  ->  exactamente eso, ni más ni menos
 *
 * `null` y no `[]` a propósito: hacen falta dos estados distintos, "no se ha tocado" y "se le quitó
 * todo". Con `[]` como valor por defecto no se podrían distinguir, y una cuenta recién creada
 * quedaría sin acceso a nada sin que nadie lo hubiera pedido.
 *
 * **El master siempre lo puede todo**, sin depender de esta lista. Es la misma regla que ya aplica
 * `requireAdminRole`: si un permiso se olvidara en algún sitio, el dueño no puede quedarse afuera.
 */

'use strict';

/**
 * Catálogo de funciones del panel. **Para agregar una función nueva, agregar acá una entrada** —
 * el panel de usuarios la ofrece sola y el backend puede exigirla con `requierePermiso('clave')`.
 *
 * `rolesPorDefecto` es lo que tiene una cuenta de ese rol si nadie le tocó los permisos. Mantener
 * lo que ya hacía cada rol antes de que esto existiera: quien tenía acceso a algo no puede
 * perderlo por un despliegue.
 */
const FUNCIONES = [
  { clave: 'resumen', nombre: 'Resumen', descripcion: 'Ventas del día, semana y mes, pendientes, poco stock.', rolesPorDefecto: ['admin', 'empleado'] },
  { clave: 'pedidos', nombre: 'Pedidos', descripcion: 'Ver ventas, despachar, revisar comprobantes y anular.', rolesPorDefecto: ['admin', 'empleado'] },
  { clave: 'scan', nombre: 'Escanear salidas', descripcion: 'Escanear el recibo para marcar la venta como entregada.', rolesPorDefecto: ['admin', 'salidas', 'empleado'] },
  { clave: 'productos', nombre: 'Productos', descripcion: 'Cargar fotos y descripciones del catálogo.', rolesPorDefecto: ['admin'] },
  { clave: 'clientes', nombre: 'Clientes', descripcion: 'Buscar clientes y ver su historial de compras.', rolesPorDefecto: ['admin'] },
  { clave: 'resenas', nombre: 'Reseñas', descripcion: 'Moderar las reseñas de los productos.', rolesPorDefecto: ['admin'] },

  {
    clave: 'contador',
    nombre: 'Cifras de dinero',
    descripcion: 'Ver el contador de ventas y los niveles de clientes — cuánto gasta cada uno.',
    rolesPorDefecto: [],
    // Reemplaza a can_view_counter. Se mantiene el nombre viejo en la base por compatibilidad.
    columnaVieja: 'can_view_counter',
  },
  {
    clave: 'categorias',
    nombre: 'Pausar categorías',
    descripcion: 'Sacar de la tienda una categoría entera sin borrar nada en PLADE.',
    rolesPorDefecto: [],
    columnaVieja: 'can_pause_categories',
  },

  { clave: 'visitas', nombre: 'Visitas al sitio', descripcion: 'Cuánta gente entra, desde qué país, aparato y hora.', rolesPorDefecto: [] },
  { clave: 'sedes', nombre: 'Sedes del inventario', descripcion: 'De qué sedes de PLADE se suma el stock que ve el cliente.', rolesPorDefecto: [] },
  { clave: 'impresion', nombre: 'Impresión en la tienda', descripcion: 'Configurar la impresora de recibos y reimprimir.', rolesPorDefecto: [] },
  { clave: 'usuarios', nombre: 'Usuarios del panel', descripcion: 'Crear cuentas del personal y cambiar contraseñas.', rolesPorDefecto: ['admin'], aviso: 'Quien no sea master no podrá crear cuentas master ni repartir permisos.' },
  {
    clave: 'datos-prueba',
    nombre: 'Dejar la tienda en cero',
    descripcion: 'Borrar TODOS los pedidos, clientes y comprobantes.',
    rolesPorDefecto: [],
    peligrosa: true,
    aviso: 'Borra datos de forma irreversible. Conviene dejarlo solo para el master.',
  },
];

const CLAVES = FUNCIONES.map((f) => f.clave);
const CLAVES_VALIDAS = new Set(CLAVES);

/** Las que una cuenta de ese rol tiene si nadie le tocó los permisos. */
function permisosPorRol(role) {
  if (role === 'master') return [...CLAVES];
  return FUNCIONES.filter((f) => f.rolesPorDefecto.includes(role)).map((f) => f.clave);
}

/** Descarta cualquier clave que no exista. Una clave inventada no puede colarse a la base. */
function normalizarPermisos(lista) {
  if (!Array.isArray(lista)) return null;
  const vistas = new Set();
  for (const v of lista) {
    const clave = String(v ?? '').trim();
    if (CLAVES_VALIDAS.has(clave)) vistas.add(clave);
  }
  // Se conserva el orden del catálogo para que el dato guardado sea estable y comparable.
  return CLAVES.filter((c) => vistas.has(c));
}

/**
 * Lo que una cuenta puede hacer de verdad, resolviendo las tres fuentes.
 *
 * Las columnas viejas (`can_view_counter`, `can_pause_categories`) se siguen respetando: son
 * permisos que el dueño ya repartió y que no puede perder porque cambiemos el modelo. Suman, nunca
 * restan.
 *
 * @param {{ role?: string, permissions?: string[]|null, canViewCounter?: boolean, canPauseCategories?: boolean }} cuenta
 */
function permisosEfectivos(cuenta) {
  const role = cuenta && cuenta.role;
  if (role === 'master') return [...CLAVES];

  const explicitos = normalizarPermisos(cuenta && cuenta.permissions);
  const base = explicitos === null ? permisosPorRol(role) : explicitos;

  const conViejos = new Set(base);
  if (cuenta && cuenta.canViewCounter) conViejos.add('contador');
  if (cuenta && cuenta.canPauseCategories) conViejos.add('categorias');
  return CLAVES.filter((c) => conViejos.has(c));
}

function tienePermiso(cuenta, clave) {
  if (cuenta && cuenta.role === 'master') return true;
  return permisosEfectivos(cuenta).includes(clave);
}

module.exports = { FUNCIONES, CLAVES, permisosPorRol, normalizarPermisos, permisosEfectivos, tienePermiso };
