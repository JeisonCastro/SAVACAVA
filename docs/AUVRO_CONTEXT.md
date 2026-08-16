# AUVRO_CONTEXT.md

# Contexto del Proyecto AUVRO

## Reglas de documentación (obligatorias)

Este archivo es la **fuente de verdad** del proyecto. Todo agente/modelo que trabaje aquí debe:

1. **Leer los ficheros reales** antes de documentar o modificar: nunca documentar de memoria, siempre contrastar con el código.
2. **Documentar cada cambio funcional** en este mismo archivo y en el mismo commit/PR que el código. Un cambio sin documentar se considera incompleto.
3. **Mantener la estructura existente**: Descripción, Arquitectura, Flujo, Base de Datos, Funciones, Integraciones, Estado (Completado/Pendiente/Blocked), Decisiones de diseño (ej. correo = Gmail vía Composio, no SMTP).
4. **Actualizar el estado** (Completado / Pendiente / Blocked) al terminar, iniciar o bloquear cualquier tarea.
5. **Registrar decisiones importantes y su porqué** para que un modelo nuevo entienda qué necesita el sistema y cómo funciona, sin adivinar.
6. **REGLA GENERAL (aplica SIEMPRE)**: el objetivo es que este archivo mantenga en todo momento un contexto claro de TODO lo realizado y de TODA la lógica de negocio. Por tanto:
   - Todo commit de código que cambie comportamiento debe incluir, en el MISMO commit, su entrada correspondiente en `# Changelog de Cambios Técnicos` (con fecha, motivo y detalle técnico verificable).
   - Al final de cada sesión de trabajo no puede quedar ningún cambio sin documentar ni el estado (Completado/Pendiente/Blocked) desactualizado.
   - Cuando se añadan/renombren/eliminen columnas o tablas, actualizar de inmediato el esquema en "Esquema de Base de Datos" y la lista de migraciones (`supabase/migrations/*`), indicando cuáles están aplicadas en Supabase y cuáles faltan por aplicar.
   - Un agente/modelo que trabaje aquí y NO cumpla esto deja el proyecto en estado "incompleto": la documentación es parte del entregable, no opcional.

---

## Descripción General

AUVRO es una plataforma SaaS para la creación, configuración y publicación de agentes de Inteligencia Artificial personalizados.

El objetivo principal es permitir que usuarios y empresas puedan crear agentes IA especializados, asignarles instrucciones, conectarlos con herramientas externas y publicarlos en diferentes canales como sitios web y WhatsApp.

Cada usuario puede administrar múltiples agentes independientes con configuraciones, permisos y dominios propios.

---

# Arquitectura del Sistema

## Frontend

Tecnologías actuales:

- HTML
- CSS
- JavaScript Vanilla

Responsabilidades:

- Dashboard administrativo.
- Creación y edición de agentes.
- Configuración de instrucciones.
- Interfaz de chat.
- Widget para insertar agentes en páginas externas.


## Backend

Tecnología:

- Netlify Functions
- Node.js

Ubicación:

/netlify/functions

Cliente Supabase compartido:

Todas las funciones usan un helper centralizado `supabase-admin.js` que:
- Polyfill `globalThis.WebSocket` con el paquete `ws` para compatibilidad con Node.js 20.
- Exporta una instancia única de `createClient` con `SUPABASE_SERVICE_ROLE_KEY`.
- Evita el error "Node.js detected but native WebSocket not found" en runtime.

NUNCA crear `createClient()` directamente en una función. Siempre importar desde `./supabase-admin`.
Si se necesitan parámetros custom (ej: token de usuario), hacer `require('./supabase-admin')` al inicio
(para activar el polyfill) y luego crear un `createClient` independiente.

Responsabilidades:

- Procesamiento de mensajes.
- Validación de seguridad.
- Consulta de agentes.
- Integración con servicios externos.
- Comunicación con modelos de Inteligencia Artificial.


## Base de Datos

Proveedor:

Supabase PostgreSQL


Tabla principal:

agentes_ia


Estructura actual:

```sql
id bigint
nombre_agente text
prompt_sistema text
token_balance bigint
user_id uuid
dominios_permitidos text[]
activo boolean

El campo importante de seguridad:

dominios_permitidos

Tipo:

text[]

Ejemplo:

[
"cliente.com",
"www.cliente.com"
]

Este campo define en qué sitios web puede ejecutarse un agente.

Flujo de Funcionamiento del Chat

Usuario

↓

Frontend

↓

Netlify Function:

/.netlify/functions/chat

↓

Busca agente en Supabase

↓

Valida permisos y seguridad

↓

Construye contexto del agente

↓

Envía solicitud al modelo IA

↓

Retorna respuesta al usuario

Seguridad de Agentes

Cada agente tiene control de acceso mediante dominios autorizados.

La validación actual funciona así:

Dashboard AUVRO

El dominio:

auvro.netlify.app

Tiene permiso para probar agentes desde el panel administrativo.

WhatsApp

Los mensajes recibidos desde WhatsApp están permitidos porque vienen desde el canal configurado.

Desarrollo Local

Para pruebas locales se permiten:

localhost

127.0.0.1

Ejemplo:

http://localhost:8888

Widget Externo

Los agentes publicados en páginas externas solamente funcionan si el dominio está registrado en:

dominios_permitidos

Ejemplo permitido:

[
"empresa.com"
]

Si alguien copia el widget a otro dominio:

otrodominio.com

El backend debe bloquear la solicitud.

Variables de Entorno

Las variables sensibles se administran desde Netlify.

Nunca deben guardarse en GitHub.

Variables actuales:

AGENTE_MAESTRO_ID

COMPOSIO_API_KEY

DEEPSEEK_API_KEY

SUPABASE_URL

SUPABASE_ANON_KEY

SUPABASE_SERVICE_ROLE_KEY

VAPID_PRIVATE_KEY

VAPID_PUBLIC_KEY

VAPID_SUBJECT

WHATSAPP_VERIFY_TOKEN

Archivos que nunca deben subirse:

.env

.netlify

Desarrollo Local

El desarrollo local utiliza Netlify CLI.

Comando:

netlify dev

Servidor:

http://localhost:8888

Netlify CLI obtiene automáticamente las variables configuradas en Netlify.

Flujo:

Código local

↓

Netlify CLI

↓

Variables de entorno Netlify

↓

Funciones locales

↓

Supabase / Servicios externos

Deploy

Repositorio:

GitHub

Flujo:

Desarrollador

↓

git commit

↓

git push

↓

GitHub

↓

Netlify

↓

Deploy producción

## Funciones Principales

### chat.js

Función principal de conversación (backend core).

Responsabilidades:

- Recibir mensajes del frontend web y del webhook de WhatsApp.
- Buscar agente por ID en Supabase.
- Validar dominio (solo para canales web externos; WhatsApp y dashboard se saltan la validación).
- Crear o buscar conversación existente por `external_user_id` + `canal`.
- Guardar historial de mensajes en `mensajes_conversacion`.
- Detectar workflow activo (Calendar, Gmail, Drive) y manejar colecta de datos.
- Ejecutar modelo IA (DeepSeek) con contexto del agente + historial.
- Registrar consumo de tokens.
- Enviar notificaciones push al dueño del agente.
- Escalar a modo humano si el usuario lo solicita.

Flujo de entrada:

- Widget web: recibe `canal=web` + `external_user_id` del visitante.
- WhatsApp: recibe `canal=whatsapp` + `external_user_id=phone_number` (llamado internamente por `whatsapp-webhook.js`).

Validación de dominios (líneas 893-936):

```
origin = event.headers.origin || ""
esDashboard = origin.includes("auvro.netlify.app")
esWhatsapp = canal === "whatsapp"
esLocal = origin.includes("localhost") || origin.includes("127.0.0.1")

Si esDashboard OR esWhatsapp OR esLocal → se salta validación de dominios.
Si no → valida contra agente.dominios_permitidos.
```

Esto garantiza que los mensajes de WhatsApp nunca son bloqueados por permisos de dominio.

### chat.js — Lógica Completa del Procesamiento

`chat.js` es el cerebro del sistema: recibe TODO mensaje (widget web y WhatsApp de texto), valida seguridad, gestiona la conversación, decide si usa herramientas, llama al modelo de IA y registra el consumo.

#### 1. Entrada y validación básica

- Método HTTP: `POST` (con `OPTIONS` para CORS).
- Campos del body:
  - `prompt` (obligatorio) — texto del usuario.
  - `agente_id` — ID del agente (si falta, usa `AGENTE_MAESTRO_ID`).
  - `historial` — historial opcional enviado por el frontend (el backend lo ignora; carga desde BD).
  - `conversation_id` — ID de conversación existente (UUID).
  - `canal` — `web` o `whatsapp`.
  - `external_user_id` — identificador del visitante (web) o número de teléfono (WhatsApp).
  - `image_url` — URL de imagen si el usuario envió una.

#### 2. Búsqueda del agente

Se consulta `agentes_ia` por `id`. Si no existe → `404 "Agente no encontrado"`.

#### 3. Validación de dominio (seguridad)

Se evalúa el header `Origin`:

- `esDashboard` → origin contiene `auvro.netlify.app` (panel administrativo).
- `esWhatsapp` → `canal === "whatsapp"` (mensajes desde WhatsApp Cloud API).
- `esLocal` → origin contiene `localhost` o `127.0.0.1` (desarrollo local).

Si ninguno aplica (canal web externo):
- Si el agente no tiene `dominios_permitidos` → `403 "no tiene dominios configurados"`.
- Si el dominio del origin no está en `dominios_permitidos` → `403 "dominio no autorizado"`.

Esto garantiza que un widget copiado a un dominio no autorizado es bloqueado en el backend.

#### 4. Resolución de la conversación

```
externalUserIdFinal = external_user_id || conversation_id || `${canal}_${targetID}_anon`
```

`obtenerOCrearConversacion`:
- Busca en `conversaciones` por `agente_id + canal`, filtrando por `id` (si se pasa un `conversation_id` UUID válido) o por `external_user_id`.
- Usa `.limit(1)` ordenado por `updated_at DESC` para evitar el bug de duplicados (antes con `maybeSingle` fallaba si existían filas duplicadas y creaba una conversación nueva en cada mensaje).
- Si no encuentra, crea una conversación nueva con `estado='ia_activa'`, `modo_humano=false`, `requiere_atencion=false`.

#### 5. Guardar mensaje del usuario

- Inserta en `mensajes_conversacion` con `role='user'`, metadata `{ canal, origen: 'cliente', image_url? }`.
- Actualiza resumen en `conversaciones` (`ultimo_mensaje`, `ultimo_role='user'`).
- `requiere_atencion` se marca `true` si `debeEscalarAHumano(prompt)` detecta palabras clave (humano, asesor, persona real, queja, reclamo, no entiendes, etc.).

#### 6. Push notification automática

`dispararPush` envía notificación al dueño del agente para TODOS los mensajes entrantes (web y WhatsApp), llamando internamente a la función `send-push`.

#### 7. Verificación de modo humano

Si la conversación está en `modo_humano === true` o `estado === 'modo_humano'`:
- Marca `requiere_atencion=true` y retorna respuesta fija: "Un asesor humano continuará la conversación" con `skipped=true`. La IA NO participa.

#### 8. Carga paralela de contexto

`Promise.all` carga en paralelo:
- Historial de los últimos 8 mensajes (`mensajes_conversacion`).
- `token_balance` del usuario (`perfiles`).
- Tools habilitadas del agente (`agente_tools` con `enabled=true`).
- Conexiones de Composio del usuario (`composio_connections`).
- Acción pendiente activa (`pending_tool_actions` con `status='pending'`, no expirada, más reciente).

#### 9. Deduplicación del historial

Se elimina el último mensaje del historial si coincide con el prompt actual (evita duplicados porque el mensaje del usuario ya se guardó en el paso 5).

#### 10. Verificación de saldo

Si `saldoActual < 100` → `402 "Saldo insuficiente"`.

#### 11. Filtrado de herramientas disponibles

`toolsDisponibles` = tools habilitadas del agente que además tienen su toolkit conectado en Composio.

#### 12. Flujo de acciones pendientes (workflows)

`classifyMessageRoute({ pendingAction, text })` decide la ruta:
- Sin acción pendiente → `chat`.
- Cancelación explícita → `workflow_confirm`.
- Confirmación explícita ("sí", "ok", "dale", "adelante"...) → `workflow_confirm`.
- Datos del workflow (fechas, correos, nombres...) → `workflow_collect`.

`manejarPendingAction`:
- **workflow_confirm + cancelación** → marca la acción `cancelled` y responde "cancelé la acción pendiente".
- **workflow_confirm + confirmación** → ejecuta la acción:
  - Calendar → `ejecutarCalendar` (crea evento vía Composio, agrega link de Meet).
  - Gmail → `ejecutarGmail` (envía correo vía Composio).
- **workflow_collect** → enriquece el payload con los datos del mensaje, calcula campos faltantes (`getMissingFields`) y pregunta por ellos (`buildMissingFieldsQuestion`), o pide confirmación final.

#### 13. Construcción del prompt de sistema

```
systemFinal = prompt_sistema + toolsDescription + REGLAS DE CONVERSACIÓN + CAPACIDADES
```

- Si NO es un saludo simple → agrega instrucción de responder directamente sin saludo base.
- Si hay acción pendiente → agrega contexto de la acción (tipo + datos actuales) para que el modelo complete/corrija.
- `construirToolsDescription` (de `tool-workflows.js`) inyecta la lista de herramientas disponibles y las reglas de JSON para cada una, con la fecha actual y "mañana" en zona horaria Colombia.

#### 14. Llamada al modelo IA

- **Sin imagen** → DeepSeek, modelo `deepseek-v4-flash`.
- **Con imagen** → OpenAI GPT-4o (`gpt-4o`), enviando la imagen como contenido multimodal (`image_url`).
- El prompt se trunca a 2000 caracteres (`truncarMensaje`).
- Mensajes: `system` + últimos 8 del historial (deduplicado) + mensaje del usuario.
- `temperature: 0.2`, `max_tokens: 1024`, timeout dinámico (5–9s según longitud de input, con `AbortController`).

#### 15. Parseo de la respuesta del modelo

`limpiarTextoIA` quita fences de markdown. `parseActionPayload` intenta:
1. `JSON.parse` directo.
2. Quitar fences ` ```json ` y parsear.
3. Extraer el primer `{...}` del texto y parsearlo.

Si el modelo devolvió JSON de acción (ej: `{"action": "GMAIL_SEND_EMAIL", "data": {...}}`) → se procesa la herramienta. Si devolvió texto normal → se responde tal cual al usuario.

#### 16. Ejecución de herramientas (acciones)

- **GOOGLECALENDAR_CREATE_EVENT** (collect_confirm_execute): valida que la tool esté habilitada → cancela pending de otra acción si existe → construye payload (enriquece desde texto, resuelve fecha con `resolverFecha`, suma 45 min de duración con `sumarMinutos`) → `crearOActualizarPending` → pregunta campos faltantes o pide confirmación con el resumen del evento.
- **GMAIL_FETCH_EMAILS** (execute): verifica conexión Gmail → ejecuta tool vía Composio → formatea lista de correos (remitente, asunto, resumen).
- **GMAIL_SEND_EMAIL** (collect_confirm_execute): igual que Calendar (pending + confirmación).
- **GOOGLEDRIVE_FIND_FILE** (collect_execute): si faltan campos → pending + pregunta; si están completos → ejecuta directo (`ejecutarDriveDirecto`) y devuelve resultados SIN confirmación.
- **SHOPIFY_*** (premium, con costo extra en tokens): verifica conexión (credenciales directas `shopify_store_url` + `access_token`, o Composio) → ejecuta vía GraphQL Admin API o Composio → formatea respuesta. `SHOPIFY_CREATE_DRAFT_ORDER` y `SHOPIFY_GET_CHECKOUT_URL` pueden retornar temprano tras crear la orden.

Patrones de workflow (definidos en `tool-workflows.js`):
- `execute` — se ejecuta directo (Fetch Emails, Shopify queries).
- `collect_execute` — recolecta datos y ejecuta sin confirmación (Drive).
- `collect_confirm_execute` — recolecta, muestra resumen, espera confirmación y ejecuta (Calendar, Enviar Email, Draft Order).

#### 17. Registro de consumo

`registrarConsumo`:
- Calcula tokens: si la API reportó `usage`, usa `prompt_tokens + completion_tokens`; si no, estima `(longitud prompt_sistema + prompt + respuesta) / 4 + 10`, más tokens premium si aplica (ej: Shopify).
- Actualiza `perfiles.token_balance` (saldo − tokens usados).
- Llama RPC `increment_agent_consumption(agent_id, tokens)`.
- Inserta registro en `logs_consumo`.

#### 18. Guardar respuesta y finalizar

- Guarda mensaje `role='assistant'` con metadata `{ canal, origen: 'ia', action? }`.
- Actualiza resumen de conversación (`ultimo_role='assistant'`, `requiere_atencion=false`).
- Retorna `{ respuesta, tokens_consumidos, conversation_id }` con status 200.

#### 19. Manejo de errores

- `AbortError` → `500 "La IA tardó demasiado en responder"`.
- Otros errores → `500` con el mensaje del error.
- CORS: `Access-Control-Allow-Origin: *` en todas las respuestas.

### whatsapp-webhook.js

Endpoint receptor de webhooks de Meta (WhatsApp Cloud API).

Responsabilidades:

- Verificar token de Meta (GET para handshake, POST para mensajes).
- Buscar conexión activa por `phone_number_id` en tabla `whatsapp_connections`.
- Extraer contenido del mensaje (texto, imagen, documento, audio, video, sticker).
- Para mensajes de texto: llamar internamente a `chat.js` handler (sin HTTP) y enviar la respuesta por WhatsApp API.
- Para mensajes de media: guardar en `mensajes_conversacion` con metadata del adjunto y marcar `requiere_atencion=true`.
- Enviar notificación push al recibir adjuntos.

Flujo de mensajes de texto:

```
Meta POST → whatsapp-webhook.js
  → buscar whatsapp_connections por phone_number_id
  → buscar agente por agente_id
  → llamar chatHandler(chatEvent) con canal="whatsapp"
  → recibir respuesta IA
  → enviar respuesta vía WhatsApp Cloud API
```

Importante: el `chatEvent` se construye con `origin: ''` para que chat.js reconozca que viene de WhatsApp (esWhatsapp=true) y no bloquee por dominio.

### enviar-whatsapp-manual.js

Envío de mensajes manuales desde el dashboard del humano.

Responsabilidades:

- Autenticar usuario vía Bearer token de Supabase Auth.
- Verificar que la conversación pertenezca al usuario.
- Buscar conexión activa de WhatsApp para el agente.
- Enviar mensaje de texto vía WhatsApp Cloud API.
- Guardar mensaje en `mensajes_conversacion` con `role: 'assistant'`, `origen: 'humano'`.
- Actualizar conversación a modo `modo_humano`.

### enviar-whatsapp-media.js

Envío de archivos adjuntos desde el dashboard por WhatsApp.

Responsabilidades:

- Autenticar usuario.
- Recibir archivos en base64 desde el frontend.
- Subir cada archivo a Meta (WhatsApp Media API) y obtener `media_id`.
- Enviar mensaje con adjunto vía WhatsApp Cloud API.
- Guardar registro en `mensajes_conversacion` con metadata del archivo.

Soporta: imagen, video, audio, documento.

### web-chat-messages.js

Endpoint para cargar historial de mensajes de una conversación web.

Responsabilidades:

- Recibir `agente_id` y `external_user_id`.
- Buscar conversación web existente.
- Retornar los mensajes ordenados cronológicamente.

### send-push.js

Envío de notificaciones push (Web Push API).

Responsabilidades:

- Recibir `user_id`, `title`, `body`, `url`.
- Buscar suscripciones push del usuario en `push_subscriptions`.
- Enviar notificación a cada suscripción.
- Limpiar suscripciones expiradas (404/410).

### save-push-subscription.js

Guardar suscripciones push del dashboard.

### crear-agente.js

Crear nuevos agentes IA.

Responsabilidades:

- Recibir configuración del agente.
- Guardar en tabla `agentes_ia`.
- Asociar al usuario autenticado.

### conectar-composio.js

Conectar servicios externos vía Composio.

Responsabilidades:

- Iniciar flujo de conexión OAuth.
- Guardar token de conexión en `composio_connections`.

### guardar-composio-callback.js

Callback de OAuth de Composio.

Responsabilidades:

- Recibir código de autorización.
- Intercambiar por token de acceso.
- Guardar conexión en Supabase.

### tool-workflows.js (helper, no es función HTTP)

Motor de herramientas para Calendar, Gmail y Drive.

Responsabilidades:

- Definir tools disponibles y sus campos requeridos.
- Detectar intención del usuario (agendar, enviar correo, buscar archivo).
- Clasificar rutas de mensajes (chat, workflow_collect, workflow_confirm).
- Enriquecer payloads con datos extraídos del texto del usuario.
- Generar preguntas para campos faltantes.

### web-factory.js (Web Factory — generar sitios web para clientes)

Solo admins (mismo patrón de validación que `admin-data.js`: Bearer token del usuario + `perfiles.is_admin`).

Flujo de creación (`action: create`):

```
AUVRO Admin (vista Web Factory)
  → insertar en web_projects (estado=creando)
  → GET /api.github.com/user (owner, o GITHUB_OWNER)
  → POST /user/repos (repo privado)
  → Git Data API: blobs + tree + commit + refs/heads/main (archivos de la plantilla, con tokens reemplazados)
  → POST api.netlify.com/api/v1/sites con repo={github, branch main} (crea site y lo enlaza)
  → POST /sites/{id}/builds (deploy inicial)
  → POST /sites/{id}/domains (dominio opcional)
  → estado según deploy: publicado / dominio_pendiente / deploying / error
```

Acciones: `list` (proyectos + plantillas), `get`, `refresh_status` (consulta deploys/dominios/SSL en Netlify y actualiza), `create` (pipeline), `delete` (solo borra el registro de AUVRO; NO borra repo/site).

- El `create` corre en una **background function real** `web-factory-background.js` (sufijo `-background` en Netlify, ejecución hasta 15 min, sin el timeout síncrono de 10s). OJO: el header `X-NF-Background` ya NO es el mecanismo de background en Netlify (quedó obsoleto); el sufijo `-background` en el nombre del archivo (o `config.background`) es lo que activa el modo background. El `set_activo` (apagar/reactivar) es rápido (~2s) y corre **síncrono en `web-factory.js`** para devolver el ok/error real al cliente. El dashboard hace polling de `list`/`refresh_status` cada 8s mientras haya estados en curso.
- Plantillas en `web-factory/templates/<slug>/` (archivos reales), incluidas en el bundle vía `included_files` en `netlify.toml`. El `manifest.json` lista las disponibles. Tokens de plantilla: `{{EMPRESA}}`, `{{DESCRIPCION}}`.
- Secretos: `GITHUB_TOKEN` (scopes repo+user), `NETLIFY_AUTH_TOKEN` y opcional `GITHUB_OWNER` — SOLO en variables de entorno de Netlify, nunca en el repo/JS/HTML/Supabase.
- Dominio: se registra vía API de Netlify pero el DNS lo configura el cliente manualmente. `dominio_estado` (pendiente/verificado) y `ssl_estado` se muestran en el panel.
- El `delete` es no destructivo (avisa al admin que repo/site de GitHub/Netlify se conservan).
- Migración: `supabase/migrations/20260813_web_factory.sql` (tabla `web_projects`), `20260814_web_factory_personalizacion.sql` (columnas `logo`, `slogan`, `whatsapp`) y `20260814_web_factory_agente_ia.sql` (columna `agente_id`). Aplicar en Supabase antes de probar.

Integraciones Actuales
Supabase

Uso:

Base de datos.
Usuarios.
Configuración de agentes.
DeepSeek

Uso:

Modelo de Inteligencia Artificial.
Composio

Uso:

Conexión con herramientas externas.

---

## Notificaciones y envío de correos por agente (pre-pago / post-pago / estados de lead)

Objetivo
- Permitir que cada agente notifique al dueño del negocio (y/o destinatarios configurados) eventos comerciales importantes: generación de link de pago (intención), pago confirmado (venta), cambios de estado del lead (ej. `Ganado`), y reembolsos/errores de pago.

Canal de envío de correos
- Si el agente tiene conexión Gmail vía Composio, las notificaciones comerciales se envían con la tool `GMAIL_SEND_EMAIL` usando esa conexión OAuth.
- No se requiere SMTP por agente ni variables SMTP de plataforma para este flujo.
- Si Gmail no está conectado para el dueño del agente, el backend debe omitir el correo con error explícito `gmail_not_connected` y registrar el fallo cuando exista tabla de notificaciones.

Eventos que disparan notificaciones
- Pre-pago: al crear un payment link (`crearPaymentLinkVenta`) → enviar plantilla *pre-pago* con resumen y link.
- Post-pago: en webhook de pagos (`pago-webhook.js`) al confirmarse pago → enviar plantilla *post-pago* con recibo y marcar lead como `Ganado`.
- Cambio de estado: cuando `crm_leads.estado_id` cambia a un estado de interés (configurable), notificar.
- Opcional: notificar intención de compra desde el flujo de `pending actions` (workflow_confirm).

Configuración por agente (crm_config_agente)
- Campos sugeridos:
  - `notify_on_intent` (bool), `notify_on_payment` (bool), `notify_on_state_change` (bool)
  - `notify_channels`: ['email','whatsapp','push','webhook'] (multi)
  - `notify_recipients`: array (emails/phones)
  - `notify_cc_agent` (bool)
  - `notify_attach_receipt` (bool)
  - `notify_webhook_url` (optional)

Canales de notificación
- Email (Gmail vía Composio / tool `GMAIL_SEND_EMAIL`)
- WhatsApp: enviar notificación corta al vendedor si hay `whatsapp_connections` activo
- Push: usar `dispararPush` si hay suscripción
- Webhook: POST JSON al URL configurado, idempotente

Trazabilidad y seguridad
- Registrar cada notificación en tabla `emails_sent` / `notifications` con: agente_id, lead_id, conversation_id, event_type, channel, to, status, external_id, error, created_at.
- Actualizar `mensajes_conversacion` con nota indicando notificación enviada (metadata { notification_type, id }).
- Para Gmail usar Composio (OAuth tokens administrados por Composio). No guardar contraseñas ni credenciales SMTP en Git ni en DB para este flujo.

Plantillas
- Mantener plantillas HTML + plain-text para:
  - pre-pago (link): {{cliente.nombre}}, {{producto.nombre}}, {{fecha}}, {{detalle_pasajeros}}, {{total}}, {{link_pago}}, {{conversation_url}}
  - post-pago (recibo): incluir payment_id, referencia, adjunto opcional PDF
- Plantillas en repo: `netlify/functions/email-templates/`

Idempotencia y errores
- Webhooks (pagos) deben chequear `payment_id` procesado antes de notificar (evitar duplicados).
- Reintentos exponenciales para envíos fallidos; registrar fallos y exponer en dashboard.

Presets recomendados por tipo de producto (sugerencia)
- Físico/Digital: `notify_on_payment = true`
- Servicio/Suscripción: `notify_on_payment = true`; `notify_on_intent` = opt-in
- Tour/Actividad: `notify_on_intent = true`; `notify_on_payment = true`; `notify_on_state_change = true`

Estado de implementación (2026-08-08)
- DB: migración disponible en `supabase/migrations/20260808_notificaciones_crm.sql` (idempotente): añade `notify_on_intent`, `notify_on_payment`, `notify_on_state_change`, `notify_channels`, `notify_recipients`, `notify_cc_agent`, `notify_attach_receipt`, `notify_webhook_url` a `crm_config_agente`, y crea la tabla `notifications` para trazabilidad. Aplicar en Supabase antes de probar.
- Nota RLS: al re-ejecutar la migración puede dar error `42710` por policies duplicadas (`crm_config_agente_update_own`, etc.) que genera Supabase Studio. La migración ya las elimina al inicio con `drop policy if exists`. Es seguro porque el backend lee/escribe con `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS).
- Backend `crm.js` (`accion: 'config'`): persiste y devuelve los campos `notify_*`.
- Backend defensivo: `pago-webhook.js` y `crm-helper.js` leen la config con `select('*')` y `registrarNotificacion()` escribe con try/catch, así no fallan si la migración aún no se aplica.
- Hooks activos:
  - `crm-helper.js` / `crearPaymentLinkVenta`: notifica pre-pago si `notify_on_intent`.
  - `pago-webhook.js`: notifica post-pago si `notify_on_payment`.
  - `crm.js` / `lead_estado`: notifica cambio de estado si `notify_on_state_change`.
- Frontend `dashboard.html`: sección "Notificaciones comerciales" en el modal de configuración CRM (3 checkboxes + destinatarios + webhook URL).
- Pendiente: historial de notificaciones en el dashboard (tabla `notifications`), tests E2E.

Notas sobre variables seguras
- Todas las claves/credenciales deben almacenarse en Netlify ENV. No incluir secretos en el repo.
- Para Composio/Gmail usar OAuth tokens gestionados por Composio, no almacenar user/pass en texto.

---
WhatsApp

Uso:

Canal conversacional.
Netlify

Uso:

Hosting.
Serverless Functions.
Variables de entorno.
Deploy.
## Estado Actual del Proyecto

### Completado:

✅ Proyecto conectado a GitHub.
✅ Netlify conectado.
✅ Variables de entorno configuradas.
✅ Desarrollo local funcionando.
✅ Netlify CLI configurado.
✅ Supabase conectado.
✅ Funciones serverless funcionando.
✅ Chat IA funcionando.
✅ Seguridad básica por dominio implementada.
✅ Validación local para desarrollo.
✅ WhatsApp bidireccional funcionando (recepción + envío).
✅ Envío manual de mensajes y adjuntos desde dashboard.
✅ Notificaciones push en tiempo real.
✅ Workflows de herramientas (Calendar, Gmail, Drive).
✅ Cliente Supabase centralizado con polyfill WebSocket (Node.js 20 compat).
✅ Todas las funciones serverless migradas a helper compartido `supabase-admin.js`.
✅ Web Factory Fase 1 (13 Ago 2026): generar sitios web estáticos para clientes desde el panel Admin — repo privado en GitHub + site en Netlify + dominio opcional + deploy + estado en tiempo real.
✅ Web Factory (14-15 Ago 2026): 10 plantillas, agente IA embebible con dominios autorizados automáticamente, herramienta nativa `WEBFACTORY_CREAR_DEMO` (el agente vende/crea demos en el chat), personalización de color y fuente, y **apagar/reactivar sitios** (suspensión instantánea por impago vía file deploy).
✅ Fix apagar/reactivar (16 Ago 2026): deploy de suspensión ahora sube el archivo correctamente (digest→ruta), fix `res is not defined` en `registrarDominio`, se quitó `deploy_error` de los updates (columna inexistente), el botón apagar/reactivar ya no estaba invertido, y `set_activo` corre **síncrono en `web-factory.js`** (rápido, ~2s) mientras `create` quedó en la background function real `web-factory-background.js` (el header `X-NF-Background` quedó obsoleto en Netlify). Cosmecolo quedó correctamente suspendido; flujo verificado de extremo a extremo con Locotours.
✅ Design system compartido (15 Ago 2026): `auvro-design.css` estándar en dashboard + chat, toggle de tema claro/oscuro sincronizado (`localStorage auvrouter_theme`).
✅ Chat estable (14-15 Ago 2026): timeouts garantizados con `Promise.race`, modelo de respaldo automático (OpenAI gpt-4o-mini si DeepSeek tarda/falla).
✅ Registro y login completo (14-15 Ago 2026): perfil con trial de 30 días, confirmación por correo, registro a 2 columnas.
✅ CRM: embudo de ventas por estados + filtros por fecha/origen/agente (14 Ago 2026).
✅ Widget: catálogo de productos y fix de respuestas duplicadas (14 Ago 2026).
✅ Landing hub (`index.html`) + `paginas-web.html` + `agentes.html` rediseñadas (14 Ago 2026).
✅ **E-commerce en Web Factory (16 Ago 2026)**: plantilla `tienda` (catálogo/carrito/checkout serverless), `tienda.js` (checkout con recálculo de total en servidor + payment links Wompi con la **pasarela del cliente** por proyecto, `tienda_pasarela`), `pago-webhook.js` tipo `tienda` (marca orden pagada, descuenta stock, notificaciones), gestión de tienda en el dashboard (botón 🏪 + modal Productos/Órdenes/**Pasarela**). Desplegado en producción. Falta aplicar la migración de `tienda_pasarela` y el PoC demo.

### Pendientes del Proyecto

#### Migraciones por aplicar en Supabase (SQL Editor)
- ✅ `20260816_web_factory_activo.sql` — columna `activo` en web_projects — **APLICADA** (verificada: `select id,activo` responde).
- ⏳ `supabase/migrations/20260814_crm_embudo.sql` — índices de `crm_leads` para el embudo/filtros por fecha.
- ⏳ `supabase/migrations/20260816_web_factory_tienda.sql` — tablas de tienda (`tienda_productos`, `tienda_ordenes`, `tienda_orden_items`) + `pagos.orden_id`. **APLICADA por el usuario (16 Ago)** y verificada.
- ⏳ `supabase/migrations/20260816_web_factory_tienda_pasarela.sql` — tabla `tienda_pasarela` (claves Wompi del cliente por proyecto). **Sin aplicar, el checkout de tienda devolverá "pasarela no configurada".**
- ✅ `20260815_web_factory_color_fuente.sql` — APLICADA (columnas accent_color/fuente existen).
- ✅ Migraciones previas de web_projects — APLICADAS.

#### Configuración pendiente
- ⏳ **Site URL de Supabase Auth**: sigue en `https://jeisondigital.netlify.app` (dominio muerto). Cambiar en Supabase → Authentication → URL Configuration → Site URL a `https://auvro.netlify.app` (afecta los emails de confirmación de registro).
- ⏳ Probar E2E con credenciales reales: crear un sitio de prueba en Web Factory y verificar repo + deploy + dominio + apagado/reactivación.

#### Seguridad avanzada
- API Key única por agente.
- Firma de solicitudes.
- Rate limiting.
- Control de consumo.
- Auditoría.

#### Administración
- Panel para gestionar dominios.
- Activar/desactivar agentes.
- Métricas de uso.
- Historial de conversaciones.

#### SaaS
- Planes de usuarios.
- Límites de consumo.
- Facturación.
- Suscripciones.

#### Widget Web
- Código embebible definitivo.
- Personalización visual.
- Configuración por cliente.

#### Media WhatsApp
- ✅ Caché de medios implementada (7 Ago 2026): cada media se descarga de Meta 1 sola vez y se guarda en Supabase Storage (bucket `whatsapp-media`). El dashboard y el análisis con IA leen desde Storage. Ver changelog.
- Pendiente: subir límites de tasa de la Graph API completando Business Verification + permiso `whatsapp_business_messaging` en Meta Developer Dashboard (necesario para la primera descarga y para apps sin revisión).

---

# Esquema de Base de Datos (Reconstruido desde código)

## Tabla: planes
```
id          uuid/int PK
nombre      text
limite_agentes int
precio      numeric
```

## Tabla: perfiles
```
id              uuid PK (FK → auth.users)
token_balance   int
plan_id         uuid/int (FK → planes)
nombre          text
apellido        text
telefono        text
is_admin        boolean (default false)
```

## Tabla: agentes_ia
```
id                  serial PK
user_id             uuid (FK → auth.users)
nombre_agente       text
prompt_sistema      text
dominios_permitidos jsonb/text[]
```

## Tabla: conversaciones (REALTIME)
```
id                  uuid PK
agente_id           int (FK → agentes_ia)
user_id             uuid (FK → auth.users)
canal               text
external_user_id    text
titulo              text
estado              text
modo_humano         boolean
requiere_atencion   boolean
ultimo_mensaje      text
ultimo_role         text
intervenida_por     uuid
intervenida_en      timestamptz
created_at          timestamptz
updated_at          timestamptz
```

## Tabla: mensajes_conversacion (REALTIME)
```
id              uuid PK
conversacion_id uuid (FK → conversaciones)
agente_id       int (FK → agentes_ia)
role            text
content         text
origen          text
metadata        jsonb
created_at      timestamptz
```

## Tabla: agente_tools
```
id          serial PK
agente_id   int (FK → agentes_ia)
tool_key    text
toolkit     text
enabled     boolean
```

## Tabla: composio_connections
```
id                  serial PK
user_id             uuid (FK → auth.users)
toolkit             text
composio_entity_id  text
connected_at        timestamptz
```

## Tabla: whatsapp_connections
```
id                      serial PK
user_id                 uuid (FK → auth.users)
agente_id               int (FK → agentes_ia)
phone_number_id         text
whatsapp_business_id    text
access_token            text
phone_number            text
activo                  boolean
```

## Tabla: logs_consumo
```
id              serial PK
user_id         uuid (FK → auth.users)
agente_id       int (FK → agentes_ia)
nombre_agente   text
tokens_usados   int
created_at      timestamptz
```

## Tabla: pending_tool_actions
```
id              uuid PK
user_id         uuid (FK → auth.users)
agente_id       int (FK → agentes_ia)
conversation_id uuid (FK → conversaciones)
action          text
payload         jsonb
status          text
expires_at      timestamptz
created_at      timestamptz
```

## Tabla: push_subscriptions
```
id              serial PK
user_id         uuid (FK → auth.users)
endpoint        text
subscription    text
updated_at      timestamptz
UNIQUE(user_id, endpoint)
```

## Tabla: web_projects (Web Factory)
```
id              uuid PK (gen_random_uuid)
cliente         text
nombre          text
slug            text UNIQUE (nombre del repo / subdominio)
plantilla       text (default 'landing')
descripcion     text
dominio         text
estado          text (creando | configurando | deploying | suspending | dominio_pendiente | publicado | inactivo | error)
estado_deploy   text (building | ready | error)
dominio_estado  text (pendiente | verificado)
ssl_estado      text (pendiente | activo)
github_owner    text
github_repo     text
github_url      text
netlify_site_id text
netlify_url     text
clone_url       text
default_branch  text (rama default del repo, 'main' o 'master')
error           text
dominio_error   text (si falla registrar el dominio no bloquea el proyecto)
agente_id       bigint (agente IA embebido en el sitio, opcional)
accent_color    text (#RRGGBB color principal inyectado en la plantilla)
fuente          text (inter | poppins | montserrat | roboto | lora | playfair | oswald | sistema)
activo          boolean not null default true (false = sitio suspendido/offline)
created_by      uuid
created_at      timestamptz
updated_at      timestamptz
```
### Migraciones de Web Factory (supabase/migrations)
- `20260813_web_factory.sql` — tabla web_projects (APLICADA).
- `20260813_web_factory_branch.sql` — columna default_branch (APLICADA).
- `20260814_web_factory_personalizacion.sql` — columnas logo, slogan, whatsapp (APLICADA).
- `20260814_web_factory_dominio_error.sql` — columna dominio_error (APLICADA).
- `20260814_web_factory_agente_ia.sql` — columna agente_id (APLICADA).
- `20260815_web_factory_color_fuente.sql` — columnas accent_color, fuente (APLICADA).
- `20260816_web_factory_activo.sql` — columna activo (APLICADA, verificada por REST: `select id,activo` responde).

## RPC Function
```
increment_agent_consumption(agent_id int, tokens int)
```
Reglas de Desarrollo

Antes de realizar cambios:

No exponer claves ni secretos.
Mantener variables sensibles en Netlify.
Validar seguridad desde backend.
Documentar cambios importantes.
Evitar romper compatibilidad con Netlify Functions.
Mantener separación entre frontend, backend y base de datos.
Visión del Proyecto

AUVRO busca convertirse en una plataforma SaaS donde cualquier empresa pueda crear sus propios agentes IA personalizados, conectarlos con sus herramientas internas y publicarlos de forma segura en sus canales digitales.

Cada agente debe ser:

Independiente.
Seguro.
Configurable.
Escalable.
Multiusuario.

---

# Changelog de Cambios Técnicos

## 16 Ago 2026 — E-commerce en Web Factory (plantilla "tienda"): Ruta A serverless

**Decisión:** e-commerce **propio y modular** sobre el stack actual (Supabase + Netlify Functions + Wompi). Descartados los motores externos (WooCommerce/Medusa/Magento) porque Netlify Functions son efímeras/sin estado y **no corren PHP ni servicios persistentes**; el costo es ~$0 (pay-as-you-go de Netlify + Supabase ya pagados) y el modelo de negocio es pago único por implementación (no suscripción). No compite con WooCommerce/Magento: es un módulo vertical igual que el CRM.

**Archivos nuevos:**
- `supabase/migrations/20260816_web_factory_tienda.sql` (**APLICADA** por el usuario en SQL Editor): tablas `tienda_productos` (proyecto_id FK `web_projects` on delete cascade; nombre, descripcion, `precio_cents`, `tipo` check `fisico|digital|servicio`, imagen, archivo_url, stock, activo), `tienda_ordenes` (cliente_*, direccion, `total_cents`, `estado` check `pendiente|pagada|cancelada`, payment_link_id, transaction_id), `tienda_orden_items` (orden_id FK, producto_id, nombre, precio_cents, cantidad), `alter table pagos add column if not exists orden_id uuid`, índices. Patrón idempotente, RLS desactivada (service role).
- `supabase/migrations/20260816_web_factory_tienda_pasarela.sql` (**NUEVO — PENDIENTE DE APLICAR en Supabase SQL Editor**): tabla `tienda_pasarela` (proyecto_id PK FK `web_projects` on delete cascade, `wompi_private_key`, `wompi_events_secret`, `wompi_sandbox` default false). **Claves del cliente por proyecto, NUNCA devueltas al frontend.**
- `wf-templates/templates/tienda/` (`index.html`, `styles.css`, `README.md`, `netlify.toml`, `robots.txt`): tienda estática generada por Web Factory que habla con `https://auvro.netlify.app/.netlify/functions/tienda` (CORS *). Catálogo + carrito (localStorage) + checkout (modal cliente/dirección) + pantalla post-pago vía `?orden=` (`get_orden`). Tipos físico/digital/servicio; **servicio = CTA "Solicitar por WhatsApp"** (sin pago en línea); **digital = descarga con enlace firmado (600s)** al confirmar pago. Tokens: `{{EMPRESA}}`, `{{DESCRIPCION}}`, `{{SLOGAN}}`, `{{LOGO}}`, `{{WHATSAPP}}`, `{{SLUG}}` (nuevo token SLUG). Usa `--accent`/`--accent-dark` para `inyectarTema`.
- `netlify/functions/tienda.js`: pública `catalogo` (GET, productos activos por slug, marca `agotado`), `checkout` (POST: valida items, **recalcula el total en el servidor** — nunca confía en el front —, valida la **pasarela del cliente** ANTES de crear la orden, crea orden+items, crea payment link Wompi con la **pasarela DEL CLIENTE** de `tienda_pasarela` (`wompi_sandbox` → base sandbox/production, Bearer `wompi_private_key`; si no hay pasarela devuelve 402 "no tiene configurada su pasarela" sin crear orden huérfana), inserta `pagos` tipo `'tienda'` con `orden_id` y `user_id=proyecto.created_by`, redirige a `checkout.wompi.co/l/<id>`), `get_orden` (GET, verifica email, devuelve items + enlaces firmados si `pagada`). Admin (Bearer + `perfiles.is_admin` + ownership `proyecto.created_by === adminId`, mismo patrón que web-factory): `guardar_producto` (imagen data URL → bucket público `productos`; archivo digital data URL → bucket **privado** `tienda-digital`), `eliminar_producto`, `listar_productos`, `listar_ordenes` (incluye items por orden), `cambiar_estado_orden`, **`configurar_pasarela`** (upsert por proyecto; key/secret solo se reemplazan si `length > 5`; `wompi_sandbox` bool) y **`estado_pasarela`** (estado enmascarado: `configurada`, `sandbox`, `privada_guardada`, `secret_guardado`). Las acciones admin leen parámetros de query O body (merged). `TAMANO_MAX = 8MB`.
- `dashboard.html`: **botón 🏪 "Gestionar tienda"** en cada fila con plantilla `tienda` + **modal** con pestañas **Productos** (CRUD con subida de imagen/archivo, stock, activo), **Órdenes** (estado pendiente/pagada/cancelada + ref de transacción) y **Pasarela** (private key + events secret del cliente, toggle sandbox, badges de estado enmascarado, instrucciones del webhook Wompi → `pago-webhook`). Integrado en la vista Web Factory (no pestaña separada).
- `netlify/functions/pago-webhook.js`: **rama `pago.tipo === 'tienda'`** → marca `tienda_ordenes.estado='pagada'` + `transaction_id`, descuenta stock de productos físicos, notifica in-app al dueño (`notifications`, best-effort) y envía email de confirmación al comprador si el dueño tiene Gmail conectado. **La firma se verifica con el events secret DEL CLIENTE** (`tienda_pasarela.wompi_events_secret` vía `pagos.orden_id → tienda_ordenes.proyecto_id`); el fallback a `WOMPI_EVENTS_SECRET` de env solo aplica si no existe fila de pasarela.

**Cambio de diseño (directiva del usuario, 16 Ago):** cada tienda usa la **pasarela Wompi de su propio cliente** (como el CRM usa las claves de cada agente), NO las de la plataforma. Por eso las claves viven en `tienda_pasarela` (tabla aparte) y no en `web_projects` (que se lee con `select('*')` en `web-factory.js`). Nota webhook: en cada cuenta Wompi del cliente el webhook de eventos debe apuntar a `https://auvro.netlify.app/.netlify/functions/pago-webhook` con su events secret.

**Token nuevo:** `web-factory.js` → `valores.SLUG = slug` en `pipelineCrear` (se pasa a todas las plantillas). Manifest actualizado con `{slug:"tienda", nombre:"Tienda / E-commerce"}` (aparece solo en el select de la modal). `netlify.toml` ya tenía `included_files=["wf-templates/**"]`, así que la plantilla se empaqueta sin cambios de config.

**Bug corregido en ruta:** `generarDescargas()` no traía `tipo` en el `select` de `tienda_productos` (nunca generaba descargas digitales) — corregido añadiendo `tipo`.

**Desplegado en producción (16 Ago):** `netlify deploy --prod` OK (29 funciones + plantilla). Verificado en vivo: `catalogo` 404 correcto y `checkout` con slug inválido → "Carrito vacío o slug inválido". Migración de tienda aplicada y verificada (tablas vacías). Wompi del entorno es **producción** (`prv_`, sin `WOMPI_SANDBOX`); el modo sandbox depende del flag `wompi_sandbox` de cada proyecto.

**Pendiente para producción:** crear la tienda demo desde el dashboard (plantilla "Tienda / E-commerce", slug nuevo — `esteticalcolombia` ya existe como belleza, no reutilizar; `techsoacha` ya existe como tienda de prueba), configurar 🏪→Pasarela con las keys del cliente, 🏪→Notificaciones (conectar el Gmail del cliente + correos/WhatsApp de aviso) y cargar productos (físico/digital/servicio). Migraciones aplicadas a la fecha: tienda (tablas), pasarela, `pagos_tipo_tienda` (fix checkout) y `tienda_notificaciones` (columnas de avisos). PoC scratch: proyecto `tienda-poc` (id `98e9a58e-7b6f-4807-adcf-ea502deaf362`) + JSON de 3 productos para insertar por API (o SQL).

## 16 Ago 2026 — Notificaciones de tienda (Gmail del cliente + avisos de ventas)

**Objetivo:** que el DUEÑO de cada tienda (el cliente de la agencia) reciba aviso por correo (y opcional WhatsApp) cuando alguien hace un pedido y cuando se confirma el pago, usando el **Gmail del propio cliente** conectado vía Composio (espejo del "Conectar" de las integraciones del agente).

**Diseño (validado E2E en producción, deploy `6a82139a32cefe4267de904b`):**
- **Migración `20260816_tienda_notificaciones.sql`** (+ se repite el fix `pagos_tipo_check` por idempotencia): columnas en `tienda_pasarela` → `composio_gmail_entity_id`, `gmail_conectado_email`, `notify_on_new_order boolean default true`, `notify_on_payment boolean default true`, `notify_emails jsonb`, `notify_whatsapp_agente_id`, `notify_whatsapp_numero`.
- **`conectar-gmail-tienda.js`** (nueva función): acciones `link` (crea OAuth de Google con namespace Composio `tienda:<proyecto_id>`, aisla el Gmail de cada cliente) y `guardar` (tras el callback, guarda el entity en `tienda_pasarela`). El OAuth vuelve a `dashboard.html?tienda_gmail=<id>` y el dashboard llama a `guardar` solo.
- **`notifications.js`**: `sendEmail` acepta `composioEntityId`/`composioUserId` (conexión de tienda); helpers `sendTiendaEmail` (usa el Gmail de la tienda y cae al del dueño `created_by` si no hay) y `notificarTienda` (envía a `notify_emails` + WhatsApp del agente si hay). `parseNotifyEmails` separa por comas.
- **`tienda.js`**: en `checkout`, tras registrar el pago, aviso de **nuevo pedido** si `notify_on_new_order` (productos, total, cliente). Acciones admin `estado_notificaciones` (devuelve config + agentes del dueño para el select de WhatsApp), `configurar_notificaciones` (upsert) y `desconectar_gmail`.
- **`pago-webhook.js`**: en `tipo==='tienda'`, tras marcar pagada + stock + in-app + confirmación al comprador, aviso al dueño si `notify_on_payment` (monto, productos, ref). Best-effort: si falla la notificación no rompe el pago.
- **`dashboard.html`**: pestaña **Notificaciones** en el modal 🏪 (estado del Gmail de la tienda + botón Conectar/Desconectar, checkboxes de eventos, correos de aviso, selector de agente WhatsApp + número).

**Verificado E2E en producción** con admin de prueba + proyecto tienda de prueba (creado y eliminado): `estado_notificaciones` defaults (newOrder/pay ON, gmail off, agentes), `configurar_notificaciones` guarda y se lee (toggles + emails), `conectar-gmail-tienda link` devuelve `redirectUrl` real (`connect.composio.dev/link/lk_...`). Sin efectos colaterales sobre `techsoacha`/otros sitios.

## 16 Ago 2026 — Catálogo de tienda: categorías, atributos y variantes (modelo CRM)

Se replica en tiendas el modelo del catálogo CRM (`crm_config_agente.catalogo`): categorías + atributos + variantes, para productos físicos, digitales y servicios (turismo/paquetes).

- **Migración `20260816_tienda_categorias.sql`**: columnas `categoria text`, `atributos jsonb`, `variantes jsonb` en `tienda_productos` (+ índice por `(proyecto_id, categoria)`).
- **`tienda.js`**: `catalogo` devuelve `categorias` (lista única) y cada producto con `categoria/atributos/variantes`; `agotado` se calcula por variante (si hay variantes, se agota cuando todas lo están). `checkout` acepta `variante_id` por item: valida la opción, calcula precio = base + delta, valida stock por variante y guarda el nombre de la línea como "Producto (Opción)". `guardar_producto` acepta y normaliza `categoria`, `atributos` (objeto clave:valor) y `variantes` (`[{id,nombre,precio_cents,stock}]`).
- **`dashboard.html`**: formulario de producto con **Categoría = select fijo** (`CATEGORIAS_TIENDA`: Tecnología y Electrónica, Moda y Accesorios, Hogar y Decoración, Electrodomésticos, Belleza y Cuidado Personal, Salud y Bienestar, Deportes y Aire Libre, Bebés y Juguetería, Mascotas, Papelería y Oficina, Otros) para que el dueño no escriba; Atributos (clave: valor por línea) y Variantes dinámicas (nombre, precio adicional COP, stock por opción). Lista de productos muestra categoría y nº de opciones.
- **Plantilla `tienda`**: chips de filtro por categoría, badges de categoría, lista de atributos y selector de variantes (píldoras) con precio dinámico; el carrito distingue por producto+variante (key) y el checkout envía `variante_id`.
- **Nota**: el storefront es estático y se hornea al crear el sitio; las tiendas YA creadas (`techsoacha`, etc.) conservan el template anterior hasta recrearse. La lógica backend (categorías/atributos/variantes en catálogo y checkout) sí aplica a cualquier tienda al instante.

## 17 Ago 2026 — E-commerce evolucionado (modelo WooCommerce) en tiendas — plantilla reutilizable

Evolución de TechSoacha a un e-commerce completo multi-tenant (todo particionado por `proyecto_id`), reutilizable por WebFactory para futuras tiendas. No se rompió nada existente: los productos previos (`fisico/digital/servicio`) se normalizan en lectura (`fisico` → `simple`).

- **Migración `20260817_tienda_ecommerce.sql`**: tablas `tienda_categorias`, `tienda_atributos` (reutilizables), `tienda_variaciones` (combinaciones con sku/precio/promo/stock/imagen/activo), `tienda_clientes`. Columnas nuevas: `tienda_productos.categoria_id/atributos_selector/sku/archivos`, `tienda_ordenes.estado_pago/metodo_pago/cliente_id`, `tienda_orden_items.variacion_nombre/sku/variacion_id`. El CHECK `tienda_productos_tipo_check` se amplió a `(fisico, simple, variable, digital, servicio)`.
- **`tienda.js`** (reescrito conservando helpers/pasarela/notificaciones): tipos `simple/variable/digital/servicio`; generación **cartesiana de variaciones** (`generarVariaciones`, clave `atributo_id:valor` ordenado); `guardar_producto` sincroniza variaciones (upsert por clave preservando ediciones, borra combinaciones removidas); `guardar_variaciones` (edita precio/promo/stock/sku/imagen/activo por variación); CRUD `categorias`/`atributos` (reutilizables, `eliminar_atributo` regenera variaciones de los productos afectados); `catalogo` devuelve categorías + `atributos_selector` + `variaciones` + `precio_desde` y `agotado` por variación; `checkout` valida `variacion_id` (opción completa, stock por variación, precio promo>precio>base), crea/actualiza `tienda_clientes`, orden con `estado_pago='pendiente'`/`metodo_pago='wompi'`, líneas con `variacion_nombre`+`sku`+`variacion_id`; `listar_ordenes` incluye `numero`; `listar_clientes`.
- **`pago-webhook.js`**: al confirmar pago de tienda marca `estado_pago='pagado'`, descuenta stock (por variación si aplica, o del producto simple) y actualiza el cliente (`pedidos`, `total_cents`).
- **`dashboard.html`**: pestañas **Productos · Categorías · Atributos · Órdenes · Clientes · Pasarela · Notificaciones**. Producto por tipo (Simple/Variable/Digital/Servicio), categoría desde las administradas, selector de atributos (marca atributo + valores) que genera combinaciones, y **editor de variaciones** (SKU, precio, promo, stock, imagen, activo) tras guardar un producto variable. Gestión de Categorías y Atributos (reutilizables), tabla de Clientes, órdenes con N°, estado de pago, método y ref.
- **Plantilla `tienda`**: selector de atributos por producto variable (el cliente elige cada atributo → la variación exacta → precio promo/precio, stock, SKU), no permite agregar variación incompleta ("Elige las opciones"), carrito con líneas independientes por combinación (`ROMA / Negro / M`), checkout envía `variacion_id`, confirmación de pedido depende del pago real (webhook). Galería multi-imagen, chips de categoría, responsive.
- **Correcciones del ciclo de pruebas**: `guardar_variaciones` referenciaba `updated_at` inexistente en `tienda_variaciones` (quitado); upsert de cliente con `onConflict` sobre índice `lower(email)` no funcionaba → patrón select-then-insert (el índice único previene duplicados).
- **Validación E2E en producción** (proyecto/tienda de prueba, limpiado al final): categoría Relojes, atributos Color+Talla, producto simple, **variable con Color(Negro,Blanco)×Talla(S,M,L)=6 variaciones**, edición de variaciones (promo $110.000 aplicada → `precio_desde`), digital, catálogo, checkout incompleto (rechaza), agotado (rechaza), checkout válido → orden `ROMA / Negro / M` x1 $110.000 con SKU y variación, cliente creado. Wompi link borrado tras la prueba.
- **TechSoacha actualizada en vivo**: template regenerado con los tokens de la tienda y pusheado al repo `JeisonCastro/techsoacha` → Netlify redeploy automático (deploy `d339410f6673`). Verificado en producción: `attr-selector`, `data-aid`, "Elige las opciones", `promo`, `auvro-theme`.

## 17 Ago 2026 — Módulo de gestión de tienda (página dedicada tipo WooCommerce)

El botón **"Gestionar tienda"** del panel ya no abre un modal: redirige a **`tienda-admin.html?proyecto=<id>`**, un módulo independiente con experiencia WooCommerce y navegación lateral:

- **Secciones**: Resumen (stats + accesos rápidos), Productos, Categorías, Atributos, Órdenes, Clientes, Pasarela, Notificaciones.
- **Productos**: crear/editar por tipo (Simple/Variable/Digital/Servicio), categoría (desde las administradas), ficha técnica, selector de atributos de variación, varias imágenes (URL o subida), archivo digital, y **editor de variaciones** (SKU, precio, promo, stock, imagen, activo).
- **Categorías / Atributos**: CRUD; los atributos son reutilizables entre productos.
- **Órdenes / Clientes**: tablas con N°, estado de pago, método, ref, y total por cliente.
- **Pasarela / Notificaciones**: mismas funcionalidades que el modal (keys Wompi del cliente, conexión Gmail de la tienda vía Composio, avisos por correo/WhatsApp).
- **Auth**: usa la sesión de Supabase (redirige a `login.html` si no hay sesión); todas las llamadas usan `tienda.js` con validación de dueño (`perfiles.is_admin` + `proyecto.created_by`).
- **Backend**: nueva acción `info` (datos de la tienda para el header) y `conectar-gmail-tienda` acepta `redirectTo` (el OAuth de Gmail vuelve a `tienda-admin.html?tienda_gmail=...`).
- El modal antiguo en `dashboard.html` queda inactivo (no se elimina para no tocar código compartido), pero el botón redirige a la página.
- **Validado en producción** (deploy `6a823703c5eb6af31f22583d`): `tienda-admin.html` se sirve (HTTP 200, 52 KB) y las acciones que usa la página (`info`, listar productos/categorías/atributos/órdenes/clientes, estado pasarela/notificaciones) responden OK con un admin de prueba; recursos de prueba limpiados.

## 17 Ago 2026 — Estilos compartidos del panel (dashboard.css)

Los estilos del panel AUVRO se extrajeron del `<style>` inline de `dashboard.html` a **`dashboard.css`** (misma fuente única). `dashboard.html` y `tienda-admin.html` enlazan el mismo CSS → el módulo de gestión de tienda usa **exactamente el mismo diseño** (variables, sidebar, botones `btn-main`/`btn-small`, cards, tablas, badges, modo claro/oscuro con toggle persistente) que el panel. Deploy `6a8239109a55fb90f0b883a7`.

## 17 Ago 2026 — Categorías preestablecidas por defecto (seeding)

Las categorías vuelven a venir **preestablecidas** (el set original: Tecnología y Electrónica, Moda y Accesorios, Hogar y Decoración, Electrodomésticos, Belleza y Cuidado Personal, Salud y Bienestar, Deportes y Aire Libre, Bebés y Juguetería, Mascotas, Papelería y Oficina, Otros). `tienda.js` las **siembra la primera vez** (`sembrarCategoriasSiVacio`, upsert idempotente por `(proyecto_id, nombre)`) tanto al listar categorías (admin) como en el catálogo público; el admin sigue pudiendo **crear/eliminar** categorías desde el módulo. Validado E2E en producción: 11 categorías sembradas y devueltas por `listar_categorias` y `catalogo`. Deploy `6a823ad7ee2b64245928ae1e`.

## 16 Ago 2026 — Fix: el create de Web Factory fallaba en silencio (background functions)

**Bug:** las background functions de Netlify (`web-factory-background`) responden **siempre `202 Accepted` con body vacío** (el resultado real se descarta y solo vive en los logs). `dashboard.html` `crearProyectoWeb()` leía ese body (`data.ok`/`data.error`) → **siempre parecía éxito** ("Sitio en creacion. El estado se actualiza solo.") aunque la función fallara (token vencido, error en Supabase, etc.). Resultado: al crear "storecase" no aparecía ninguna fila ni error.

**Fix:**
- `dashboard.html` `crearProyectoWeb()`: ya no confía en el body del 202. Hace **polling con la nueva acción `get_by_slug`** cada 4s (máx. 3.5 min) hasta que la fila exista (pipelineCrear la inserta en paso 1) y muestra el estado real: `estado==='error'` → toast con el `error` del backend; sin fila al agotar → mensaje de no-respuesta; si `get_by_slug` devuelve 401 (token vencido) → corta de inmediato pidiendo re-login.
- `web-factory.js`: nueva acción admin `get_by_slug` (consulta por slug, sin reconciliación de dominios).
- `web-factory-background.js`: `console.log/error` en inicio, éxito y fallos (auth incluida) para que Netlify → Functions → Logs muestre el motivo real.

**Conclusión del incidente (CAUSA RAÍZ ENCONTRADA y CORREGIDA):** el create background era el primer sitio creado desde el cambio a background functions (16 Ago). Al probarlo se encontró el error real con un E2E controlado (usuario admin de prueba + invocación a producción):

- **Causa raíz:** `web-factory-background.js` hacía `const wf = require('./web-factory.js')` y llamaba `wf.validarSlug / wf.validarDominio / wf.validarAccent / wf.pipelineCrear`, pero esas funciones viven en `module.exports.helpers`, no al nivel raíz → la primera llamada (`wf.validarSlug(slug)`) lanzaba `TypeError: wf.validarSlug is not a function` → el handler devolvía 500 → **Netlify descarta el error en silencio** (el 202 ya se envió al cliente) → nunca se insertaba la fila.
- **Fix:** `const wf = require('./web-factory.js').helpers;` en `web-factory-background.js`, y `Object.assign(module.exports, module.exports.helpers)` al final de `web-factory.js` (expone los helpers también al nivel raíz, a prueba de balas).
- **Segundo bug UX (dashboard):** el polling chequeaba `p.ok === false`, pero una respuesta 401/403/500 viene como `{error}` SIN campo `ok` → seguía esperando los 3.5 min en vez de cortar. Corregido a `if (!r.ok) { fallo = ...; break; }`.
- **Verificado en producción (deploy `6a81d20211767fea5535f6d4`):** usuario admin de prueba → `POST web-factory-background` → 202 → **12 s después la fila existía** (`estado: "deploying"`, `github_repo` + `netlify_site_id` creados, plantilla `tienda`). Recursos de prueba eliminados después.
- **Lección:** el bundle de esbuild enlaza correctamente `web-factory.js`; el error era puramente de exportación (`require` vs `.helpers`). Los errores de las background functions solo viven en Netlify → Functions → Logs.



**Síntoma reportado por el usuario:** "el botón de apagado no ejecuta el apagado ni cambia estados ni apaga el sitio". El usuario espera: clic en ⚡ → se apaga de verdad → el overlay de espera se mantiene mientras apaga → al terminar el botón queda ▶ (play) para reactivar.

**Diagnóstico:** con la arquitectura de background function, el cliente recibe **202 + body vacío** al instante, así que:
- El overlay de espera se cerraba en ~1ms (no se veía).
- Si la función background falla en silencio (auth, env, bundle), el usuario NO ve ningún error: no cambian estados ni se apaga el sitio.
- `netlify logs --function web-factory-background` mostró que los clics del usuario **no generaban invocaciones** (el dashboard viejo en caché seguía llamando al endpoint síncrono), y el 202 silencioso enmascaraba cualquier fallo.

**Rediseño (correcto por duración):**
- `set_activo` (apagar/reactivar) es **RÁPIDO** (~2s: publicar el file deploy de suspensión + 2 updates de BD; reactivar solo dispara el build, ~1s). Ahora corre **SÍNCRONO en `web-factory.js`** (mismo sitio que `list`/`refresh_status`, que ya funcionan en producción): el cliente recibe el **JSON real con ok/error**, el overlay dura mientras apaga y los errores se ven en el toast.
- **`create`** sigue en la **background function** `web-factory-background.js` (el pipeline GitHub+Netlify+dominio SÍ es largo). Se eliminó `set_activo` de esa función.
- `dashboard.html` → `toggleActivoWeb` vuelve a llamar a `/.netlify/functions/web-factory` (síncrono). Toasts nuevos: "Sitio apagado" / "Sitio reactivado (build en curso)".

**Verificado de extremo a extremo con la lógica real (helpers exportados) sobre Locotours:** apagar → marca `suspending` → publica la página de suspensión (el sitio sirve HTTP 200 con "suspendido") → `inactivo/ready`; reactivar → `deploying` + build disparado. Luego se restauró con el build de GitHub.

**Nota de diseño:** una acción que el usuario espera que termine "mientras espera" debe ser síncrona si cabe en el límite (10s); las background functions solo para pipelines largos, y siempre con el estado final visible por polling (`refresh_status`).

## 16 Ago 2026 — Fix: botón apagar/reactivar invertido en el panel de Web Factory

**Síntoma:** todos los sitios activos muestran el icono de apagar (⚡), pero al hacer clic el confirm decía "Se redesplegará desde GitHub, tardará 1-2 minutos" (mensaje de REACTIVAR), en vez de "Apagar el sitio...".

**Causa:** `toggleActivoWeb(id, activoActual, nombre)` en `dashboard.html` calculaba `const apagar = !activoActual`. El parámetro `activoActual` ya llega con el significado "¿está activo ahora?" (los botones pasan `true` en sitios activos / `false` en inactivos), así que el `!` invertía la acción: para un sitio activo salía el flujo de reactivar.

**Fix:** `const apagar = activoActual;` (si está activo → apagar; si está inactivo → reactivar). El payload sigue enviando `activo: !activoActual` (el estado objetivo es el contrario del actual), que ya era correcto. Con esto: activo → confirm "Apagar el sitio..." + `activo:false`; inactivo → confirm "Reactivar..." + `activo:true`.

## 16 Ago 2026 — Fix: apagar/reactivar sitios no funcionaba (deploy de suspensión nunca subía el archivo) + background functions reales

**Síntoma reportado:** al desactivar un sitio (p.ej. Cosmecolo) el panel mostraba `✕ Error: No se pudo ejecutar la acción`, la BD quedaba atascada en `estado='suspending', activo=false` y el sitio seguía en línea.

**Causa raíz (3 bugs encadenados):**
1. **`publicarSuspension` nunca subía el archivo**: `deploy.required` de la API de Netlify contiene los **SHA1 (digest)** de los archivos que faltan, NO las rutas. El bucle hacía `files['/' + digest]` → `undefined` → `continue` y no subía nada. El deploy quedaba en `state='uploading'` para siempre.
2. **Timeout síncrono de 10s**: el header `X-NF-Background` **ya no es el mecanismo de background en Netlify** (obsoleto; ahora es `config.background` o el sufijo `-background` en el nombre del archivo). La función corría **síncrona** y Netlify la mataba a los ~10s mientras el deploy estaba en `uploading` → respuesta 502 (no-JSON) → el panel mostraba el mensaje genérico y el `catch` de revert NUNCA llegaba a ejecutarse (la BD quedaba en `suspending`).
3. **`registrarDominio` con `res` fuera de scope** (`res is not defined`): `const res` vivía dentro del `for`, se usaba después del bucle → `ReferenceError`. Se veía en `web_projects.dominio_error` de varios proyectos.

**Fixes aplicados:**
- `web-factory.js` → `publicarSuspension`: mapeo `digest → ruta` para subir los archivos que Netlify realmente necesita (fallback: subir todos los nuestros). **Verificado con la API real: el deploy pasa a `ready` en ~2s.**
- `web-factory.js` → `registrarDominio`: `let res` fuera del bucle.
- `web-factory.js` → se quitó `deploy_error` de los updates (esa columna **no existe** en `web_projects`; solo era un campo interno de `consultarEstadoNetlify` que `refrescarYGuardar` ya descartaba). Dejarlo en un update producía `PGRST204` y rompía el flujo.
- **Background function real `netlify/functions/web-factory-background.js`** (sufijo `-background` = background en Netlify, hasta 15 min): inicialmente albergó `create` y `set_activo`. Tras el Fix v3 (misma fecha) **solo alberga `create`**; el `set_activo` volvió al handler síncrono (es rápido y así el cliente recibe el ok/error real). Se exportaron además los helpers `actualizarProyecto` y `dispararBuild`.
- `web-factory.js` (síncrono): `list`, `get`, `refresh_status`, `delete` **y `set_activo`** (apagar/reactivar). `create` responde 400 con aviso de usar la función background.
- `dashboard.html`: `crearProyectoWeb` llama a `/.netlify/functions/web-factory-background` (202 + polling); `toggleActivoWeb` llama a `/.netlify/functions/web-factory` (síncrono, JSON real). Se eliminó el header `X-NF-Background` (obsoleto).
- **Cosmecolo (datos reales)**: se publicó la página de suspensión correcta con la lógica corregida (el deploy anterior quedó atascado y además una prueba local había publicado una página "TEST") y se reseteó la BD a `activo=false, estado='inactivo', estado_deploy='ready'`, limpiando `error` y `dominio_error`. El sitio quedó apagado correctamente (verificado: sirve la página "El sitio de Cosmecolo está suspendido").

**Lección:** el `X-NF-Background` no garantiza background en Netlify actual; las funciones largas DEBEN declararse background con el sufijo `-background` (o `config.background`) y nunca depender de un header para operaciones que tardan más de 10s.

## 15 Ago 2026 — Web Factory: apagar/reactivar sitios (suspensión por impago de demos)

- **Nueva acción `set_activo` en `web-factory.js`** (solo admin, verificado con el mismo patrón de `admin-data.js`): apaga o reactiva un sitio desde el panel.
  - **Apagar** (`activo:false`): publica un *file deploy* directo (sin build y sin tocar el repo de GitHub) en el sitio de Netlify con un único `index.html` = página self-contained "Este sitio está suspendido" (dark, con el nombre del negocio). El sitio queda offline en segundos. Flujo: marca en BD `activo=false, estado='suspending'` → `publicarSuspension()` (deploy vía digest SHA1 + `PUT /deploys/{id}/files/index.html` + polling hasta `ready`) → `estado='inactivo', estado_deploy='ready'`. Si falla, revierte a `activo=true, estado='publicado'`.
  - **Reactivar** (`activo:true`): `dispararBuild(siteId)` redespliega desde el repo (el sitio real sigue intacto en GitHub; el file deploy no lo modifica) → `estado='deploying'` → `publicado` al terminar (1-2 min).
  - `refrescarYGuardar` fuerza `estado='inactivo'` cuando `activo === false` (evita que el refresh de Netlify lo vuelva a marcar `publicado`).
  - La acción corría en la **background function real** `web-factory-background.js` (sufijo `-background`). **Corrección (Fix v3, 16 Ago):** `set_activo` es rápido y pasó a síncrono en `web-factory.js` para que el cliente reciba el ok/error real; el dashboard hace polling del estado intermedio `suspending` (añadido a la lista de estados en curso).
- **Panel (`dashboard.html`)**: botón de encendido/apagado por sitio (⚡ apagar / ▶ reactivar, con confirmación), badge rojo **Suspendido** para `estado='inactivo'`, estado **Apagando…** para `suspending`, fila atenuada (`opacity:.6`) y link `offline` cuando está apagado. Nueva función `toggleActivoWeb(id, activoActual, nombre)`.
- **Migración `supabase/migrations/20260816_web_factory_activo.sql` (NUEVO, APLICADA)**: `alter table web_projects add column if not exists activo boolean not null default true;`. Sin la columna, `set_activo` responde un aviso claro de ejecutar la migración (detección de error `42703`).
- **`estado` ampliado**: `creando | configurando | deploying | suspending | dominio_pendiente | publicado | inactivo | error`.
- **Helpers exportados nuevos**: `paginaSuspension`, `sha1hex`, `publicarSuspension`.

## 15 Ago 2026 — UI: design system compartido (auvro-design.css) en dashboard + chat + Web Factory

- **Nuevo `auvro-design.css`** (raíz): design system "landing inspired" que nació como bloque inline del dashboard (`72333d4`) y se extrajo a archivo compartido (`c033a3d`). Contiene tokens dark/light con `!important` (`--bg #0a0d14`/`#f6f8fb`, `--surface`, `--accent #3b82f6`/`#2563eb`, `--green/--red/--yellow`, `--bubble-*`, sombras), base/micro-UX (Inter, letter-spacing, scrollbars finas, focus rings, keyframes `auvroViewIn`), sidebar, botones pill (`.btn-main/.btn-ghost/.btn-green/.btn-wa/.btn-small`), forms, tablas, badges, toasts, plan cards/upgrade, bandeja/chat, agentes, modales, mobile nav, y `prefers-reduced-motion`. **Es el estándar visual de `dashboard.html` y `chat.html`** (ambos lo enlazan con `<link rel="stylesheet" href="auvro-design.css">` tras su `</style>`).
- **Dashboard (`dashboard.html`)**: se eliminó el bloque CSS inline (~342 líneas) y se reemplazó por el link al CSS compartido (un único link en `<head>`).
- **Chat (`chat.html`)**: ahora comparte el design system; se eliminaron sus tokens propios (`:root`/`body.light-mode`), sustituidos por un comentario que apunta al CSS compartido. **Toggle de tema claro/oscuro** idéntico al dashboard: botón `.theme-toggle-btn` (iconos sun/moon) + `toggleTheme()` con la MISMA regla del dashboard — `localStorage 'auvrouter_theme'` (default `'light'`), `body.light-mode` = claro (ausencia de la clase = oscuro) — y un script temprano justo tras `<body class="light-mode">` que quita la clase si el tema guardado es `'dark'`. Refinamientos dark propios (`body:not(.light-mode)`): burbuja de error del agente, inputs/composer/back-btn, sombras de burbuja. Fuente del chat: Inter (restos de `DM Sans` — que ya no se cargaba — sustituidos por Inter).
- **Web Factory: personalización color + fuente**:
  - Modal "Nuevo sitio web": campos **Color principal** (input color + campo texto hex validado `#RRGGBB`, expande 3→6 dígitos) y **Estilo de fuente** (8 opciones: Inter, Poppins, Montserrat, Roboto, Lora, Playfair Display, Oswald, Sistema) con **vista previa en vivo** (`.wf-preview`) que carga la fuente Google dinámicamente.
  - Backend `web-factory.js`: mapa `FUENTES_GOOGLE`, `FUENTE_SISTEMA`, y helpers `validarAccent` / `oscurecerHex` (×0.82) / `fuenteElegida` / `inyectarTema` — inyecta antes de `</head>` un `<style id="auvro-theme">:root{--accent:X!important;--accent-dark:Y!important}*{font-family:F!important}</style>` + link de Google Fonts (las 10 plantillas definen `--accent`/`--accent-dark` en su `:root`, así el override funciona en todas). Nuevos tokens de plantilla: `ACCENT`, `ACCENT_DARK`, `FONT_FAMILY`, `FONT_NAME`, `FONT_LINK`. Guarda `accent_color` + `fuente` en `web_projects`.
  - **Migración `supabase/migrations/20260815_web_factory_color_fuente.sql` (NUEVO, APLICADA)**: columnas `accent_color text`, `fuente text`. El pipeline reintenta el insert sin esas columnas si falla con error `42703` (retrocompatible con BD sin migrar).
  - El panel muestra un punto de color en la columna Plantilla cuando el proyecto tiene `accent_color`.
- **Nota de encoding (lección):** al editar `dashboard.html` con `Get-Content`/`Set-Content` se corrompieron los acentos (mojibake). Se restauró con `git checkout -- dashboard.html` y se rehicieron los cambios con `[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)` (LF, sin BOM). **Regla: nunca volcar HTML con acentos con Get-Content/Set-Content; usar lectura/escritura byte-safe.**

## 15 Ago 2026 — Web Factory: fix 502 (Directory import) y carpeta de plantillas

- **Fix 502 "Directory import '/var/task/web-factory'"**: Netlify intentaba importar la función `web-factory.js` como directorio porque existía `web-factory/templates/`. Solución: **renombrar `web-factory/templates` → `wf-templates/templates`** (10 plantillas, R100) y actualizar `included_files` en `netlify.toml` + los candidatos de `templatesDir()` en `web-factory.js`.
- **Fix 502 (require sin extensión)**: `chat.js` usaba `require('./web-factory')`; ahora `require('./web-factory.js')` para no caer en Directory import.
- **Plantillas (10)**: `landing, restaurante, abogados, odontologia, belleza, gimnasio, inmobiliaria, construccion, salud, turismo`; cada una con `index.html`/`styles.css`/`netlify.toml`/`robots.txt`/`README.md`. Todas usan `--accent`/`--accent-dark` en su `:root` (clave para el override de color/fuente) e iconos SVG (sin icon-fonts).

## 15 Ago 2026 — Registro y login completo (prueba de 30 días)

- **`netlify/functions/registrar-perfil.js` (NUEVO)**: guarda nombre/apellido/teléfono justo tras el `signUp` usando el `user_id` de `data.user.id` (sin depender de triggers ni de `getUserByEmail`). Como `perfiles.email` es NOT NULL, toma el email del body o de `auth.admin.getUserById`. Crea la fila completa del plan gratis (`plan_id 1`, `token_balance 5000`) con `upsert onConflict id ignoreDuplicates` (no pisa planes pagados) y asigna `plan_inicio`/`plan_vencimiento` = **trial de 30 días** solo a filas de plan gratis sin vencimiento (`.is('plan_vencimiento', null)`).
- **`login.html`**: formulario de registro a 2 columnas + tarjeta con scroll interno (420px); fix de ids `card-title`/`card-sub` (toggleModo roto); pantalla "Revisa tu correo" tras registrar; procesa el token de confirmación por correo desde el hash y entra al dashboard; fix de la URL de confirmación a `auvro.netlify.app`; log de errores de `registrar-perfil` en el cliente.

## 14 Ago 2026 — CRM: embudo de ventas por estados + filtros

- **`netlify/functions/crm.js`**: el listado de leads acepta filtros por query string `desde`/`hasta` (ISO sobre `created_at`), `origen` y `agente_id` (aplicados también al resumen). Nueva respuesta `resumen_estados`: conteo de leads y suma de `valor_venta_cents` por estado (consulta agregada sin límite de filas), con orden por `orden` y una entrada "Sin estado" si hay leads sin estado.
- **Panel CRM (`dashboard.html`)**: embudo de ventas por estados (totales y montos) + filtros por fecha/origen/agente.
- **Migración `supabase/migrations/20260814_crm_embudo.sql` (NUEVO, PENDIENTE de aplicar)**: índices `idx_crm_leads_user_created (user_id, created_at)` e `idx_crm_leads_agente_created (agente_id, created_at)` para acelerar los filtros por fecha.

## 14 Ago 2026 — Chat: timeouts garantizados y modelo de respaldo

- **Fix muertes a los 30s (502)**: el `res.json()` de undici a veces no rechaza con el socket colgado y la función moría a los 30s. Ahora `Promise.race` garantiza el corte en `chat.js`: DeepSeek 16s, respaldo 6s, `deepseekJSON` 5s. Se añadieron timings post-modelo.
- **Modelo de respaldo automático**: si DeepSeek tarda o falla, se usa OpenAI `gpt-4o-mini` (8s), configurable vía `FALLBACK_MODEL`/`FALLBACK_API_KEY`/`FALLBACK_API_URL`; la respuesta incluye el proveedor usado.
- **Reducción de timeouts IA**: `max_tokens 1024`, historial 6 turnos, catálogo truncado, timeout 29s.
- **`crm-helper.js`**: `deepseekJSON` de extracción de lead pasa de 12s a 5s (best-effort).

## 14 Ago 2026 — Widget + landing: catálogo, dedup y hub

- **Widget (`widget.js`)**: botón de catálogo con tarjetas de producto (mismo lenguaje que `chat.html`); fix de respuestas duplicadas en el chat web (dedup en render del widget + guard anti-duplicado en `chat.js` para el canal web + network-first en `sw.js`).
- **Landing hub (`index.html`)** rediseñada como hub + **nueva `paginas-web.html`** (landing de páginas web con agente IA embebido). **`agentes.html`** rediseñada con el mismo lenguaje visual del hub y `paginas-web`.

## 14 Ago 2026 — Web Factory: el agente puede crear demos de sitios en la conversación

- **Nueva herramienta nativa `WEBFACTORY_CREAR_DEMO`**: los agentes ya pueden vender/crear la demo directamente en el chat. Aparece como una app **"Web Factory"** (tipo `nativo`, sin conexión Composio) en **Integraciones del agente** → checkbox *"Crear sitio web demo en la conversación"* (se guarda en `agente_tools` con toolkit `webfactory`).
- **Solo admin**: `chat.js` valida `perfiles.is_admin` del dueño del agente antes de crear; si no es admin, responde que la opción no está disponible. (Pendiente de extensión a un plan Plus de pago.)
- **Ejecución**: el agente recopila `nombre` (negocio), `cliente` y opcionalmente `plantilla`/`descripcion`/`slogan`/`logo`/`whatsapp`; `chat.js` llama al `pipelineCrear` de `web-factory.js` (ahora exportado en `helpers`) con `agente_id = targetID` → la demo embebe el widget del agente vendedor y sus dominios quedan autorizados automáticamente (lógica de `garantizarDominiosAgente`).
- **Prompt**: `tool-workflows.js` incluye la definición `WEBFACTORY_CREAR_DEMO` y reglas de uso en `construirToolsDescription` (con la lista de plantillas: landing, restaurante, abogados, odontologia, belleza, gimnasio, inmobiliaria, construccion, salud, turismo).
- **`toolsDisponibles`**: en `chat.js` se añade el set `TOOLKITS_NATIVOS = ['webfactory']` para que las herramientas nativas queden disponibles sin conexión Composio (el resto sigue requiriendo toolkit conectado).
- **Nota de tiempo**: el pipeline se ejecuta sincrónico en el turno del chat (puede tardar ~5-15s en crear repo GitHub + site Netlify); el deploy continúa en background de Netlify.

## 14 Ago 2026 — Web Factory: agente de IA embebible en sitios generados

- **Seguridad por dominio del agente automatizada (14 Ago)**: el widget de chat.js exige que el Origin del sitio embebido esté en `agentes_ia.dominios_permitidos`, así que ahora `web-factory.js` autoriza automáticamente el subdominio de Netlify (`<site>.netlify.app`) y el dominio personalizado (variantes `dominio` y `www.dominio`) en el agente del sitio: al crearlo (`pipelineCrear`) y de forma idempotente al listar (repara los sitios ya creados con `agente_id`). Esto elimina el error `403 Seguridad: Este agente no tiene dominios configurados / Este dominio no está autorizado`. Nuevos helpers exportados: `hostnameDeUrl`, `hostnamesParaSitio`, `garantizarDominiosAgente`.
- **Subdominio siempre relacionado al slug (14 Ago)**: `crearSitioNetlify` intenta `slug`, luego `slug-1` … `slug-20`; solo si todos están tomados Netlify genera uno aleatorio (ya no se va a un aleatorio a la primera).
- **Formulario a 2 columnas**: el modal de crear sitio ahora usa grid de 2 columnas (1 en móvil) sin cambiar ids ni comportamiento; se añadió el campo **Agente de IA** (select con los agentes del admin, opcional).
- **Backend `web-factory.js`**: `pipelineCrear` valida que el `agente_id` exista y pertenezca al admin (antes de insertar), guarda `web_projects.agente_id` e inyecta el widget `<script src="https://auvro.netlify.app/widget.js" data-id=... data-name=...>` justo antes de `</body>` del `index.html` generado. Nuevos helpers exportados: `crearSnippetAgente`, `inyectarWidgetIndex` (escape estricto de atributos).
- **Migración `supabase/migrations/20260814_web_factory_agente_ia.sql` (NUEVO)**: columna `agente_id bigint` en `web_projects` (idempotente). Aplicar en Supabase.
- **Panel**: la tabla de sitios muestra el badge `🤖 IA` en filas con agente embebido.
- **Verificación**: harness con pruebas de snippet/inyección (todas pasan) + `node --check` de la función y del JS del dashboard.

## 13 Ago 2026 — Web Factory Fase 1 (crear sitios web para clientes)

- **Backend `netlify/functions/web-factory.js` (NUEVO)**:
  - Solo admins (patrón de `admin-data.js`). Acciones: `list`, `get`, `refresh_status`, `create`, `delete`.
  - `create` corre en la background function real `web-factory-background.js` (sufijo `-background`, hasta 15 min); el dashboard hace polling hasta el estado final.
  - Pipeline: insert en `web_projects` → repo privado en GitHub (Git Data API, rama `main`) → site en Netlify enlazado al repo → build inicial → dominio opcional → estados `creando/configurando/deploying/dominio_pendiente/publicado/error`.
  - Secretos solo en env vars: `GITHUB_TOKEN`, `NETLIFY_AUTH_TOKEN`, `GITHUB_OWNER` (opcional).
  - Errores reales de API se guardan en `web_projects.error` y se muestran en el panel.
- **Plantillas `web-factory/templates/` (NUEVO)**: `landing` (estática, sin build, con `{{EMPRESA}}`/`{{DESCRIPCION}}`) + `manifest.json`. Incluidas en el bundle vía `included_files` en `netlify.toml`.
- **Migración `supabase/migrations/20260813_web_factory.sql` (NUEVO)**: tabla `web_projects` (idempotente, sin RLS — el backend usa service role).
- **`dashboard.html`**: vista `view-webfactory` + `nav-webfactory` (solo admin, junto a `nav-admin`), stats, tabla de proyectos con badges de estado, modal crear sitio (Cliente/Nombre/Slug autogen/Plantilla/Dominio opcional), botones ver sitio/GitHub/copiar clone/actualizar estado/eliminar registro (no destructivo), y polling cada 8s mientras haya proyectos en curso. Se registró la vista en `mostrarVista()` y `verificarSesion()` (hash `#webfactory`).
- **Verificación**: `node --check` de la función y del JS del dashboard, `manifest.json` válido, y 52 pruebas unitarias de la lógica (plantillas, tokens, slugs, dominios, mapeo de estados) — todas pasan.
- **Robustez de GitHub (13 Ago)**: tras crear el repo, `esperarRepoListo` espera hasta 10s a que GitHub lo tenga listo; `fetchGitHub` reintenta blobs/árbol/commit/ref ante 404/409/429; el owner real se toma del repo creado (`repo.owner.login`) en vez de confiar ciegamente en `GITHUB_OWNER`; y los errores ahora incluyen el status HTTP + detalle de GitHub (p.ej. `GitHub: no se pudo subir el archivo README.md (HTTP 404): ...`).
- **Fix `409 Git Repository is empty` (13 Ago)**: el repo se crea ahora con `auto_init: true` (GitHub crea el commit inicial + rama default, así nunca está "vacío" y los blobs no se rechazan). El código lee `repo.default_branch` (main o master), crea el árbol con `base_tree` sobre el commit inicial, hace commit con `parents` y actualiza la rama con `PATCH`. La rama se guarda en la nueva columna `web_projects.default_branch` (migración `20260813_web_factory_branch.sql`) y `crearSitioNetlify(owner, slug, branch)` la usa para enlazar el site de Netlify a la rama correcta.
- **Dominio opcional no bloquea el proyecto (14 Ago)**: si registrar el dominio falla (Netlify puede devolver 404 si el sitio se acaba de crear), el proyecto ya no queda en `error` ni se aborta el pipeline: se guarda el detalle en `web_projects.dominio_error` (migración `20260814_web_factory_dominio_error.sql`) y el site sigue su curso hasta `publicado`. `registrarDominio` ahora reintenta 3 veces (2s/4s) y el error incluye el dominio + site_id + status HTTP. El panel muestra `dominio: <mensaje>` en amarillo junto al badge del dominio.
- **Subdominio de Netlify con el slug (14 Ago)**: el site se crea con `name: slug` para que el subdominio quede `<slug>.netlify.app` en vez de un nombre aleatorio. Si ese nombre ya está tomado en Netlify (422), se intentan `slug-1`…`slug-20` y solo al final Netlify asigna uno aleatorio.
- **Fix `deploy_error` (14 Ago)**: `consultarEstadoNetlify` devolvía `deploy_error`, que no existe como columna, y el refresh (al final del pipeline, `get`, `refresh_status`) fallaba con "Could not find the 'deploy_error' column". Ahora `deploy_error` se usa solo internamente para poblar la columna `error` y no se intenta escribir en la BD.
- **Deploy de repos nuevos: la app de GitHub de Netlify necesita acceso al repo** (14 Ago): Netlify solo puede clonar repos privados que su GitHub App tenga autorizados. Si Netlify está instalado con "Only select repositories", un repo recién creado por Web Factory no es accesible y el deploy falla con "No se puede acceder al repositorio" en la etapa "preparando repositorio". Solución en GitHub → Settings → Applications → Netlify → Repository access → "All repositories".
- **Por qué la reconexión manual "arreglaba" el deploy (14 Ago)**: al crear un site vía API, Netlify necesita saber QUÉ instalación de su GitHub App usar para clonar el repo. Si el payload `repo` no lleva `installation_id`, Netlify crea el site pero sin credenciales de clonado → falla hasta que se re-enlaza en la UI (que es lo que asocia la instalación). Arreglo: `crearSitioNetlify` ahora incluye `installation_id` (env var `NETLIFY_GITHUB_INSTALLATION_ID`, se obtiene una sola vez en `github.com/settings/installations` → URL termina en el ID numérico) y `repo_id` (del repo creado). El panel avisa si falta la variable. Con esto no haría falta la reconexión manual.
- **Pendiente (prueba E2E con credenciales reales)**: aplicar la migración en Supabase, configurar `GITHUB_TOKEN` + `NETLIFY_AUTH_TOKEN` en Netlify, y crear un proyecto de prueba para confirmar repo GitHub + site Netlify + deploy + URL + dominio end-to-end.

## 13 Ago 2026 — PWA/móvil: fixes de estructura y mejoras

- **Bottom nav móvil corregido** (dashboard.html): la barra inferior tenía 5 botones pero `grid-template-columns:repeat(4,1fr)` → el 5º (Ajustes) se cortaba. Ahora `repeat(5,1fr)`.
- **Deep-links por hash funcionando** (dashboard.html): `verificarSesion()` ahora lee `location.hash` y llama `mostrarVista()` → los shortcuts del manifest (`#bandeja`, `#agentes`) y los deep-links de notificaciones abren la vista correcta.
- **Apple touch icon a PNG** (dashboard.html): el fallback sin `sizes` apuntaba a SVG (iOS lo ignora) → ahora `/icon-180.png`.
- **Auto-prompt de notificaciones eliminado** (dashboard.html): ya no se pide permiso solo con un `setTimeout` de 8s (Chrome/Android lo descartan sin gesto de usuario). Se pide al instalar la PWA o por acción del usuario.
- **Background sync activado** (dashboard.html): `suscribirPush()` registra `reg.sync.register('sync-messages')` (try/catch) para que en Android instalado se refresque la bandeja.
- **sw.js v10 (SW v2.0)**:
  - `offline.html` se agrega al precache y es el fallback real de navegación (antes caía a `login.html`).
  - Nueva `putPruned()`: poda la cache a las 100 entradas más recientes para evitar crecimiento ilimitado en móvil.
  - `CACHE_NAME` `auvro-v9` → `auvro-v10` (activate limpia la cache vieja).
- **manifest.json**: `screenshots` vacío (los archivos `/screenshot-*.png` no existían → referencias rotas en el diálogo de instalación); agregado `"id": "/dashboard.html"`.
- **SW registrado en index.html y agentes.html** (antes solo dashboard/login): la primera visita a `/` o landings queda bajo control del SW.

Pendiente opcional (no ejecutado): refactor de rendimiento — `dashboard.html` es un archivo único de ~9.4K líneas inline (CSS/JS ~1.2MB); dividirlo en estáticos cacheados mejoraría el primer render móvil.

## 13 Ago 2026 — Landing de agentes (agentes.html) actualizada con la información reciente

- **Plan/héroe:** chip ahora dice "WhatsApp · CRM · Cobros con Wompi"; sub refleja atención web+WhatsApp, leads, Wompi y +500 apps; stats actualizadas (∞ agentes en Business, +500 apps vía Composio, 24/7).
- **Casos de uso:** "Atención 24/7" ahora incluye WhatsApp; "Vendedor inteligente" menciona link de pago Wompi (tarjeta/PSE/Nequi); se añadió el caso "CRM de ventas" (captura de leads + notificaciones pre/post-pago).
- **Cómo funciona:** paso 3 "Conecta tus canales" (widget web o número de WhatsApp); paso 4 menciona cobros con Wompi.
- **Integraciones activas:** WhatsApp, Wompi y Shopify se marcan como disponibles ahora (además de Google Calendar/Gmail/Drive). Se retiraron Supabase/HubSpot de la lista visible.
- **Planes (según dashboard/admin):** Free 1 agente $900/mes · Starter 3 agentes $30.900/mes · Pro 10 agentes $82.500/mes (Popular) · Business ilimitados $206.400/mes. Se eliminó el plan Custom de la grilla.
- **Packs de tokens mencionados:** 100K $6.100 · 500K $21.600 · 1M $37.000 COP (fuente: vista "Tokens y Planes" del dashboard).
- **Número WhatsApp confirmado por el usuario:** 573115062661 (se mantiene; el 573115364647 del dashboard es para upgrades, no para la landing).

## 8 Ago 2026 — Fix + optimización bandeja (mensajes duplicados, selects y realtime)

### 1) Mensajes duplicados en el flujo de IMAGEN (WhatsApp + IA vision)
- **Causa:** en `whatsapp-webhook.js`, tras analizar una imagen con la IA (OpenAI vision), se guardaba la respuesta del asistente DOS veces: `chat.js` ya la guarda al terminar `chatHandler`, y el webhook la volvía a insertar con `guardarMensajeSaliente`. Además el mensaje de usuario se guardaba 2 veces (media + texto). El cliente recibía 1 mensaje, pero la bandeja mostraba duplicados.
- **Fix:**
  - `whatsapp-webhook.js`: eliminada `guardarMensajeSaliente` y su llamada; el body de `chatHandler` ahora envía `skip_user_save: true`.
  - `chat.js`: con `skip_user_save` no inserta el mensaje de usuario ni re-dispara el push (el webhook ya guardó el media y notificó). La respuesta del asistente se sigue guardando una sola vez en `chat.js`.
- Resultado por imagen: 1 mensaje de usuario (media) + 1 del asistente. Sin duplicados nuevos (los duplicados históricos en DB permanecen).

### 2) Selects de la bandeja con la tipografía del diseño
- La página usa **Inter** (bloque de theming final). Los filtros de la bandeja usaban `DM Sans`.
- Fix: `.inbox-filters select` y `.inbox-filters input` pasan a `Inter`. Se añadió un `select` global (Inter + estilo de inputs + flecha SVG) para que todos los selects del dashboard sean consistentes.

### 3) Realtime: sin recarga completa ni pérdida de scroll
- **Antes:** cada evento en `conversaciones` re-renderizaba toda la lista y además disparaba un refetch completo (`debounceRecargaBandeja` → `cargarBandejaConversaciones` con spinner).
- **Ahora (handler base de `iniciarRealtimeBandeja`):**
  - Actualización **en sitio** de la conversación afectada (re-sort por `updated_at`).
  - `renderConversacionesBandejaConScroll` conserva el scroll.
  - Sin refetch de red; si hay filtros de servidor activos, sí se recarga para respetar el filtro.
  - Respeta la búsqueda local si hay término activo.
- Mensajes: `agregarMensajeRealtime` hace **append** de un solo mensaje (`appendMensajeRealtime`) en vez de re-renderizar toda la conversación. Se extrajeron `crearChipFechaBandeja`/`crearFilaMensajeBandeja` reutilizados por `renderMensajesConversacion`.

## 8 Ago 2026 — Fix UI: checkboxes compactos en "Campos a capturar" (configurar CRM, móvil)

### Síntoma
En móvil, los checkboxes de "Campos a capturar" del modal Configurar CRM se veían muy grandes.

### Fix en `dashboard.html`
- Regla `#crm-config-modal input[type="checkbox"]`: tamaño fijo `15x15px`, `accent-color: var(--accent)` y `flex-shrink:0` (también aplica a los checkboxes de notificaciones del mismo modal).

## 8 Ago 2026 — Fix UI: scroll y centrado de modales en móvil (dashboard)

### Síntoma
En el dashboard, las ventanas emergentes de **Integraciones del agente** y **Configurar CRM** (y el resto de modales centrados) no se podían scrollear en móvil: el contenido quedaba cortado arriba/abajo y solo se podía cerrar con la X superior.

### Causa raíz
Los modales usan `position:fixed;inset:0;align-items:center;justify-content:center` (flex centrado) y la tarjeta interna con `max-height:90vh;overflow-y:auto`. Con contenido más alto que la pantalla, el centrado flex recorta la parte superior/inferior del contenido y el overlay no scrollea.

### Fix en `dashboard.html`
- El overlay pasa a ser el contenedor scrollable: `overflow-y:auto`, `-webkit-overflow-scrolling:touch`, `overscroll-behavior:contain`, `padding:1.25rem`.
- La tarjeta se centra con `margin:auto` (patrón que centra cuando hay espacio y permite scrollear hasta arriba cuando el contenido excede la pantalla).
- Selector global `[id$="-modal"]:not(#chat-modal)` (cubre los 11 modales: admin, chat, edit, create, crm-config, producto, importar, cat-preview, crm-lead, integrations, upgrade). `#chat-modal` se excluye porque es un panel flotante, no un overlay centrado. También se cubre `.media-lightbox`.

## 8 Ago 2026 — Fix v3: desactivado el razonamiento de DeepSeek (pensamiento) para respuestas dentro del tiempo límite

### Contexto
Aun con `max_tokens` y timeout ajustados, las tareas complejas (ej. agendar varias clases en Google Calendar) excedían los 25s porque `deepseek-v4-flash` razona por defecto (`reasoning_content` puede superar 3000 tokens) y Netlify mata las funciones síncronas a los 30s. Resultado real: el cliente de WhatsApp recibía "La IA tardó demasiado".

### Pruebas directas contra la API (misma tarea compleja)
- Por defecto (razona): **13.9s** total, 3902 tokens de razonamiento.
- `thinking: { type: 'disabled' }`: **4.5s**, 0 tokens de razonamiento, respuesta completa.
- `thinking: { type: 'enabled', budget_tokens: 1024 }`: 10.8s y el modelo NO respeta el tope (razonó 3240 tokens).

### Fix en `netlify/functions/chat.js`
- Se envía `thinking: { type: 'disabled' }` en el body del request a DeepSeek (solo en la rama DeepSeek; OpenAI vision sigue igual).
- Se mantiene `max_tokens: 4096` (solo como margen de respuesta; sin razonamiento no hay riesgo de vacío).
- Tradeoff asumido: el agente ya no "piensa" en voz alta; se compensa con respuestas ~5s siempre dentro del límite.

### Opción futura (no implementada)
Procesamiento asíncrono con background function (hasta 15 min) si algún día se necesita razonamiento profundo en WhatsApp.

## 8 Ago 2026 — Fix v2: timeout en la lectura del cuerpo de DeepSeek (evita muerte silenciosa a los 30s)

### Síntoma
Tras subir `max_tokens` a 8192, una solicitud con razonamiento largo moría en silencio:
`DeepSeek respondió con status: 200` ... `Duration: 30000 ms` (sin `Respuesta raw IA`).

### Causa raíz
DeepSeek envía los headers al instante (status 200) pero el **cuerpo** llega de forma progresiva mientras genera tokens de razonamiento. El `clearTimeout` se ejecutaba justo después de `fetch()` (solo con los headers), así que `await aiResponse.json()` quedaba **sin timeout** y el límite de ejecución de Netlify (30s) mataba la función antes de responder — el cliente de WhatsApp nunca recibía nada.

### Fix en `netlify/functions/chat.js`
1. `clearTimeout` movido a `finally` **después** de `await aiResponse.json()`: el abort sigue activo durante la lectura del cuerpo.
2. Timeout de DeepSeek: fijo **25s** (bajo el límite de 30s de Netlify) → si se pasa, el catch devuelve `{error: "La IA tardó demasiado..."}` y el webhook de WhatsApp lo envía al cliente (whatsapp-webhook.js:584).
3. `max_tokens` de DeepSeek bajado de 8192 → **4096** (punto medio: 1024 deja `content` vacío; 8192 supera el límite de tiempo).

## 8 Ago 2026 — Fix: respuestas vacías de DeepSeek por razonamiento truncado (finish_reason=length)

### Síntoma
En logs de Netlify, DeepSeek (`deepseek-v4-flash`, modelo de razonamiento) respondía `content: ""` con `finish_reason: "length"`: el presupuesto de salida (`max_tokens: 1024`) se repartía entre `reasoning_content` y la respuesta, y el razonamiento lo agotaba todo → `Action payload parseado: null` y el bot guardaba/respondía un mensaje en blanco.

### Fix en `netlify/functions/chat.js`
1. `max_tokens` ahora es `8192` para DeepSeek (razonamiento) y sigue `1024` para OpenAI GPT-4o (visión). Sin costo extra en chats cortos (solo se cobra lo generado).
2. Timeout de DeepSeek elevado a máx. **20s** (`calcularTimeout` acepta `maxMs`); OpenAI sigue en 9s.
3. Si `content` viene vacío y `finish_reason === 'length'`, se devuelve un mensaje de respaldo claro en vez de guardar un mensaje en blanco.

## 8 Ago 2026 — Refactor: chat de prueba integrado al botón "Probar" del dashboard (se elimina carpeta `chats/`)

### Cambio de enfoque
En vez de una carpeta/chat separado (`chats/index.html`), el botón "Probar" de cada agente en el dashboard ahora **redirige a un chat a pantalla completa** (`chat.html` en la raíz) con las funciones del widget: adjuntar imágenes, historial por usuario y estética AUVRO.

### Implementación
1. **Eliminada** la carpeta `chats/` (enfoque anterior de chat con login propio).
2. **NUEVO `chat.html`** (raíz):
   - Acceso vía `chat.html?agente=ID&nombre=NOMBRE` desde el dashboard.
   - Requiere sesión Supabase (redirige a `login.html?redirect=/chat.html...` si no hay sesión).
   - Envía con header `Authorization: Bearer` + `canal='dashboard'` + `external_user_id = user.id`.
   - **Adjuntar imagen** (📎, máx. 10 MB) → se envía como `image_url` (data URL) y se muestra en el historial.
   - Carga historial persistente por (agente + dashboard + user.id), botón "Nueva conversación", "Salir", fecha/hora, typing indicator, enlaces/bullets.
3. **`web-chat-messages.js`**: ahora acepta `canal` en el body (default `'web'`, retrocompatible con el widget) para poder leer historial del canal `dashboard`.
4. **`dashboard.html`**: `abrirChat(id, nombre)` ahora hace `window.location.href = '/chat.html?agente=...&nombre=...'` (antes abría un modal básico sin adjuntar imagen ni historial). El código del modal queda sin uso pero intacto.

### Notas
- El canal `dashboard` mantiene separadas las conversaciones de prueba de las del widget web (canal `web`).
- La validación de sesión en `chat.js` (401/403) sigue retrocompatible: sin Authorization el widget anónimo funciona igual.

## 8 Ago 2026 — Chat web autenticado + Widget mejorado (viabilidad completa)

### Chat web con login (`chats/index.html`)
- Nueva carpeta `chats/` con UI tipo ChatGPT (dark theme AUVRO, PWA-ready).
- Reutiliza el MISMO Supabase Auth de la plataforma: sin sesión → redirige a `login.html?redirect=/chats/`.
- `external_user_id` = `user.id` autenticado (nunca el del cliente). Soporta `?agente=ID` (default agente maestro `1`).
- Carga historial vía `web-chat-messages` y envía vía `chat` con header `Authorization: Bearer <token>`.
- Botón "Nueva conversación" (resetea `conversation_id`), "Salir", saludo de bienvenida.

### Seguridad de acceso (backend)
- `login.html`: ahora soporta `?redirect=` (solo rutas relativas, evita open-redirect). Antes siempre iba a `dashboard.html`.
- `chat.js`:
  - Nuevo helper `verificarSesionUsuario(event)`: si llega `Authorization: Bearer` lo valida con `supabase.auth.getUser`. Token inválido/expirado → 401.
  - Con sesión: fuerza `external_user_id = user.id` y valida que la conversación pertenezca al usuario (`external_user_id` + `agente_id`), si no → 403.
  - Sin header Authorization (widget anónimo) → comportamiento anterior intacto.
  - Catch ahora respeta `err.status` (401/403/500). CORS incluye `Authorization`.
- `web-chat-messages.js`:
  - Con Authorization: valida sesión y solo permite leer la conversación del propio usuario (401/403).
  - Query a prueba de duplicados: `order by updated_at desc, limit(1)` en vez de `maybeSingle()` (mismo fix que `chat.js`).

### Widget web (`widget.js`) — correcciones de viabilidad
- Polling: se detiene al cerrar el panel y se reanuda al abrirlo (antes corría cada 2.5s para siempre).
- Errores visibles: 403 (dominio no autorizado), 404 (agente no encontrado) y 500 ahora se muestran como burbuja de sistema en vez de fallar en silencio. En envío, los errores HTTP se separan de las respuestas normales del bot.
- Config nueva: `data-name` (título), `data-greeting` (saludo inicial), `data-position` (`left`/`right`), `data-autopen` (ms para abrir solo). También vía `window.AUVRO_CONFIG`.
- `web-chat-messages` ya no falla con conversaciones duplicadas para el mismo visitante.

### Archivos modificados
- `chats/index.html` (NUEVO)
- `login.html`
- `netlify/functions/chat.js`
- `netlify/functions/web-chat-messages.js`
- `widget.js`

### Notas
- `OPENIA_KEY` verificada en Netlify (configurada). `AGENTE_MAESTRO_ID=1`.
- El token de pago lo sigue descontando el dueño del agente (modelo actual); la recarga de tokens por usuario final queda como fase 2 (pasarela de pago).
- Para el widget en una web propia hay que añadir el dominio en `dominios_permitidos` del agente.

## 7 Ago 2026 — Fix: Caché de medios WhatsApp en Supabase Storage (rate limit #4 de Meta)

### Problema
La Graph API de Meta devolvía `Error: (#4) Application request limit reached` al descargar medios.
Causa: cada imagen se descargaba de Meta varias veces sin caché:
- `whatsapp-webhook.js` descargaba el media en cada llegada para enviarlo a la IA.
- `get-whatsapp-media.js` descargaba el media en cada visualización del dashboard.
- El `mediaCache` del navegador solo vivía en memoria.

Con la app sin revisión/verificación comercial, los límites se agotan rápido y el flujo
"imagen → IA → crear evento" fallaba porque la imagen nunca llegaba al modelo.

### Solución implementada
1. Nuevo helper `netlify/functions/whatsapp-media-storage.js`:
   - Crea bucket público `whatsapp-media` si no existe (límite 50MB, se omiten archivos > 45MB).
   - `subirMedia(...)` sube el archivo a `whatsapp/{agente_id}/{message_id}-{media_id}.{ext}` y devuelve `storage_path` + `public_url`.
   - `descargarDesdeStorage(...)` lee el archivo desde el bucket.
2. `whatsapp-webhook.js` (media entrante):
   - `guardarMensajeMediaEntrante` ahora retorna el `id` del mensaje insertado.
   - Nuevo helper `obtenerOCrearCacheMedia`: cachea CUALQUIER media (imagen, documento, audio, video, sticker) — descarga de Meta UNA sola vez, sube a Storage y guarda `storage_path`/`public_url` en `metadata`. Con logs de cache hit/miss.
   - Solo las imágenes se envían a la IA para análisis (usa la URL pública cacheada; fallback a data URL si la subida falla).
3. `get-whatsapp-media.js` (dashboard):
   - Si el mensaje tiene `storage_path` → lee de Storage (sin Meta).
   - Si tiene `public_url` → responde directamente con la URL pública.
   - Si no tiene caché → descarga de Meta y cachea en Storage (cache-on-read) para no volver a golpear a Meta. Logs de hit/miss.

### Archivos modificados
- `netlify/functions/whatsapp-media-storage.js` (NUEVO)
- `netlify/functions/whatsapp-webhook.js`
- `netlify/functions/get-whatsapp-media.js`

### Notas
- El bucket `whatsapp-media` es público (necesario para que OpenAI acceda a la URL en el análisis de imágenes).
- Sigue pendiente completar Business Verification y permisos en Meta para subir los límites de tasa.
- La imagen se descarga de Meta exactamente 1 vez por media; cualquier lectura posterior sale de Storage.

## 18 Jul 2026 — Fix crítico: 502 Bad Gateway en funciones WhatsApp

### Problema
Todas las funciones serverless que usaban `@supabase/supabase-js` crasheaban en producción con:
```
Error: Node.js detected but native WebSocket not found.
```
Netlify Functions ejecuta Node.js 20, pero `@supabase/supabase-js` v2.39+ (vía `@supabase/realtime-js`)
requiere WebSocket nativo, disponible solo desde Node.js 22+.

Resultado: todas las funciones devolvían 502 Bad Gateway, incluyendo:
- `enviar-whatsapp-manual.js` (envío desde dashboard)
- `whatsapp-webhook.js` (recepción de mensajes)
- `chat.js` (procesamiento de conversaciones)
- Todas las demás funciones con Supabase.

### Solución implementada
1. Crear `supabase-admin.js` como helper compartido polyfill `globalThis.WebSocket` con el paquete `ws`.
2. Migrar todas las funciones para importar `{ supabase }` desde `./supabase-admin`.
3. Archivos con `createClient` custom (conectar-composio, guardar-composio-callback) hacen
   `require('./supabase-admin')` al inicio para activar el polyfill antes de crear su propio cliente.
4. Agregar `ws@^8.18.0` a `package.json` como dependencia.
5. Agregar `[build] environment = { NODE_VERSION = "22" }` en `netlify.toml` como safety net.

### Archivos modificados
- `netlify/functions/supabase-admin.js` (NUEVO)
- `netlify/functions/chat.js`
- `netlify/functions/whatsapp-webhook.js`
- `netlify/functions/enviar-whatsapp-manual.js`
- `netlify/functions/enviar-whatsapp-media.js`
- `netlify/functions/web-chat-messages.js`
- `netlify/functions/send-push.js`
- `netlify/functions/save-push-subscription.js`
- `netlify/functions/get-whatsapp-media.js`
- `netlify/functions/crear-agente.js`
- `netlify/functions/conectar-composio.js`
- `netlify/functions/guardar-composio-callback.js`
- `netlify/functions/package.json`
- `netlify.toml`

### Regla derivada
NUNCA usar `createClient()` directamente en funciones. Siempre importar desde `./supabase-admin`.
Esto garantiza compatibilidad con Node.js 20 y previene errores de WebSocket en runtime.

## 17 Jul 2026 — Fix: Llamada directa a chat.js desde webhook WhatsApp

### Problema
`whatsapp-webhook.js` hacía un fetch HTTP a `/.netlify/functions/chat` para procesar mensajes.
En producción esto generaba un self-reference innecesario y potenciales timeouts.

### Solución
Llamar directamente a `chatHandler(chatEvent)` como función interna, sin HTTP intermedio.
