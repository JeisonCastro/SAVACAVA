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
- Resolver permisos de Graph API para lectura de medios recibidos (error: "Object with ID does not exist, cannot be loaded due to missing permissions"). Requiere permiso `whatsapp_business_messaging` en Meta Developer Dashboard.

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