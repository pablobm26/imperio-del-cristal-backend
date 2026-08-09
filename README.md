# Inventory Backend

Backend que expone el catálogo como API JSON para la tienda web, más el panel de administración, el chatbot y la integración con PLADE SOFTWARE.

El catálogo puede venir por dos vías: **sincronización automática con PLADE** cada 30 minutos (si están configuradas `PLADE_USER`/`PLADE_PASSWORD`/`PLADE_TOKEN`, ver [Variables de entorno](#variables-de-entorno)), o **subiendo un CSV/Excel a mano** en `/admin`. Si las credenciales de PLADE no están configuradas, funciona sólo la segunda vía, sin ningún otro cambio de comportamiento.

## Probar en tu máquina

```bash
cd inventory_backend
npm install
set ADMIN_PASSWORD=tu-clave   # PowerShell: $env:ADMIN_PASSWORD="tu-clave"
npm start
```

Abre `http://localhost:3000/admin`, sube el archivo y define ahí tu contraseña de administración (no relacionada con PladeSoftware).

- `GET /api/products` — lista de productos en JSON (la usa la app)
- `GET /api/categories` — categorías detectadas
- `POST /api/chat` — chatbot con IA (ver abajo)
- `GET /admin` — formulario para subir el inventario

## Chatbot con IA (`POST /api/chat`)

Responde preguntas de clientes sobre productos, precios, pagos y horario usando Claude (Anthropic), 24/7 — incluso fuera del horario de atención humana.

**Requiere** la variable de entorno `ANTHROPIC_API_KEY` (ver `.env.example`). Consíguela en https://console.anthropic.com → Settings → API Keys. Sin esta variable, el endpoint responde con error 500 pero el resto de la app sigue funcionando.

Body de la petición:
```json
{ "message": "¿tienen copas de cristal?", "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}] }
```

El horario de atención (Lun-Vie 9am-6pm, Sáb 9am-2pm, hora de Venezuela) y los datos de pago están en [`chat.js`](chat.js) y [`payment_info.js`](payment_info.js) — edítalos si cambian. Límite de 20 mensajes por hora por IP para evitar abuso/costos descontrolados.

## Columnas esperadas en el archivo

El sistema detecta automáticamente estas columnas (sin importar mayúsculas/acentos):

| Campo requerido | Nombres reconocidos |
|---|---|
| Nombre (obligatorio) | Nombre, Producto, Articulo, Item |
| Precio | Precio, PrecioUSD, PrecioVenta, PrecioUnitario |
| Existencia/Stock | Existencia, Stock, Cantidad, Disponible |
| Categoría | Categoria, Rubro, Departamento, Grupo |
| Código/SKU | Codigo, SKU, Referencia |
| Descripción | Descripcion, Detalle |
| Imagen (URL) | Imagen, Foto, URLImagen |
| Ancho (cm) | Ancho |
| Alto (cm) | Alto |
| Largo (cm) | Largo, Profundidad |
| Material | Material |
| Peso (g) | Peso |
| Color | Color |

Si el archivo no trae alguna columna, esa columna queda vacía/en cero en la app — no es obligatorio tenerlas todas, salvo el nombre.

## Especificaciones de producto (material, color, medidas, peso)

`getInventario` de PLADE devuelve **una sola imagen por producto y ninguna descripción larga**, así que esos datos se cargan acá. Se guardan en una capa aparte (`data/product_details.json`) que se fusiona al leer el catálogo, por lo que **no se pierden** ni al subir un Excel nuevo ni al sincronizar con PLADE, siempre que el código/SKU no cambie.

Dos formas de cargarlos:

- **Uno por uno:** `/admin/products` (enlace desde `/admin`).
- **En masa:** el formulario *"Cargar descripciones e imágenes adicionales"* en `/admin`. Sube un CSV/XLSX con la columna obligatoria `Codigo` y las opcionales `Descripcion, Imagen, Imagen2, Imagen3, Imagen4, Video, Material, Color, Ancho, Alto, Largo, Peso`. Fusiona campo por campo: **una celda vacía no borra lo que ya estaba cargado**. Desde `/admin/details-template.csv` se descarga una planilla precargada con los productos que todavía no tienen foto.

## Desplegar en Render

1. Crea una cuenta en https://render.com (tú mismo, no yo).
2. Sube esta carpeta `inventory_backend` a un repositorio de GitHub. **Recomendado: privado.** Si lo dejas público, lee primero la advertencia de la sección [Variables de entorno](#variables-de-entorno) — los valores por defecto del código quedan a la vista.
3. En Render: **New +** → **Web Service** → conecta el repositorio.
4. Configuración:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. En **Environment**, agrega las variables de la tabla de abajo.
6. Despliega. Render te dará una URL pública como `https://tu-servicio.onrender.com`.

Nota: el plan gratuito de Render "duerme" el servicio tras inactividad (la primera carga tras dormir tarda ~30s) y **borra los datos en cada redeploy**, porque su disco es efímero. La instalación de El Imperio del Cristal está en el plan Starter con un disco persistente de 1GB montado en `/var/data` — por eso `DATA_DIR` apunta ahí.

## Variables de entorno

Ninguna es obligatoria a nivel técnico: el servidor arranca sin todas. Pero varias tienen un **valor por defecto inseguro**, y otras apagan silenciosamente una función entera. La columna "si falta" dice exactamente qué pasa.

### Panel de administración

| Variable | Si falta | Notas |
|---|---|---|
| `ADMIN_PASSWORD` | ⚠️ usa `changeme` | Contraseña del panel HTML (`/admin`) **y** de la cuenta `admin` del panel nuevo (`cristal44.com/admin`). Una sola contraseña para las dos. |
| `ADMIN_USERNAME` | usa `admin` | Usuario de la cuenta admin del panel nuevo. |
| `SALIDAS_PASSWORD` | ⚠️ usa `changeme` | Contraseña de la cuenta de salidas (pantalla de escaneo). |
| `SALIDAS_USERNAME` | usa `salidas` | Usuario de esa cuenta. |
| `ADMIN_TOKEN_SECRET` | ⚠️ usa `changeme-token-secret` | Clave HMAC que firma los tokens de sesión. Nadie la tipea; sólo vive en el servidor. |

> **Importante:** este repositorio es **público**. Los valores por defecto de arriba están a la vista de cualquiera en el código, así que dejarlos sin configurar equivale a no tener contraseña. El caso más grave es `ADMIN_TOKEN_SECRET`: con el valor por defecto, cualquiera puede firmarse un token de rol `admin` y **saltearse el login por completo**, sin necesidad de adivinar ninguna contraseña. Generá una cadena aleatoria larga:
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
>
> Cambiarla invalida todas las sesiones abiertas: quien esté logueado tendrá que volver a entrar.

### Integraciones

| Variable | Si falta | Para qué |
|---|---|---|
| `PLADE_USER`, `PLADE_PASSWORD`, `PLADE_TOKEN` | el catálogo se queda con el último CSV/Excel subido a mano | Sincronización automática con PLADE SOFTWARE cada 30 min (`getInventario`) y envío de pedidos (`savePedidoExterno`). Las tres van juntas: si falta una, la integración queda apagada entera. |
| `ANTHROPIC_API_KEY` | `POST /api/chat` responde 500, el resto sigue andando | Chatbot con Claude. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | el checkout funciona como invitado, sin descuentos de fidelidad | Cuentas de cliente y niveles de fidelidad. **`SUPABASE_SERVICE_ROLE_KEY` nunca va en Vercel ni en el frontend** — sólo acá. |
| `RESEND_API_KEY`, `CART_REMINDER_FROM_EMAIL` | no se envía ningún recordatorio | Correos de carrito abandonado. Van juntas. |
| `CRON_SECRET` | el endpoint del cron rechaza todo, así que los recordatorios nunca se disparan | Protege `GET /cron/...`, que se llama una vez al día desde un cron externo. |

El cliente de PLADE acepta además tres overrides que **normalmente no hace falta tocar** — están sólo para no tener que editar código si algo cambia del lado de ellos:

| Variable | Valor por defecto | Para qué |
|---|---|---|
| `PLADE_HOST` | `https://imperiodelcristal.pladesoftware.com/marketplade.php` | Endpoint único de la API. Cambia si cambia la instancia. |
| `PLADE_GENERIC_CLIENT_IDC` | `381` | Cliente "CLIENTE DEL E-COMMERCE" bajo el que se registran los pedidos web. |
| `PLADE_ONLINE_ALMACEN_ID` | `1` | Almacén ("ALMACEN PRINCIPAL"). |

⚠️ Ojo con las dos últimas: **PLADE ignora lo que se le mande en esos campos.** Se probó repetidamente — la factura siempre cae en el cliente `381` y el almacén `1`, sin importar el valor enviado, porque los resuelve del usuario de la API y no del pedido. Se mandan igual para que el código refleje la realidad, pero cambiarlos por variable de entorno no va a tener ningún efecto.

### Infraestructura

| Variable | Si falta | Para qué |
|---|---|---|
| `DATA_DIR` | usa la carpeta `data/` del repo, que Render **borra en cada redeploy** si el servicio no tiene disco persistente | Ruta del disco persistente. En Render: `/var/data`. |
| `PORT` | usa `3000` | Render la define sola, no hace falta agregarla a mano. |
| `STORE_URL` | usa `https://cristal44.com` | Dominio que se usa para armar los links de los correos. Sólo hace falta si cambia el dominio. |
