const TOOL_DEFINITIONS = {
  GOOGLECALENDAR_CREATE_EVENT: {
  toolkit: 'googlecalendar',
  label: 'Crear eventos en Google Calendar',
  workflow: 'collect_confirm_execute',
  requiredFields: ['summary', 'start', 'end', 'contact_name', 'contact_email'],
  optionalFields: ['description', 'attendees', 'contact_phone', 'meeting_reason'],
  confirmationRequired: true
},

  GMAIL_SEND_EMAIL: {
    toolkit: 'gmail',
    label: 'Enviar correos con Gmail',
    workflow: 'collect_confirm_execute',
    requiredFields: ['to', 'subject', 'body'],
    optionalFields: ['cc', 'bcc'],
    confirmationRequired: true
  },

  GOOGLEDRIVE_FIND_FILE: {
    toolkit: 'googledrive',
    label: 'Buscar archivos en Google Drive',
    workflow: 'collect_execute',
    requiredFields: ['query'],
    optionalFields: ['folder', 'file_type'],
    confirmationRequired: false
  }
};

function esConfirmacion(texto = "") {
  const t = String(texto).trim().toLowerCase();
  return [
    "si", "sí", "confirmo", "ok", "dale", "hazlo", "hacerlo", "adelante", "confirmado"
  ].includes(t);
}

function esCancelacion(texto = "") {
  const t = String(texto).trim().toLowerCase();
  return [
    "no", "cancelar", "cancela", "detener", "mejor no"
  ].includes(t);
}

function construirToolsDescription(toolsDisponibles = []) {
  if (!Array.isArray(toolsDisponibles) || toolsDisponibles.length === 0) {
    return "";
  }

  const uniqueTools = [...new Set(toolsDisponibles.map(t => t.tool_key))];
  const definiciones = uniqueTools
    .map(toolKey => TOOL_DEFINITIONS[toolKey])
    .filter(Boolean);

  if (definiciones.length === 0) {
    return "";
  }

  const bullets = definiciones.map(def => {
    return `- ${Object.keys(TOOL_DEFINITIONS).find(k => TOOL_DEFINITIONS[k] === def)}:\n  ${def.label}.`;
  }).join("\n\n");

  // Fechas dinámicas Colombia
  const ahora = new Date();
  const opcionesFecha = { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' };
  const partes = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(ahora); // YYYY-MM-DD
  const mananaDate = new Date(ahora);
  mananaDate.setDate(mananaDate.getDate() + 1);
  const partesManana = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(mananaDate);

  return `
## HERRAMIENTAS DISPONIBLES

Puedes usar las siguientes acciones si el usuario lo requiere:

${bullets}

## IMPORTANTE
Si necesitas usar una herramienta, responde SOLO en formato JSON así:

{
  "action": "NOMBRE_TOOL",
  "data": { ... }
}

## FLUJO CORRECTO PARA AGENDAR
1. Si el usuario quiere agendar y NO tienes todos los datos → pregunta en texto normal
2. Cuando el usuario te dé los datos faltantes → genera el JSON inmediatamente
3. NUNCA sigas pidiendo datos si ya los tienes
4. NUNCA generes JSON con campos vacíos o inventados

## REGLAS DE FECHA (CRÍTICO)
- La fecha actual en Colombia es: ${partes}
- Si el usuario dice "mañana", corresponde a: ${partesManana}
- NUNCA escribas palabras como "mañana", "hoy", "el jueves" en los campos start o end del JSON
- SIEMPRE escribe la fecha numérica completa en formato: YYYY-MM-DDTHH:MM:00
- Ejemplo CORRECTO: "start": "${partesManana}T10:00:00"
- Ejemplo INCORRECTO: "start": "mañana 10:00"

## REGLAS ESPECÍFICAS PARA CALENDAR
- Si el objetivo es agendar una reunión, prioriza GOOGLECALENDAR_CREATE_EVENT.
- Si el usuario comparte correo para una reunión, úsalo como invitado del evento.
- Si falta información para agendar, pide los datos faltantes antes de confirmar.
- No envíes un email separado si lo que corresponde es crear o completar el evento.

NO expliques nada adicional.
Si no necesitas herramientas, responde normalmente.
`;
}

function getMissingFields(toolKey, data = {}) {
  const def = TOOL_DEFINITIONS[toolKey];
  if (!def) return [];

  return (def.requiredFields || []).filter(field => {
    const value = data[field];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string' && value.trim() === '') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    return false;
  });
}

function buildMissingFieldsQuestion(toolKey, missingFields = []) {
  if (!missingFields.length) return null;

  if (toolKey === 'GOOGLECALENDAR_CREATE_EVENT') {
    const labels = {
      contact_name: 'tu nombre',
      contact_email: 'tu correo',
      summary: 'el título de la reunión',
      start: 'la fecha y hora de inicio',
      end: 'la fecha y hora de finalización'
    };

    const faltantesLegibles = missingFields.map(f => labels[f] || f);

    if (faltantesLegibles.length === 1) {
      return `Antes de agendar la reunión, compárteme ${faltantesLegibles[0]}.`;
    }

    const ultima = faltantesLegibles.pop();
    return `Antes de agendar la reunión, compárteme ${faltantesLegibles.join(', ')} y ${ultima}.`;
  }

  if (toolKey === 'GMAIL_SEND_EMAIL') {
    const labels = {
      to: 'el correo destino',
      subject: 'el asunto',
      body: 'el contenido del correo'
    };

    const faltantesLegibles = missingFields.map(f => labels[f] || f);

    if (faltantesLegibles.length === 1) {
      return `Antes de enviar el correo, compárteme ${faltantesLegibles[0]}.`;
    }

    const ultima = faltantesLegibles.pop();
    return `Antes de enviar el correo, compárteme ${faltantesLegibles.join(', ')} y ${ultima}.`;
  }

  if (toolKey === 'GOOGLEDRIVE_FIND_FILE') {
    return `Indícame qué archivo o documento quieres buscar.`;
  }

  return `Faltan datos para completar esta acción: ${missingFields.join(', ')}.`;
}

module.exports = {
  TOOL_DEFINITIONS,
  esConfirmacion,
  esCancelacion,
  construirToolsDescription,
  getMissingFields,
  buildMissingFieldsQuestion
};
