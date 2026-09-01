# FORMIES_IMPLEMENTACION.md — Plan de Implementación (Nicho Deportivo en AUVRO)

> Documento vivo. Registra qué se reutilizó, qué se adaptó, qué se creó, decisiones y
> configuración externa pendiente. Los módulos son **genéricos de AUVRO** (sirven a cualquier
> cliente del nicho deportivo); FORMIES es el primer tenant.

## Principio rector

`REUTILIZAR → ADAPTAR → EXTENDER → CREAR SOLO SI ES NECESARIO`. Antes de crear cualquier cosa,
preguntar: ¿AUVRO ya lo tiene? ¿Se puede configurar/adaptar/extender?

## Orden de implementación (modo loop)

1. ✅ Auditoría + mapa de reutilización (`FORMIES_AUVRO_MAP.md`).
2. ✅ Este documento + `FORMIES_PENDIENTES.md`.
3. ⬜ Migración DB genérica (`deportes_*`) + seeds (planes ELITE/FORMATIVO).
4. ⬜ Backend `deportes.js` (CRUD + buscador + inscripciones) + bucket `deportes` (uploads).
5. ⬜ Frontend: sección "Deportes" en `dashboard.html` (deportistas, club, visorías, torneos, noticias, galería, consentimientos).
6. ⬜ Sitio público: plantilla `tienda` con identidad deportiva + tokens + agente IA con fuentes deportivas.
7. ⬜ Pagos visoría/club vía `tienda_productos`/Wompi + notificaciones.
8. ⬜ Seguridad (fichas públicas sin datos privados de menores), responsive, SEO, auditoría.

## Qué se reutiliza (sin tocar)

- `tienda.js`, `tienda_admin`, `tienda_productos`, `tienda_ordenes`, `tienda_categorias`, `tienda_atributos`, `tienda_variaciones`, `tienda_pasarela`.
- Wompi: `crear-pago.js`, `pago-webhook.js`, checkout.
- CRM: `crm.js`, `crm-helper.js`, `crm_leads`, `tienda_pipeline`, `notifications`.
- Agentes IA: `agentes_ia`, `chat.js`, `widget.js`, `tool-workflows.js`.
- WhatsApp: `whatsapp-webhook.js`, conexiones.
- Auth/roles: `perfiles`, `tienda_permisos`, `admin-check`.
- Almacenamiento: patrón `subir-imagen-producto.js` (se replica para bucket `deportes`).
- Plantilla `tienda` del Web Factory como motor del sitio público.

## Qué se adapta

- Catálogo FORMIES (y de cada cliente): productos deportivos (balones, uniformes, pantalonetas, medias, chaquetas, portero), servicios (perfil deportivo $350K, visoría $60K), tour (Gira Argentina US$1.300), club (ELITE $180K / FORMATIVO $150K) — todo **editable desde admin** (dashboard/tienda-admin).
- CRM para clasificar leads por origen (Agency, Club, Visoría, Gira, Perfil, Tienda, FUNMIES).
- Agente IA del sitio con prompt deportivo y consulta de productos/servicios/planes/visorías/gira.

## Qué se crea (genérico)

1. **Migración** `20260901_deportes_modulos.sql` — tablas `deportes_*` (ver mapa) + seeds.
2. **`netlify/functions/deportes.js`** — acciones:
   - Deportistas: `listar_deportistas`, `guardar_deportista`, `eliminar_deportista`, `buscar_deportistas` (filtros edad/año/categoría/posición/país/ciudad/nivel), `get_deportista`.
   - Club: `listar_planes`, `guardar_plan`, `eliminar_plan`, `listar_horarios`, `guardar_horario`, `eliminar_horario`.
   - Inscripciones: `listar_inscripciones`, `guardar_inscripcion`, `cambiar_estado_inscripcion`, `inscribir_publico` (con consentimiento + opción de pago).
   - Visorías: `listar_visorias`, `guardar_visoria`, `eliminar_visoria`.
   - Torneos: `listar_torneos`, `guardar_torneo`, `eliminar_torneo`.
   - Noticias: `listar_noticias`, `guardar_noticia`, `eliminar_noticia`.
   - Galería: `listar_galeria`, `guardar_item_galeria`, `eliminar_item_galeria`.
   - Consentimientos: `listar_consentimientos`, `guardar_consentimiento`.
3. **`netlify/functions/subir-imagen-deporte.js`** — bucket `deportes` (fotos deportistas, galería, noticias, videos).
4. **Dashboard**: nueva vista "Deportes" (`view-deportes` + nav) con sub-tabs por módulo; reutiliza `tiendaApi`-style helper.
5. **Plantilla `tienda`**: tokens/identidad deportiva (hero club/agency, sección visorías, noticias, galería, gira) + widget agente.

## Decisiones de diseño (registradas)

- **D1 — Multi-tenant:** todo nuevo módulo se particiona por `proyecto_id` (mismo patrón que tienda/CRM). Un proyecto activa los módulos que necesite.
- **D2 — No bifurcar AUVRO:** FORMIES es configuración + datos dentro de la plataforma.
- **D3 — Deportista ≠ producto:** entidad propia (`deportes_deportistas`); se reutilizan upload/categorías/tags/CRM/buscador/URLs.
- **D4 — Pagos:** visoría/club/gira/perfil se venden vía `tienda_productos` (Wompi existente); `deportes_inscripciones` guarda el vínculo a la orden/pago.
- **D5 — Privacidad:** ficha pública solo expone datos autorizados (nunca datos de menores sin consentimiento); consentimiento capturado en formularios.

## Configuración externa pendiente

- Wompi: llaves producción/sandbox del cliente en `tienda_pasarela` (por proyecto).
- WhatsApp Business: conexión Meta del cliente.
- Tokens de edición IA (si se usa `site-editor`).
- Dominio propio del sitio FORMIES (si aplica) en `web_projects.dominio`.
