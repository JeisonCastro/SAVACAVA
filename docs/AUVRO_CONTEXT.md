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

Funciones Principales
chat.js

Función principal de conversación.

Responsabilidades:

Recibir mensajes.
Buscar agente.
Validar dominio.
Validar permisos.
Ejecutar modelo IA.
Retornar respuesta.
crear-agente.js

Responsabilidades:

Crear agentes nuevos.
Guardar configuración.
Asociar agente a usuario.
whatsapp-webhook.js

Responsabilidades:

Recibir mensajes desde WhatsApp.
Procesar conversaciones.
Responder utilizando agentes.
conectar-composio.js

Responsabilidades:

Integraciones con herramientas externas.
Conexión de servicios.
save-push-subscription.js

Responsabilidades:

Guardar suscripciones para notificaciones push.
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
Estado Actual del Proyecto

Completado:

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

Pendientes del Proyecto
Seguridad avanzada

Implementar:

API Key única por agente.
Firma de solicitudes.
Rate limiting.
Control de consumo.
Auditoría.
Administración

Crear:

Panel para gestionar dominios.
Activar/desactivar agentes.
Métricas de uso.
Historial de conversaciones.
SaaS

Pendiente:

Planes de usuarios.
Límites de consumo.
Facturación.
Suscripciones.
Widget Web

Pendiente:

Código embebible definitivo.
Personalización visual.
Configuración por cliente.
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