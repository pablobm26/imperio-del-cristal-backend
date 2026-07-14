// Cliente para la API de inventario de PLADE SOFTWARE (endpoint /inventario/*).
// Requiere Node >= 18 (usa fetch nativo).
//
// Cada cliente de PLADE tiene su propio id_empresa / id_almacen (y posiblemente
// su propio host/puerto de API). Los valores por defecto aquí corresponden a
// farmaasistencia.com, usados solo para verificar que el cliente funciona.
// Para Imperio del Cristal hay que reemplazarlos por los valores reales
// (ver README.md, sección "Conectar con PLADE SOFTWARE").

const DEFAULT_BASE_URL = 'https://inthecompanies.com:49200';

class PladeClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, idEmpresa, idAlmacen } = {}) {
    if (!idEmpresa || !idAlmacen) {
      throw new Error('PladeClient requiere idEmpresa e idAlmacen.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.idEmpresa = idEmpresa;
    this.idAlmacen = idAlmacen;
  }

  async _getJson(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);

    if (!res.ok || (body && body.r === false)) {
      const detail = body?.msj || body?.sqlMessage || res.statusText;
      throw new Error(`PLADE API error (${path}): ${detail}`);
    }

    return body;
  }

  /** Líneas/marcas de productos (categorías). */
  getLineas() {
    return this._getJson('/inventario/lineas');
  }

  /** Listado de inventario con precio y existencia (can_inv = stock disponible). */
  getProducts({ limit = 20 } = {}) {
    return this._getJson(`/inventario/home/${this.idEmpresa}`, {
      limit,
      id_almacen: this.idAlmacen,
    });
  }

  /** Búsqueda de productos por nombre. */
  searchProducts(search) {
    if (!search || !search.trim()) throw new Error('searchProducts requiere un término de búsqueda.');
    return this._getJson('/inventario/buscar-productos', {
      search,
      id_almacen: this.idAlmacen,
    });
  }
}

module.exports = { PladeClient, DEFAULT_BASE_URL };
