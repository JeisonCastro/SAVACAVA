// ─────────────────────────────────────────────────────────────────────────────
// tool-workflows.js — Motor de herramientas para Fábrica de Agentes IA
// Estrategia: DeepSeek es el cerebro. Este archivo es el ejecutor.
// ─────────────────────────────────────────────────────────────────────────────

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
    requiredFields: ['summary', 'start', 'end', 'contact_name', 'contact_email'],
    optionalFields: ['description', 'attendees', 'contact_phone', 'meeting_reason', 'location'],
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
      /\benviar\b.*\b(correo|email|mail)\b/i,
      /\benv[ií]a\b.*\b(correo|email|mail)\b/i,
      /\bmanda\b.*\b(correo|email|mail)\b/i,
      /\bmandar\b.*\b(correo|email|mail)\b/i,
      /\bescribe\b.*\b(correo|email|mail)\b/i,
      /\bgmail\b/i,
      /\bcorreo\b.*\ba\b.*@/i,
      /\bemail\b.*\ba\b.*@/i
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

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMACIÓN Y CANCELACIÓN
// ─────────────────────────────────────────────────────────────────────────────

function esConfirmacion(texto = "") {
  const t = String(texto).trim().toLowerCase();
  return [
    "si", "sí", "confirmo", "ok", "dale", "hazlo", "hacerlo", "adelante",
    "confirmado", "correcto", "exacto", "listo", "perfecto", "claro", "va",
    "bueno", "de acuerdo", "procede", "proceder", "enviar", "envíalo", "envialo",
    "agéndalo", "agendalo", "sí confirmo", "si confirmo"
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

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACCIÓN INTELIGENTE DE DATOS
// ─────────────────────────────────────────────────────────────────────────────

function extractEmail(text = "") {
  const match = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].trim() : "";
}

function extractAllEmails(text = "") {
  const matches = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return matches ? matches.map(e => e.trim()) : [];
}

function extractPhone(text = "") {
  const match = String(text).match(/(?:\+?\d[\d\s-]{7,}\d)/);
  return match ? match[0].trim() : "";
}

function extractName(text = "") {
  let raw = String(text || "").trim();
  if (!raw) return "";

  const explicitMatch =
    raw.match(/\b(?:con|para|a nombre de)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+){0,3})(?=\s+[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\s+\+?\d|\s+(?:sobre|tema|para revisar|para hablar de|acerca de)\b|[,.]|$)/i);

  if (explicitMatch) {
    const candidate = explicitMatch[1].trim();
    if (
      candidate.length >= 3 &&
      /^[a-záéíóúñü\s]+$/i.test(candidate) &&
      !/\b(reunión|reunion|cita|correo|email|mensaje|archivo|documento|drive|google)\b/i.test(candidate)
    ) {
      return candidate;
    }
  }

  let cleaned = raw;
  cleaned = cleaned.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ");
  cleaned = cleaned.replace(/(?:\+?\d[\d\s-]{7,}\d)/g, " ");
  cleaned = cleaned.replace(/\b(hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/ig, " ");
  cleaned = cleaned.replace(/\b(a las?\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/ig, " ");
  cleaned = cleaned.replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/ig, " ");
  cleaned = cleaned.replace(/\b(sobre|tema|para revisar|para hablar de|acerca de)\b.*$/ig, " ");
  cleaned = cleaned.replace(/\b(quiero|necesito|puedes|ayudame|ayúdame|agendar|agenda|programar|reunión|reunion|correo|email|enviar|envía|envia|mensaje|cita|para|con|una|un|de|del|el|la|los|las)\b/ig, " ");
  cleaned = cleaned.replace(/[,:;]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned || cleaned.length < 3) return "";
  if (!/^[a-záéíóúñü\s]+$/i.test(cleaned)) return "";

  const partes = cleaned.split(" ").filter(Boolean);
  if (partes.length < 2) return "";

  return partes.join(" ");
}

function extractMeetingReason(text = "") {
  const t = String(text || "").trim();
  if (!t) return "";

  const match =
    t.match(/\b(?:sobre|tema|para revisar|para hablar de|acerca de)\s+([^,.\n]+)/i) ||
    t.match(/\breuni[oó]n\s+(?:sobre|de|para)\s+([^,.\n]+)/i) ||
    t.match(/\bcita\s+(?:sobre|de|para)\s+([^,.\n]+)/i);

  if (!match) return "";

  let reason = match[1].trim();
  reason = reason.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ");
  reason = reason.replace(/(?:\+?\d[\d\s-]{7,}\d)/g, " ");
  reason = reason.replace(/\s+/g, " ").trim();

  return reason;
}

// Extracción mejorada de asunto — entiende lenguaje natural
function extractEmailSubject(text = "") {
  const t = String(text || "").trim();

  // Patrones explícitos primero
  const explicit =
    t.match(/asunto\s*[:\-]\s*([^,\n.]+)/i) ||
    t.match(/subject\s*[:\-]\s*([^,\n.]+)/i) ||
    t.match(/(?:el\s+)?asunto\s+(?:es|seria|sería|será|sera)\s+["']?([^,\n."']+)["']?/i) ||
    t.match(/(?:con\s+asunto|de\s+asunto)\s+["']?([^,\n."']+)["']?/i) ||
    t.match(/asunto\s+["']([^"']+)["']/i);

  if (explicit) {
    let subject = explicit[1].trim();
    // Recortar si capturó el cuerpo también
    subject = subject.replace(/\s+y\s+(?:el\s+)?(?:contenido|cuerpo|mensaje|body)\s+(?:es|seria|sería).*$/i, "").trim();
    subject = subject.replace(/\s+el\s+(?:contenido|cuerpo|mensaje)\s+.*$/i, "").trim();
    return subject;
  }

  // Si viene con "para X, asunto Y, contenido Z" en cualquier orden
  const parteAsunto = t.match(/,\s*(?:el\s+)?asunto\s+(?:es\s+)?([^,\n]+?)(?:\s*,|\s+y\s+(?:el\s+)?(?:contenido|cuerpo|mensaje)|$)/i);
  if (parteAsunto) {
    return parteAsunto[1].trim();
  }

  return "";
}

// Extracción mejorada de cuerpo — entiende lenguaje natural
function extractEmailBody(text = "") {
  const t = String(text || "").trim();

  const match =
    t.match(/(?:el\s+)?(?:mensaje|contenido|cuerpo|body)\s*[:\-]\s*(.+)$/i) ||
    t.match(/(?:el\s+)?(?:mensaje|contenido|cuerpo)\s+(?:es|seria|sería|será|sera)\s+(.+)$/i) ||
    t.match(/,\s*(?:el\s+)?(?:contenido|mensaje|cuerpo)\s+(?:es\s+)?(.+)$/i);

  return match ? match[1].trim() : "";
}

// Extracción inteligente de destinatario de email
function extractEmailRecipient(text = "") {
  const t = String(text || "").trim();

  // Email explícito
  const email = extractEmail(t);
  if (email) return email;

  // Patrones como "enviar a X", "para X"
  const match =
    t.match(/\b(?:enviar?\s+(?:a|al|para)|para|destinatario\s*:)\s+([^\s,]+@[^\s,]+)/i) ||
    t.match(/\ba\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);

  return match ? match[1].trim() : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRIQUECIMIENTO DE PAYLOADS
// ─────────────────────────────────────────────────────────────────────────────

function enrichCalendarPayloadFromText(payload = {}, text = "") {
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const name = extractName(text);
  const reason = extractMeetingReason(text);

  const attendees = Array.isArray(payload.attendees) ? [...payload.attendees] : [];

  if (email && !attendees.includes(email)) {
    attendees.push(email);
  }

  const defaultSummary = WORKFLOW_CONFIG.schedule_meeting.defaults.summary;
  const defaultDescription = WORKFLOW_CONFIG.schedule_meeting.defaults.description;

  const summary =
    payload.summary && payload.summary !== defaultSummary
      ? payload.summary
      : reason
        ? `Reunión sobre ${reason}`
        : payload.summary || defaultSummary;

  const description =
    payload.description && payload.description !== defaultDescription
      ? payload.description
      : reason
        ? `Reunión sobre ${reason}.`
        : payload.description || defaultDescription;

  return {
    ...payload,
    attendees,
    summary,
    description,
    meeting_reason: payload.meeting_reason || reason || "",
    contact_email: payload.contact_email || email || "",
    contact_phone: payload.contact_phone || phone || "",
    contact_name: payload.contact_name || name || ""
  };
}

// Enriquecimiento mejorado — extrae todo lo que el usuario dio en un solo mensaje
function enrichEmailPayloadFromText(payload = {}, text = "") {
  const t = String(text || "").trim();

  const email = extractEmail(t);
  const subject = extractEmailSubject(t);
  const body = extractEmailBody(t);

  // Si el usuario dio todo en un solo mensaje sin palabras clave de asunto,
  // intentar inferir: primer fragmento antes de la coma es asunto, resto es cuerpo
  let inferredSubject = subject;
  let inferredBody = body;

  if (!inferredSubject && !inferredBody && email) {
    // Remover el email del texto y ver qué queda
    const sinEmail = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "").trim();
    const sinPrefijos = sinEmail
      .replace(/\b(enviar?|envía|envia|mandar|manda|escribe|correo|email|mail|a|al|para|con|el|la|un|una|de)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (sinPrefijos.length > 3) {
      // Si hay coma, antes de la coma es asunto y después es cuerpo
      const partes = sinPrefijos.split(/[,;]/);
      if (partes.length >= 2) {
        inferredSubject = partes[0].trim();
        inferredBody = partes.slice(1).join(", ").trim();
      } else {
        // Todo es el asunto si es corto, o el cuerpo si es largo
        if (sinPrefijos.length <= 60) {
          inferredSubject = sinPrefijos;
        } else {
          inferredBody = sinPrefijos;
        }
      }
    }
  }

  return {
    ...payload,
    to: payload.to || email || "",
    subject: payload.subject || inferredSubject || "",
    body: payload.body || inferredBody || "",
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

// ─────────────────────────────────────────────────────────────────────────────
// DETECCIÓN DE INTENCIÓN
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// CLASIFICACIÓN DE RUTAS DE MENSAJES
// Simplificada: si hay pending, el mensaje siempre entra al workflow
// salvo que sea cancelación explícita
// ─────────────────────────────────────────────────────────────────────────────

function classifyMessageRoute({ pendingAction, text = "" }) {
  const t = String(text || "").trim();

  if (!t) return 'chat';

  if (!pendingAction) return 'chat';

  // Cancelación explícita
  if (esCancelacion(t)) return 'workflow_confirm';

  // Confirmación explícita
  if (esConfirmacion(t)) return 'workflow_confirm';

  // Si hay pending activo, cualquier mensaje que no sea saludo o pregunta
  // independiente se trata como datos del workflow
  const esSaludoAislado = /^(hola|buenas|buenos días|buenos dias|buen día|buen dia|buenas tardes|buenas noches|hey|hi|qué tal|que tal)\s*[!.]?$/i.test(t);

  if (esSaludoAislado) return 'chat';

  // Para Gmail: acepta cualquier mensaje que contenga datos relevantes
  if (pendingAction.action === 'GMAIL_SEND_EMAIL') {
    const hasEmail = !!extractEmail(t);
    const hasEmailKeywords = /\b(correo|email|asunto|mensaje|contenido|destinatario|para:|cc:|bcc:|subject|body)\b/i.test(t);
    const hasAnyContent = t.length > 3;
    // Si el payload ya tiene "to", cualquier texto puede ser asunto o cuerpo
    const payloadActual = pendingAction.payload || {};
    const toYaTiene = !!payloadActual.to;

    if (hasEmail || hasEmailKeywords || (toYaTiene && hasAnyContent)) {
      return 'workflow_collect';
    }
    return 'chat';
  }

  // Para Calendar: acepta fechas, nombres, correos
  if (pendingAction.action === 'GOOGLECALENDAR_CREATE_EVENT') {
    if (seemsSchedulingData(t)) return 'workflow_collect';
    return 'chat';
  }

  // Para Drive: cualquier texto es query
  if (pendingAction.action === 'GOOGLEDRIVE_FIND_FILE') {
    if (t.length >= 3) return 'workflow_collect';
    return 'chat';
  }

  return 'chat';
}

function seemsContactInfo(text = "") {
  const t = String(text).trim();
  if (!t) return false;
  return !!extractEmail(t) || !!extractPhone(t) || !!extractName(t);
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
    !/\b(no|ya no|cancelar|cancelalo|no quiero|ya no quiero|nada)\b/i.test(t);
  const hasDateHint =
    /\b(hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/i.test(t) ||
    /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(t) ||
    /\b(a las?\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i.test(t);
  const hasReason = !!extractMeetingReason(t);

  return hasEmail || hasPhone || hasValidName || hasDateHint || hasReason;
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

function seemsDriveData(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (esCancelacion(t)) return false;
  if (/^(hola|buenas|gracias|ok|vale|entiendo)$/i.test(t)) return false;
  return t.length >= 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPOS FALTANTES Y PREGUNTAS
// ─────────────────────────────────────────────────────────────────────────────

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
      contact_name: 'tu nombre completo',
      contact_email: 'tu correo electrónico',
      summary: 'el título o motivo de la reunión',
      start: 'la fecha y hora de inicio (ej: mañana a las 3pm)',
      end: 'la hora de finalización'
    };

    const faltantesLegibles = missingFields.map(f => labels[f] || f);

    if (faltantesLegibles.length === 1) {
      return `Para completar la reunión, necesito ${faltantesLegibles[0]}.`;
    }

    const ultima = faltantesLegibles.pop();
    return `Para completar la reunión, necesito ${faltantesLegibles.join(', ')} y ${ultima}.`;
  }

  if (toolKey === 'GMAIL_SEND_EMAIL') {
    const labels = {
      to: 'el correo del destinatario',
      subject: 'el asunto del correo',
      body: 'el contenido o mensaje del correo'
    };

    const faltantesLegibles = missingFields.map(f => labels[f] || f);

    if (faltantesLegibles.length === 1) {
      return `Para enviar el correo, necesito ${faltantesLegibles[0]}.`;
    }

    const ultima = faltantesLegibles.pop();
    return `Para enviar el correo, necesito ${faltantesLegibles.join(', ')} y ${ultima}.`;
  }

  if (toolKey === 'GOOGLEDRIVE_FIND_FILE') {
    return `¿Qué archivo o documento quieres buscar?`;
  }

  return `Faltan datos para completar esta acción: ${missingFields.join(', ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT PARA DEEPSEEK
// ─────────────────────────────────────────────────────────────────────────────

function construirToolsDescription(toolsDisponibles = []) {
  if (!Array.isArray(toolsDisponibles) || toolsDisponibles.length === 0) {
    return "";
  }

  const uniqueTools = [...new Set(toolsDisponibles.map(t => t.tool_key))];
  const definiciones = uniqueTools
    .map(toolKey => TOOL_DEFINITIONS[toolKey])
    .filter(Boolean);

  if (definiciones.length === 0) return "";

  const bullets = definiciones.map(def => {
    const key = Object.keys(TOOL_DEFINITIONS).find(k => TOOL_DEFINITIONS[k] === def);
    return `- ${key}: ${def.label}.`;
  }).join("\n");

  const ahora = new Date();
  const opcionesFecha = { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' };
  const hoy = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(ahora);
  const mananaDate = new Date(ahora);
  mananaDate.setDate(mananaDate.getDate() + 1);
  const manana = new Intl.DateTimeFormat('en-CA', opcionesFecha).format(mananaDate);

  return `

## HERRAMIENTAS DISPONIBLES
Tienes acceso a estas herramientas. Úsalas cuando el usuario lo pida:

${bullets}

## CÓMO RESPONDER CUANDO NECESITAS USAR UNA HERRAMIENTA
Responde ÚNICAMENTE con este JSON (sin texto adicional, sin markdown):

{
  "action": "NOMBRE_TOOL",
  "data": {
    "campo1": "valor1",
    "campo2": "valor2"
  }
}

## REGLAS CRÍTICAS PARA HERRAMIENTAS

### Para GMAIL_SEND_EMAIL:
- "to": correo del destinatario (SOLO si el usuario lo dio, sino deja vacío "")
- "subject": asunto del correo (SOLO si el usuario lo dio, sino deja vacío "")
- "body": contenido del correo (SOLO si el usuario lo dio, sino deja vacío "")
- Si el usuario dice "envía un correo a cjeisond@gmail.com con asunto revisión y contenido urgente revisar indicadores" → ya tienes los 3 campos, genera el JSON completo
- NUNCA inventes o rellenes campos con valores de reuniones anteriores
- NUNCA confundas una solicitud de correo con una reunión

### Para GOOGLECALENDAR_CREATE_EVENT:
- "summary": título del evento
- "start": fecha/hora inicio en formato YYYY-MM-DDTHH:MM:00
- "end": fecha/hora fin en formato YYYY-MM-DDTHH:MM:00
- "contact_name": nombre del usuario
- "contact_email": correo del usuario
- La fecha actual en Colombia es: ${hoy}
- "mañana" corresponde a: ${manana}
- NUNCA uses palabras como "mañana" en los campos de fecha, usa la fecha numérica

### Para GOOGLEDRIVE_FIND_FILE:
- "query": término de búsqueda

## REGLA GENERAL
- Si el usuario da TODOS los datos necesarios en un solo mensaje → genera el JSON directamente, NO hagas más preguntas
- Si faltan datos → pregunta SOLO por lo que falta, de forma natural y conversacional
- NUNCA confundas herramientas: un correo es un correo, una reunión es una reunión
- Si el usuario corrige o aclara, respeta la corrección inmediatamente
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS ADICIONALES
// ─────────────────────────────────────────────────────────────────────────────

function getWorkflowConfig(workflowKey) {
  return WORKFLOW_CONFIG[workflowKey] || null;
}

function seemsWorkflowConfirmation(text = "") {
  return esConfirmacion(text) || esCancelacion(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

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
  extractAllEmails,
  extractPhone,
  extractName,
  extractMeetingReason,
  extractEmailSubject,
  extractEmailBody,
  extractEmailRecipient,
  enrichCalendarPayloadFromText,
  enrichEmailPayloadFromText,
  enrichDrivePayloadFromText,
  seemsContactInfo,
  seemsSchedulingData,
  seemsEmailData,
  seemsDriveData,
  detectWorkflowIntent,
  getWorkflowConfig,
  seemsWorkflowConfirmation,
  classifyMessageRoute
};
