# FORMIES_AUDITORIA.md — Auditoría del Módulo Deportes (AUVRO) en FORMIES

> Fecha: 2026-09-01. Auditoría del **canal de publicación** del módulo Deportes para FORMIES
> (y cualquier tenant del nicho deportivo): `admin → crear → subir → guardar → publicar → sitio público → usuario final`.
> Cada fila cita el código real que lo verifica.

## Resumen ejecutivo (veredicto)

- **El backend, frontend admin y plantilla son correctos.** El contenido que se guarda en admin ya se
  filtra por `publico=true AND activo=true` en `catalogo_publico` y se publica de forma **dinámica** (sin redeploy).
- **Causa raíz del "no se ve en público":** el sitio FORMIES (`https://formies-1.netlify.app/`) tenía un
  `index.html` snapshot **pre-Deportes** (sin `grid-deportistas`, `catalogo_publico`, ni secciones deportivas).
  Los sitios creados antes de añadir un módulo no reciben módulos nuevos (limitación ya documentada en
  `docs/AUVRO_CONTEXT.md:1442`).
- **Fix reutilizable (no FORMIES-específico):** acción `resync_template` en `web-factory.js` merge quirúrgico
  de `inyectarDeportesEnHtml` (secciones + CSS + JS) en el repo existente, + botón "Re-sincronizar plantilla"
  en el dashboard + rebuild en Netlify. Aplica a CUALQUIER store existente.
- **Segunda causa raíz (descubierta en la verificación final):** el JS del catálogo se inyectaba con
  `String.replace(regex, SNIPPET)`. El snippet contiene `return '$'` (signo de pesos) y, en un **string
  replacement**, `$'` se interpreta como *"el resto de la cadena tras la coincidencia"* → al insertarse tras
  `</body>` quedaba `return '\n</html>`, **rompiendo el parseo del `<script>`** → secciones ocultas pese a
  tener el módulo. Fix: insertar vía **callback** (`() => SNIPPET`) en los 3 `.replace()` de
  `inyectarDeportesEnHtml`, + `repararJsCatalogo` que **repara** el HTML ya sincronizado con ese daño.

## Matriz de verificación (evidencia de código)

| # | Requisito | Estado | Evidencia (archivo:línea) |
| - | --------- | ------ | ------------------------- |
| 1 | Admin puede crear/editar deportista | 🟢 | `tienda-admin.html:1166 depFormDeportista` → `guardar_deportista`; `deportes.js:252 guardarDeportista` |
| 2 | Subida de imagen directa (no solo URL) | 🟢 | `tienda-admin.html:1114 depSubir` (FileReader→`data_url`) → `subir-imagen-deporte.js:117` bucket `deportes`, URL pública en `fotografia_url` |
| 3 | Backend persiste `publico`/`activo` | 🟢 | `deportes.js:247 publico: body.publico !== false`, `:248 activo: body.activo !== false` |
| 4 | `catalogo_publico` filtra publicados | 🟢 | `deportes.js:117` `.eq('proyecto_id').eq('publico',true).eq('activo',true)` (deportistas); planes/visorías/noticias con `.eq('activo',true)` |
| 5 | Storefront público consuma `catalogo_publico` | 🟢 | `wf-templates/templates/tienda/index.html` línea 682 `fetch(...deportes)` `action:'catalogo_publico'`; rellena `grid-deportistas/planes/visorias/noticias` |
| 6 | Publicación dinámica (sin redeploy AUVRO) | 🟢 | La plantilla obtiene datos en el navegador del visitante desde el endpoint; no hay build por cada alta |
| 7 | **Sitio existente (FORMIES) recibe el módulo** | 🟢 (fix) | `web-factory.js` `inyectarDeportesEnHtml` + acción `resync_template` + `dashboard.html` botón "Re-sincronizar plantilla" |
| 8 | Merge no destructivo de la personalización | 🟢 | `inyectarDeportesEnHtml` solo inserta si faltan `grid-deportistas`/`catalogo_publico`; no reescribe el resto del HTML (test idempotente PASS) |
| 9 | Tenant isolation (admin) | 🟢 | `deportes.js:64-81 autenticarAdmin`: `is_admin` o `created_by===userId` o rol `tienda_permisos` del `proyecto_id`; `subir-imagen-deporte.js:79-93` mismo patrón; todo CRUD filtra `.eq('proyecto_id',…)` |
| 10 | Seguridad ficha pública de menores | 🟢 (fix) | `deportes.js:116` `catalogo_publico` ya NO incluye `estadisticas`, `videos`, `ficha`, `peso_kg` en el payload público |
| 11 | Estados Borrador/Publicado/Oculto/Archivado | 🟢 | `activo` (publicado/oculto) + `publico` (borrador/oculto del deportista); "Archivado/eliminado" via `eliminar_*`. Plantilla solo muestra `activo=true` |
| 12 | Reusabilidad (no código FORMIES) | 🟢 | Todo vive particionado por `proyecto_id`; sin mención de FORMIES en funciones; `dashboards` button es genérico |

## Comprobación realizada en el sitio público

`https://formies-1.netlify.app/` (antes del fix):
- Tiene motor tienda/`data-slug=formies`/widget ✓
- **Faltan** `catalogo_publico`, `grid-deportistas`, `grid-planes`, `id="deportistas"` ✗ ← causa raíz
- `formies.netlify.app` es OTRO producto francés (no AUVRO). El store real es `formies-1.netlify.app`.

## Pasos de operación (una sola vez) para publicar FORMIES

1. Desplegar AUVRO con el fix (`resync_template` + `inyectarDeportesEnHtml` con callback + `repararJsCatalogo` + botón).
2. En el dashboard → Web Factory → card FORMIES → "Re-sincronizar plantilla".
   - Este segundo re-sync es imprescindible: repara el JS del catálogo ya grabado en el repo con la corrupción `$'`.
3. Esperar el build Netlify (~1-2 min) y re-verificar que `https://formies-1.netlify.app/` ahora contiene
   `catalogo_publico` y `id="deportistas"` **y que el `fmtPesos` del JS es sano** (`return '$'`).
4. Crear contenido deportivo real en `tienda-admin` → Deportes (deportistas públicos `publico=true` activos,
   planes ELITE/FORMATIVO ya seedeados, visorías, noticias).
5. Re-abrir el sitio → secciones Deportes visibles con el contenido.

## Verificación automática del merge (test ejecutado)

El helper `inyectarDeportesEnHtml` se probó contra un `index.html` simulado pre-Deportes:
- Inserta `id="deportistas"/"planes"/"visorias"/"noticias"`, `grid-*`, JS `catalogo_publico`, CSS `.card-deporte` ✓
- **Preserva** el contenido personalizado (marcador `CUSTOM`), el `<footer>` y el `data-slug` ✓
- **Idempotente**: una segunda llamada no modifica nada (`out2 === out`) ✓
## Commit eff8755 - Storefront por pestanas + formulario deportista sin JSON

Con este commit la plantilla `tienda` se convierte en un storefront tipo-app con pestanas. Cada seccion (Tienda, Deportistas, Planes, Visorias, Torneos, Noticias, Galeria) es un panel que se muestra de a uno; las pestanas sin contenido permanecen ocultas hasta cargar datos.

Cambios:
- `wf-templates/templates/tienda/index.html`: barra `.pestanas` sticky con botones `data-panel`; secciones convertidas en `.panel` con `data-panel`; nuevas secciones `#torneos` y `#galeria` (render video/img); funcion `activarPanel(panel, desplazar)` expuesta en `window`; el JS del catalogo pasa de `mostrar(seccion)` a `mostrarPanel(panel)` (desoculta la pestana y activa el panel).
- `wf-templates/templates/tienda/styles.css`: estilos `.pestanas`, `.pestana`, `.pestana-on`, `.panel`, `.panel.panel-on`, y grids `#grid-torneos`/`#grid-galeria`.
- `tienda-admin.html`: `depFormDeportista` reemplaza las textareas JSON de Ficha/Estadisticas por texto libre (`ficha=texto+galeria+videos`, `estadisticas=texto`); fotografia con boton Subir y galeria multi-foto (`depSubirVarias`/`depQuitarGaleria`) + subida de video; `#dep-editing` para re-render tras subida; corrige variables `d_fotos`/`d_ficha`/`d_stats`/`d_vid` no declaradas y siembra `window.__depGaleria` al editar.

Paso del operador para reflejarlo en la tienda FORMIES ya creada:
1. Abrir el dashboard y re-pulsar `Re-sincronizar plantilla` (el storefront decorado queda en la plantilla, pero el HTML de la tienda ya existente se genera al sincronizar).

Validado: los scripts inline de la plantilla y del admin parsean; logica de pestanas y render verificado.

Guía para el diseñador / operador de FORMIES:

1. Este commit despliega el **storefront tipo-pestañas** (Tienda / Deportistas / Planes / Visorías / Torneos / Noticias / Galería / Contacto) en la plantilla `tienda`. Cada sección es un `.panel` que se muestra de a uno; las pestañas sin contenido quedan ocultas hasta que hay datos. Es la plantilla de referencia para CUALQUIER store creado desde Web Factory con la plantilla `tienda`.
2. Para ver la decoración en la tienda FORMIES ya creada, el operador debe **re-pulsar "Re-sincronizar plantilla"** en el dashboard → Web Factory → card FORMIES. El HTML de la tienda se genera al sincronizar; el commit no lo cambia retroactivamente.
3. En `tienda-admin` → Deportes, el formulario de deportista ya NO pide JSON: Ficha y Estadísticas son texto libre, la portada tiene botón "Subir", y la galería/videos se suben como archivos (no solo URLs). El visitante ve los torneos y la galería como secciones propias.

## Commit 602670b - Inscripción pública (formulario completo) + botones "Inscribirme"

Con este commit el storefront (tienda y snippet de deportes) queda con inscripción pública de extremo a extremo:

Cambios:
- `wf-templates/templates/tienda/index.html`: script 4 con formulario de inscripción en modal `#inscripcion-modal` (exposición `window.abrirInscripcion`/`cerrarInscripcion`); botones **"Inscribirme"** en planes (`club` + WhatsApp), visorías (`visoria`) y torneos (`torneo`). El submit valida obligatorios (`ins-nombre`/`ins-responsable`/`ins-telefono`) y el check de tratamiento, y POSTea `inscribir_publico` al backend.
- `netlify/functions/web-factory.js`: `SNIPPET_DEPORTES_JS`/`SNIPPET_DEPORTES_SECCIONES`/`SNIPPET_DEPORTES_CSS` incluyen el modal `#inscripcion-modal`, `abrirInscripcion` + render de torneos/galería + botones "Inscribirme", para que los store existentes (FORMIES) reciban el flujo al re-sincronizar.

Paso del operador para reflejarlo en la tienda FORMIES ya creada:
1. Re-pulsar `Re-sincronizar plantilla` en dashboard → Web Factory → card FORMIES (la plantilla ya lo lleva; el HTML de la tienda existente se regenera al sincronizar).

Validado: 4 scripts del storefront + 1 script del snippet parsean (`new Function`); `node --check` PASS en `deportes.js` y `web-factory.js`.

## Commit 6baf8d7 + d723cca + pendiente — Migración, pago_id text y activar módulo

- `deportes.js`: `pago_id` ya no guarda el id NO-UUID del link de pago Wompi en la columna `uuid` (rompía el UPDATE y el auto-pago del webhook); se persiste `orden_id` y `pago_id` solo si es un UUID real. Aislamiento por `proyecto_id` en `getDeportista`/`pagoInscripcion`/plan+visoría de inscripción pública. Consentimiento público se guarda en síncrono con fallback sin `inscripcion_id` y devuelve `consentimiento_id`.
- `web-factory.js`: acción admin `set_modulo_deportes` (activa/desactiva `web_projects.modulos` y re-sincroniza el storefront) para tiendas existentes sin el módulo.
- `dashboard.html`: se ELIMINÓ la vista "Deportes" del dashboard (nav + `view-deportes` + ~940 líneas JS). La gestión del módulo vive únicamente en `tienda-admin.html` (`renderDeportes`).
- `subir-imagen-deporte.js` y subida al guardar (`deportes.js subirImagenDeporte`): validación de MIME + magic-bytes, y **los errores de subida ya no se tragan** (antes guardaban `''` en silencio); ahora el admin ve el motivo real.
- Migración `20260901_deportes_modulos.sql`: `deportes_inscripciones.pago_id` → `text`; `deportes_consentimientos.inscripcion_id`.

### Nuevo: acción `regenerar_storefront` (commit en curso)

`resync_template` NO puede "subir de versión" un módulo ya presente en versión vieja: si el `index.html` del repo tiene `grid-deportistas`/`catalogo_publico`, el resync lo da por hecho y no añade las secciones nuevas (pestañas, torneos, galería, modal de inscripción). Por eso FORMIES quedó en un snapshot intermedio y la re-sincronización respondía "nada que re-sincronizar".

Fix: **`regenerar_storefront`** reconstruye `index.html` (+ `styles.css`, `netlify.toml`, `robots.txt`) del store desde la **plantilla Tienda actual** con los tokens del proyecto (EMPRESA/DESCRIPCION/SLUG/SLOGAN/LOGO/WHATSAPP/ACCENT/fuente), conservando el widget del agente si el sitio lo tenía, y dispara el build de Netlify. Botón nuevo en Web Factory (icono `fa-file-code`) con confirmación de advertencia (reemplaza ediciones manuales del repo; el contenido se sirve desde la BD, así que no se pierde).

Paso del operador para FORMIES:
1. Desplegar AUVRO con esta acción y el botón.
2. Dashboard → Web Factory → card FORMIES → botón **Regenerar storefront con la plantilla actual**.
3. Esperar el build (~1-2 min) y re-verificar: `formies-1.netlify.app` debe pasar de ~40 KB a ~55 KB y contener `pestanas`/`inscripcion-modal`/`abrirInscripcion`/`grid-torneos`/`grid-galeria` (como `fuutbol-prueba`).
4. En `tienda-admin` → Deportes, guardar de nuevo cualquier deportista con foto: si la subida falla, ahora verás el error exacto en vez de una imagen ausente.
