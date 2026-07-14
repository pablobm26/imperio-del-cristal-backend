# Inventory Backend

Backend mínimo que recibe un archivo CSV/Excel exportado de tu panel de facturación y lo expone como API JSON para la app de catálogo. No usa ni guarda tu contraseña de PladeSoftware — tú exportas el archivo manualmente y lo subes aquí.

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

Tu software de facturación probablemente no guarda estos datos. Puedes completarlos manualmente en **`/admin/products`** (enlace disponible desde `/admin`) — se guardan por separado y **no se pierden** cuando vuelvas a subir un nuevo Excel, siempre que el código/SKU del producto no cambie.

## Desplegar gratis en Render

1. Crea una cuenta en https://render.com (tú mismo, no yo).
2. Sube esta carpeta `inventory_backend` a un repositorio de GitHub (puede ser privado).
3. En Render: **New +** → **Web Service** → conecta el repositorio.
4. Configuración:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. En **Environment**, agrega las variables `ADMIN_PASSWORD` (contraseña fuerte, no reutilices SOPORTE/plade12345) y `ANTHROPIC_API_KEY` (para el chatbot).
6. Despliega. Render te dará una URL pública como `https://tu-servicio.onrender.com`.
7. Pásame esa URL y la conecto en la app Flutter (`lib/config/api_config.dart`).

Nota: el plan gratuito de Render "duerme" el servicio tras inactividad; la primera carga tras dormir puede tardar ~30s.
