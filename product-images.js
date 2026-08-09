// Media de producto en Supabase Storage: 4 fotos + un video corto, la misma estructura que la ficha
// de producto de PLADE. PLADE solo devuelve UNA imagen vía getInventario (ver HANDOFF 2.11), así que
// las fotos 2-4, el reemplazo de la 1, y el video se suben desde el panel y viven acá.
//
// Por qué Supabase Storage y no el disco de Render: el disco es de 1GB y ahí viven los pedidos, los
// PDFs y los comprobantes de pago; llenarlo con fotos pondría en riesgo datos que no se pueden
// regenerar. Storage además sirve las imágenes por CDN, que es lo que quiere la tienda.
//
// Las imágenes llegan YA redimensionadas desde el navegador (ver lib/image-resize.ts en tienda_web):
// una foto de celular de 3-8MB se convierte en ~200KB antes de salir del dispositivo. Eso ahorra
// datos móviles del personal y evita una dependencia nativa (sharp) en el backend.

const { supabaseAdmin, isLoyaltyConfigured } = require('./supabase-admin');

const BUCKET = 'productos';
/**
 * Coincide con los campos image/image2..image4 de product_details.json. Son 4 y no 5 a propósito:
 * la ficha de producto de PLADE admite 4 imágenes más un video corto como quinto elemento, y el
 * video ya tiene su propio campo (`video`) — no es un slot de imagen.
 */
const IMAGE_SLOTS = ['image', 'image2', 'image3', 'image4'];
/** Tope de seguridad del lado del servidor. El navegador ya manda ~200KB; esto ataja un cliente roto. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/**
 * El video NO se puede comprimir en el navegador como las fotos, así que sube tal cual sale del
 * teléfono. 20MB alcanza para unos 15-20 segundos en calidad de celular, que es lo que pide una
 * ficha de producto — y evita que una grabación larga se coma el ancho de banda de los clientes.
 */
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

function isImagesConfigured() {
  return isLoyaltyConfigured();
}

function isValidSlot(slot) {
  return IMAGE_SLOTS.includes(slot);
}

/**
 * Valida que los bytes sean realmente una imagen mirando los magic bytes, no el nombre ni el
 * Content-Type que declara el cliente (los dos se falsifican trivialmente). Solo JPEG, PNG y WebP.
 */
/**
 * Tipos de video aceptados. Se detecta igual que las imágenes: por los bytes, no por lo que declare
 * el cliente. Los MP4/MOV traen el box "ftyp" en el offset 4.
 */
function detectVideoType(buffer) {
  if (!buffer || buffer.length < 16) return null;
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (brand.startsWith('qt')) return { ext: 'mov', mime: 'video/quicktime' };
    return { ext: 'mp4', mime: 'video/mp4' };
  }
  // WebM/Matroska: cabecera EBML.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { ext: 'webm', mime: 'video/webm' };
  }
  return null;
}

function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return { ext: 'png', mime: 'image/png' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

let bucketReady = false;

/**
 * Crea el bucket la primera vez, para no depender de que alguien lo cree a mano en el dashboard.
 * Público en lectura (las fotos se muestran en la tienda) pero solo escribible con la service_role
 * key, que únicamente tiene este backend.
 */
async function ensureBucket() {
  if (bucketReady) return;
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
      // El límite del bucket tiene que cubrir el archivo más grande que se permita (el video).
      fileSizeLimit: MAX_VIDEO_BYTES,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'],
    });
    // Si dos requests entran a la vez, la segunda ve "ya existe" — no es un error real.
    if (error && !/exists/i.test(error.message)) {
      throw new Error(`No se pudo crear el bucket de fotos: ${error.message}`);
    }
  }
  bucketReady = true;
}

/**
 * Ruta determinística: un solo archivo por producto y slot, así el almacenamiento queda acotado a
 * 5 archivos por producto (4 fotos + video) por más veces que se reemplacen. Como la ruta no cambia, la URL pública
 * tampoco — por eso se le agrega ?v=<timestamp>, para que el CDN no siga sirviendo la foto vieja.
 */
function storagePath(productId, slot, ext) {
  return `${encodeURIComponent(productId)}/${slot}.${ext}`;
}

async function uploadProductImage(productId, slot, buffer) {
  if (!isImagesConfigured()) throw new Error('Supabase no está configurado: no se pueden guardar fotos.');
  if (!isValidSlot(slot)) throw new Error(`Slot inválido. Válidos: ${IMAGE_SLOTS.join(', ')}.`);
  if (!buffer || buffer.length === 0) throw new Error('El archivo llegó vacío.');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`La imagen pesa ${(buffer.length / 1024 / 1024).toFixed(1)}MB; el máximo es 3MB.`);
  }

  const type = detectImageType(buffer);
  if (!type) throw new Error('El archivo no es una imagen JPEG, PNG o WebP válida.');

  await ensureBucket();

  const path = storagePath(productId, slot, type.ext);
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: type.mime, upsert: true });
  if (error) throw new Error(`No se pudo subir la imagen: ${error.message}`);

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

async function uploadProductVideo(productId, buffer) {
  if (!isImagesConfigured()) throw new Error('Supabase no está configurado: no se pueden guardar videos.');
  if (!buffer || buffer.length === 0) throw new Error('El archivo llegó vacío.');
  if (buffer.length > MAX_VIDEO_BYTES) {
    throw new Error(
      `El video pesa ${(buffer.length / 1024 / 1024).toFixed(1)}MB; el máximo es 20MB. Grabá uno más corto.`
    );
  }

  const type = detectVideoType(buffer);
  if (!type) throw new Error('El archivo no es un video MP4, MOV o WebM válido.');

  await ensureBucket();

  const path = storagePath(productId, 'video', type.ext);
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: type.mime, upsert: true });
  if (error) throw new Error(`No se pudo subir el video: ${error.message}`);

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

async function deleteProductVideo(productId) {
  if (!isImagesConfigured()) throw new Error('Supabase no está configurado.');
  await ensureBucket();
  const paths = ['mp4', 'mov', 'webm'].map((ext) => storagePath(productId, 'video', ext));
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`No se pudo borrar el video: ${error.message}`);
  }
}

/**
 * Borra el archivo del bucket. Se intentan las tres extensiones porque el slot pudo haberse subido
 * antes en otro formato (ej. estaba en .png y ahora se sube .jpg), y no queda registro de cuál era.
 */
async function deleteProductImage(productId, slot) {
  if (!isImagesConfigured()) throw new Error('Supabase no está configurado.');
  if (!isValidSlot(slot)) throw new Error(`Slot inválido. Válidos: ${IMAGE_SLOTS.join(', ')}.`);
  await ensureBucket();
  const paths = ['jpg', 'png', 'webp'].map((ext) => storagePath(productId, slot, ext));
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
  // Borrar algo que no existe no es un error para el usuario: el objetivo es "que no esté".
  if (error && !/not found/i.test(error.message)) {
    throw new Error(`No se pudo borrar la imagen: ${error.message}`);
  }
}

module.exports = {
  BUCKET,
  IMAGE_SLOTS,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  isImagesConfigured,
  isValidSlot,
  detectImageType,
  detectVideoType,
  uploadProductImage,
  deleteProductImage,
  uploadProductVideo,
  deleteProductVideo,
};
