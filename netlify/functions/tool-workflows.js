const TOOL_DEFINITIONS = {
  GOOGLECALENDAR_CREATE_EVENT: {
    toolkit: 'googlecalendar',
    label: 'Crear eventos en Google Calendar',
    workflow: 'collect_confirm_execute',
    requiredFields: ['summary', 'start', 'end', 'contact_name', 'contact_email'],
    optionalFields: ['description', 'attendees', 'contact_phone', 'meeting_reason', 'location'],
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

const WORKFLOW_CONFIG = {
  schedule_meeting: {
    toolKey: 'GOOGLECALENDAR_CREATE_EVENT',
    confirmationRequired: true,
    requiredFields: ['start', 'end', 'contact_name', 'contact_email'],
    optionalFields: ['summary', 'description', 'contact_phone', 'meeting_reason', 'location'],
    defaults: {
      summary: 'Reunión agendada desde el chat',
      description: 'Reunión generada desde el asistente del agente.',
      durationMinutes: 45
    },
    prompts: {
      initial: 'Claro. Para agendar la reunión, compárteme la fecha y hora, tu nombre y tu correo.'
    }
  },

  send_email: {
    toolKey: 'GMAIL_SEND_EMAIL',
    confirmationRequired: true,
    requiredFields: ['to', 'subject', 'body'],
    optionalFields: ['cc', 'bcc'],
    defaults: {},
    prompts: {
      initial: 'Claro. Para enviar el correo, compárteme el destinatario, el asunto y el mensaje.'
    }
  },

  find_document: {
    toolKey: 'GOOGLEDRIVE_FIND_FILE',
    confirmationRequired: false,
    requiredFields: ['query'],
    optionalFields: ['folder', 'file_type'],
    defaults: {},
    prompts: {
      initial: 'Claro. Indícame qué archivo o documento quieres buscar en Google Drive.'
    }
  }
};

const WORKFLOW_DEFINITIONS = {
  schedule_meeting: {
    key: 'schedule_meeting',
    label: 'Agendar reunión',
    toolKey: 'GOOGLECALENDAR_CREATE_EVENT',
    requiredFields: ['summary', 'start', 'end', 'contact_name', 'contact_email'],
    optionalFields: ['description', 'attendees', 'contact_phone', 'meeting_reason', 'location'],
    confirmationRequired: true,
    intentPatterns: [
      /\bagend/i,
      /\breuni[oó]n\b/i,
      /\breunion\b/i,
      /\bcita\b/i,
      /\bcalendar\b/i,
      /\bevento\b/i,
      /\bprogramar\b.*\breuni[oó]n\b/i
    ]
  },

  send_email: {
    key: 'send_email',
    label: 'Enviar correo',
    toolKey: 'GMAIL_SEND_EMAIL',
    requiredFields: ['to', 'subject', 'body'],
    optionalFields: ['cc', 'bcc'],
    confirmationRequired: true,
    intentPatterns: [
      /\benviar\b.*\b(correo|email)\b/i,
      /\benv[ií]a\b.*\b(correo|email)\b/i,
      /\bmanda\b.*\b(correo|email)\b/i,
      /\bmandar\b.*\b(correo|email)\b/i,
      /\bescribe\b.*\b(correo|email)\b/i,
      /\bgmail\b/i
    ]
  },

  find_document: {
    key: 'find_document',
    label: 'Buscar documento',
    toolKey: 'GOOGLEDRIVE_FIND_FILE',
    requiredFields: ['query'],
    optionalFields: ['folder', 'file_type'],
    confirmationRequired: false,
    intentPatterns: [
      /\bbuscar\b.*\b(archivo|documento)\b/i,
      /\bencuentra\b.*\b(archivo|documento)\b/i,
      /\bdrive\b/i,
      /\bcarpeta\b/i
    ]
  }
};

function esConfirmacion(texto = "") {
  const t = String(texto).trim().toLowerCase();
  return [
    "si", "sí", "confirmo", "ok", "dale", "hazlo", "hacerlo", "adelante", "confirmado"
  ].includes(t);
}

function esCancelacion(texto = "") {
  const t = String(texto || "").trim().toLowerCase();

  if (!t) return false;

  return [
    /^no$/,
    /^cancelar$/,
    /^cancela$/,
    /^cancelalo$/,
    /^cancelalo por favor$/,
    /^detener$/,
    /^deten eso$/,
    /^olvidalo$/,
    /^olvídalo$/,
    /^ya no$/,
    /^ya no quiero$/,
    /^ya no quiero agendar$/,
    /^ya no quiero agendar nada$/,
    /^no quiero agendar$/,
    /^no quiero agendar nada$/,
    /^ya no quiero enviar correo$/,
    /^ya no quiero enviar un correo$/,
    /^no quiero enviar correo$/,
    /^no quiero enviar un correo$/,
    /^no deseo agendar$/,
    /^mejor no$/,
    /^mejor ya no$/,
    /^ya no necesito eso$/
  ].some(rx => rx.test(t));
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

  const ahora = new Date();
  const opcionesFecha = { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' };
  const hoy = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(ahora);
  const mananaDate = new Date(ahora);
  mananaDate.setDate(mananaDate.getDate() + 1);
  const manana = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(mananaDate);

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
- La fecha actual en Colombia es: ${hoy}
- Si el usuario dice "mañana", corresponde a: ${manana}
- NUNCA escribas palabras como "mañana", "hoy", "el jueves" en los campos start o end del JSON
- SIEMPRE escribe la fecha numérica completa en formato: YYYY-MM-DDTHH:MM:00
- Ejemplo CORRECTO: "start": "${manana}T10:00:00"
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

function extractEmail(text = "") {
  const match = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].trim() : "";
}

function extractPhone(text = "") {
  const match = String(text).match(/(?:\+?\d[\d\s-]{7,}\d)/);
  return match ? match[0].trim() : "";
}

function extractName(text = "") {
  let cleaned = String(text).trim();
  if (!cleaned) return "";

  cleaned = cleaned.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ");
  cleaned = cleaned.replace(/(?:\+?\d[\d\s-]{7,}\d)/g, " ");
  cleaned = cleaned.replace(/\b(hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/ig, " ");
  cleaned = cleaned.replace(/\b(a las?\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/ig, " ");
  cleaned = cleaned.replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/ig, " ");
  cleaned = cleaned.replace(/\b(quiero|agendar|agenda|reunión|reunion|correo|email|enviar|envía|envia|mensaje|cita|para|una|de|el|la)\b/ig, " ");
  cleaned = cleaned.replace(/[,:;]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned || cleaned.length < 3) return "";
  if (!/^[a-záéíóúñü\s]+$/i.test(cleaned)) return "";

  const partes = cleaned.split(" ").filter(Boolean);
  if (partes.length < 2) return "";

  return partes.join(" ");
}

function seemsContactInfo(text = "") {
  const t = String(text).trim();
  if (!t) return false;

  const hasEmail = !!extractEmail(t);
  const hasPhone = !!extractPhone(t);
  const hasName = !!extractName(t);

  return hasEmail || hasPhone || hasName;
}

function enrichCalendarPayloadFromText(payload = {}, text = "") {
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const name = extractName(text);

  const attendees = Array.isArray(payload.attendees) ? [...payload.attendees] : [];

  if (email && !attendees.includes(email)) {
    attendees.push(email);
  }

  return {
    ...payload,
    attendees,
    contact_email: payload.contact_email || email || "",
    contact_phone: payload.contact_phone || phone || "",
    contact_name: payload.contact_name || name || ""
  };
}

function detectWorkflowIntent(text = "", availableToolKeys = []) {
  const contenido = String(text || "");
  const disponibles = new Set(availableToolKeys || []);

  for (const workflow of Object.values(WORKFLOW_DEFINITIONS)) {
    if (!disponibles.has(workflow.toolKey)) continue;

    const match = workflow.intentPatterns.some(rx => rx.test(contenido));
    if (match) return workflow;
  }

  return null;
}

function getWorkflowConfig(workflowKey) {
  return WORKFLOW_CONFIG[workflowKey] || null;
}

function seemsWorkflowConfirmation(text = "") {
  return esConfirmacion(text) || esCancelacion(text);
}

function seemsSchedulingData(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (esCancelacion(t)) return false;
  if (/^(hola|buenas|gracias|ok|vale|entiendo)$/i.test(t)) return false;

  const hasEmail = !!extractEmail(t);
  const hasPhone = !!extractPhone(t);

  const hasValidName =
    !!extractName(t) &&
    !/\b(no|ya no|cancelar|cancelalo|cancelalo por favor|no quiero|ya no quiero|nada)\b/i.test(t);

  const hasDateHint =
    /\b(hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i.test(t) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(t) ||
    /\b(a las?\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i.test(t);

  return hasEmail || hasPhone || hasValidName || hasDateHint;
}

function seemsEmailData(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (esCancelacion(t)) return false;
  if (/^(hola|buenas|gracias|ok|vale|entiendo)$/i.test(t)) return false;

  const hasEmail = !!extractEmail(t);
  const hasEmailKeywords = /\b(correo|email|asunto|mensaje|contenido|destinatario|para:|cc:|bcc:)\b/i.test(t);

  return hasEmail || hasEmailKeywords;
}

function classifyMessageRoute({ pendingAction, text = "" }) {
  const t = String(text || "").trim();

  if (!t) return 'chat';

  if (pendingAction) {
    if (esCancelacion(t)) return 'workflow_confirm';
    if (seemsWorkflowConfirmation(t)) return 'workflow_confirm';

    if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
      if (seemsSchedulingData(t)) return 'workflow_collect';
      return 'chat';
    }

    if (pendingAction.action === 'GMAIL_SEND_EMAIL') {
      if (seemsEmailData(t)) return 'workflow_collect';
      return 'chat';
    }

    if (pendingAction.action === 'GOOGLEDRIVE_FIND_FILE') {
  if (seemsDriveData(t)) return 'workflow_collect';
  return 'chat';
}

    return 'chat';
  }

  return 'chat';
}

function extractEmailSubject(text = "") {
  const t = String(text || "").trim();

  const match =
    t.match(/asunto\s*:\s*([^,\n]+)/i) ||
    t.match(/subject\s*:\s*([^,\n]+)/i) ||
    t.match(/(?:el\s+)?asunto\s+(?:es|seria|sería|seri|será|sera)\s+([^,\n]+)/i) ||
    t.match(/(?:el\s+)?asusnto\s+(?:es|seria|sería|seri|será|sera)\s+([^,\n]+)/i);

  let subject = match ? match[1].trim() : "";

  // Si capturó también el inicio del contenido, recortar
  subject = subject.replace(/\s+y\s+el\s+contenido\s+(?:es|seria|sería|seri|será|sera).*$/i, "").trim();

  return subject;
}

function extractEmailBody(text = "") {
  const t = String(text || "").trim();

  const match =
    t.match(/mensaje\s*:\s*(.+)$/i) ||
    t.match(/contenido\s*:\s*(.+)$/i) ||
    t.match(/cuerpo\s*:\s*(.+)$/i) ||
    t.match(/(?:el\s+)?mensaje\s+(?:es|seria|sería|seri|será|sera)\s+(.+)$/i) ||
    t.match(/(?:el\s+)?contenido\s+(?:es|seria|sería|seri|será|sera)\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

function enrichEmailPayloadFromText(payload = {}, text = "") {
  const email = extractEmail(text);
  const subject = extractEmailSubject(text);
  const body = extractEmailBody(text);

  return {
    ...payload,
    to: payload.to || email || "",
    subject: payload.subject || subject || "",
    body: payload.body || body || "",
    cc: payload.cc || "",
    bcc: payload.bcc || ""
  };
}

function enrichDrivePayloadFromText(payload = {}, text = "") {
  const t = String(text || "").trim();

  return {
    ...payload,
    query: payload.query || t || "",
    folder: payload.folder || "",
    file_type: payload.file_type || ""
  };
}

function seemsDriveData(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (esCancelacion(t)) return false;
  if (/^(hola|buenas|gracias|ok|vale|entiendo)$/i.test(t)) return false;

  return t.length >= 3;
}

module.exports = {
  TOOL_DEFINITIONS,
  WORKFLOW_DEFINITIONS,
  WORKFLOW_CONFIG,
  esConfirmacion,
  esCancelacion,
  construirToolsDescription,
  getMissingFields,
  buildMissingFieldsQuestion,
  extractEmail,
  extractPhone,
  extractName,
  enrichCalendarPayloadFromText,
  seemsContactInfo,
  detectWorkflowIntent,
  getWorkflowConfig,
  seemsWorkflowConfirmation,
  seemsSchedulingData,
  classifyMessageRoute,
  extractEmailSubject,
  extractEmailBody,
  enrichEmailPayloadFromText,
  enrichDrivePayloadFromText,
  seemsDriveData
};
