# AUVRO_CONTEXT.md

# Contexto del Proyecto AUVRO

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

### Pendientes del Proyecto

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
