// Prueba manual del cliente PLADE contra un tenant ya verificado (farmaasistencia.com).
// Uso: node plade-client.test.js
//
// Para probar contra Imperio del Cristal, define las variables de entorno:
//   PLADE_BASE_URL, PLADE_ID_EMPRESA, PLADE_ID_ALMACEN
// y vuelve a correr el script.

const { PladeClient, DEFAULT_BASE_URL } = require('./plade-client');

const client = new PladeClient({
  baseUrl: process.env.PLADE_BASE_URL || DEFAULT_BASE_URL,
  idEmpresa: process.env.PLADE_ID_EMPRESA || 1,
  idAlmacen: process.env.PLADE_ID_ALMACEN || 2,
});

async function main() {
  console.log('--- getProducts (home) ---');
  const products = await client.getProducts({ limit: 3 });
  console.log(`OK: ${products.length} productos recibidos`);
  console.log(products.map((p) => ({ nombre: p.nom_inv, precio: p.pre_ven_inv, stock: p.can_inv })));

  console.log('\n--- searchProducts ---');
  const results = await client.searchProducts('ibuprofeno');
  console.log(`OK: ${results.length} resultados de búsqueda`);
  console.log(results.slice(0, 3).map((p) => ({ nombre: p.nom_inv, codigo: p.cod_inv })));
}

main().catch((err) => {
  console.error('FALLÓ:', err.message);
  process.exit(1);
});
