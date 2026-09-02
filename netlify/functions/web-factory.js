// web-factory.js — Web Factory: generar sitios web para clientes
// Flujo: AUVRO Admin -> crear proyecto -> Supabase -> GitHub (repo privado + commit) ->
//        Netlify (site enlazado al repo) -> dominio -> deploy -> estado.
//
// Validación de admin: mismo patrón que admin-data.js (token del usuario + perfiles.is_admin).
// Los secretos (GITHUB_TOKEN, NETLIFY_AUTH_TOKEN) se leen SOLO de variables de entorno.
//
// El action `create` (y `set_activo`) se ejecuta como **background function real**
// en web-factory-background.js (sufijo -background): hasta 15 min sin timeout síncrono.
// Aquí quedan las acciones interactivas (list, get, refresh_status, delete) que deben
// responder rápido. El dashboard hace polling de `refresh_status` / `get` para ver el
// estado final de los sitios mientras se crean o se apagan.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// ── Plantillas (archivos reales en wf-templates/templates, incluidas en el bundle) ──
function templatesDir() {
    const candidates = [
        path.resolve(process.cwd(), 'wf-templates', 'templates'),
        path.resolve(__dirname, '..', '..', 'wf-templates', 'templates'),
        path.resolve(__dirname, 'wf-templates', 'templates')
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
    }
    throw new Error(
        'No se encontraron las plantillas (wf-templates/templates). Verifica included_files en netlify.toml. Rutas probadas: ' +
        candidates.map(c => c + (fs.existsSync(c) ? ' (existe)' : ' (no existe)')).join(' | ')
    );
}

function leerPlantillas() {
    const dir = templatesDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return (manifest.templates || []).map(t => ({
        slug: t.slug,
        nombre: t.nombre || t.slug,
        descripcion: t.descripcion || ''
    }));
}

function listarArchivos(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...listarArchivos(full).map(f => ({ ...f, path: path.join(entry.name, f.path) })));
        } else if (entry.isFile()) {
            out.push({ path: entry.name, content: fs.readFileSync(full, 'utf8') });
        }
    }
    return out;
}

function leerArchivosPlantilla(slug) {
    const dir = templatesDir();
    const plantillaDir = path.join(dir, slug);
    if (!fs.existsSync(plantillaDir)) throw new Error('Plantilla "' + slug + '" no encontrada');
    return listarArchivos(plantillaDir);
}

function reemplazarTokens(contenido, valores) {
    return contenido.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (m, key) =>
        Object.prototype.hasOwnProperty.call(valores, key) ? String(valores[key]) : m
    );
}

function validarSlug(slug) {
    if (!slug) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug);
}

function validarDominio(dominio) {
    if (!dominio) return true;
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(dominio);
}

// WhatsApp a solo dígitos (para wa.me/<digitos>)
function normalizarWhatsapp(num) {
    if (!num) return '';
    return String(num).replace(/\D/g, '');
}

// Saneo para contenido que se incrusta en las plantillas generadas
function sanearTexto(v) {
    return String(v ?? '').replace(/[<>]/g, '').trim();
}

function sanearUrlLogo(v) {
    return String(v ?? '').replace(/["'<>]/g, '').trim();
}

// ── Widget de agente IA (embebible) ──
// Genera el snippet que el sitio generado carga de auvro.netlify.app/widget.js.
// Escape estricto de atributos para no romper el HTML generado.
function escaparAttr(v) {
    return String(v ?? '').replace(/["'<>&]/g, '');
}

function crearSnippetAgente(agenteId, agente, slug) {
    const id = String(agenteId ?? '').trim();
    const slugStr = String(slug ?? '').trim();
    if (!id && !slugStr) return '';
    let attrs = '';
    // data-store para resolución dinámica (prioritario); data-id como fallback
    if (slugStr) attrs += `data-store="${escaparAttr(slugStr)}"`;
    if (id) attrs += ` data-id="${escaparAttr(id)}"`;
    const nombre = (agente && agente.nombre_agente) || (agente && agente.name);
    if (nombre) attrs += ` data-name="${escaparAttr(nombre)}"`;
    return `<script src="https://auvro.netlify.app/widget.js" ${attrs}><\/script>`;
}

// Inyecta el widget justo antes de </body> en el HTML generado (solo si viene snippet).
function inyectarWidgetIndex(html, snippet) {
    if (!snippet) return html;
    if (!/<\/body>/i.test(html)) return html + snippet;
    return html.replace(/<\/body>/i, snippet + '\n</body>');
}

// ── Personalización de sitios: color principal + estilo de fuente ──
// El color y la fuente se inyectan como capa de override sobre las plantillas
// (que ya usan las variables --accent / --accent-dark), sin modificar los
// archivos de plantilla. Funciona con cualquier plantilla.
const FUENTES_GOOGLE = {
    inter: { css: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap', familia: "'Inter', system-ui, -apple-system, sans-serif" },
    poppins: { css: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap', familia: "'Poppins', system-ui, -apple-system, sans-serif" },
    montserrat: { css: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap', familia: "'Montserrat', system-ui, -apple-system, sans-serif" },
    roboto: { css: 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap', familia: "'Roboto', system-ui, -apple-system, sans-serif" },
    lora: { css: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap', familia: "'Lora', Georgia, serif" },
    playfair: { css: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800&display=swap', familia: "'Playfair Display', Georgia, serif" },
    oswald: { css: 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap', familia: "'Oswald', system-ui, sans-serif" }
};
const FUENTE_SISTEMA = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function validarAccent(v) {
    if (!v) return '#2563eb';
    const s = String(v).trim().toLowerCase();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return null;
    if (s.length === 4) {
        const h = s.slice(1);
        return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return s;
}

function oscurecerHex(hex) {
    const h = String(hex || '').replace('#', '');
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return hex || '#1d4ed8';
    const f = v => Math.max(0, Math.round(v * 0.82)).toString(16).padStart(2, '0');
    return '#' + f((n >> 16) & 255) + f((n >> 8) & 255) + f(n & 255);
}

function fuenteElegida(v) {
    const s = String(v || '').trim().toLowerCase();
    if (!s || s === 'sistema') return null;
    const f = FUENTES_GOOGLE[s];
    return f ? { key: s, ...f } : null;
}

function inyectarTema(html, accent, fuenteInfo) {
    const acc = validarAccent(accent) || '#2563eb';
    const dark = oscurecerHex(acc);
    const familia = (fuenteInfo && fuenteInfo.familia) || FUENTE_SISTEMA;
    // Soporte Bootstrap 5: las plantillas Bootstrap usan --bs-primary (y --bs-link-color /
    // --bs-btn-*) en vez de --accent. Las mapeamos a la misma variable para que el color
    // principal del panel se aplique también a plantillas MIT/Bootstrap.
    let bloque = `<style id="auvro-theme">:root{--accent:${acc}!important;--accent-dark:${dark}!important;--bs-primary:${acc}!important;--bs-link-color:${acc}!important;--bs-link-hover-color:${dark}!important;--bs-btn-primary-bg:${acc}!important;--bs-btn-primary-border-color:${acc}!important;--bs-btn-primary-hover-bg:${dark}!important;--bs-btn-primary-hover-border-color:${dark}!important;--bs-btn-primary-active-bg:${dark}!important;--bs-btn-primary-active-border-color:${dark}!important}*{font-family:${familia}!important}</style>`;
    if (fuenteInfo && fuenteInfo.css) {
        bloque = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${fuenteInfo.css}" rel="stylesheet">` + bloque;
    }
    if (!/<\/head>/i.test(html)) {
        return html.replace(/<html[^>]*>/i, m => m + '\n' + bloque).replace(/<!DOCTYPE[^>]*>/i, m => m + '\n' + bloque);
    }
    return html.replace(/<\/head>/i, bloque + '\n</head>');
}

// ── Re-sincronización de módulos en sitios existentes ──
// Web Factory solo entrega la plantilla (con sus módulos) a sitios NUEVOS. Los sitios
// existentes mantienen su index.html como snapshot: si se añade un módulo a la plantilla
// tienda (p. ej. Deportes), los sitios creados antes no lo reciben.
// Este inyector actualiza el index.html de un repo existente SIN reemplazar el contenido
// personalizado (ediciones del site-editor / agente AI): solo inserta las secciones,
// estilos y párrafo JS del módulo si aún no están presentes. Idempotente.
const SNIPPET_DEPORTES_SECCIONES = `<!-- DEPORTISTAS (se muestra solo si el proyecto tiene deportistas publicos) -->
    <section id="deportistas" class="section section-alt" hidden>
        <div class="container">
            <h2 class="section-title">Nuestros deportistas</h2>
            <p class="section-sub">Talento que se forma y se proyecta.</p>
            <div id="grid-deportistas" class="grid"></div>
        </div>
    </section>

    <!-- PLANES DEL CLUB (se muestra solo si hay planes) -->
    <section id="planes" class="section" hidden>
        <div class="container">
            <h2 class="section-title">Planes del Club</h2>
            <p class="section-sub">Formación deportiva integral.</p>
            <div id="grid-planes" class="grid"></div>
        </div>
    </section>

    <!-- VISORIAS (se muestra solo si hay visorias) -->
    <section id="visorias" class="section section-alt" hidden>
        <div class="container">
            <h2 class="section-title">Visorías</h2>
            <p class="section-sub">Tu oportunidad de mostrar tu talento.</p>
            <div id="grid-visorias" class="grid"></div>
        </div>
    </section>

    <!-- NOTICIAS (se muestra solo si hay noticias) -->
    <section id="noticias" class="section" hidden>
        <div class="container">
            <h2 class="section-title">Noticias</h2>
            <div id="grid-noticias" class="grid"></div>
        </div>
    </section>
`;

const SNIPPET_DEPORTES_CSS = `<style>\n    #grid-deportistas, #grid-planes, #grid-visorias, #grid-noticias { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; margin-top: 22px; }\n    @media (max-width: 600px) { #grid-deportistas, #grid-planes, #grid-visorias, #grid-noticias { grid-template-columns: 1fr; } }\n    .card-deporte { display: flex; flex-direction: column; background: #fff; border: 1px solid rgba(0,0,0,.12); border-radius: 14px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); }\n    .card-deporte .card-img { width: 100%; aspect-ratio: 16/9; object-fit: cover; }\n    .card-deporte.plan-card { align-items: flex-start; padding: 0; }\n    .card-deporte .card-body { padding: 16px 18px; display: flex; flex-direction: column; }\n    .card-deporte .card-body h3 { margin: 0 0 6px; font-size: 1.05rem; font-weight: 700; }\n    .card-deporte .card-meta { margin: 0; font-size: .82rem; color: #64748b; }\n    .card-deporte .card-body p { margin: 0 0 8px; font-size: .9rem; color: #334155; }\n    .card-deporte .precio { margin: 0 0 8px; font-size: 1.05rem; font-weight: 700; color: #0f172a; }\n</style>\n`;

const SNIPPET_DEPORTES_JS = `    <script>
    (function () {
        var slug = document.body.getAttribute('data-slug') || '';
        if (!slug) return;
        var fmtPesos = function (c) { return '$' + (Number(c) || 0).toLocaleString('es-CO').replace(/,/g, '.') + ''; };
        var esc = function (s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        function mostrar(seccion) { var el = document.getElementById(seccion); if (el) el.hidden = false; }
        function waLink(num, texto) {
            var d = String(document.body.getAttribute('data-wa') || '').replace(/\\D/g, '');
            return d ? '<a class="btn btn-wa" href="https://wa.me/' + d + '" target="_blank" rel="noopener">' + (texto || 'Inscribirme') + '</a>' : '';
        }
        fetch('https://auvro.netlify.app/.netlify/functions/deportes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'catalogo_publico', slug: slug })
        }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d.ok) return;
            if (d.deportistas && d.deportistas.length) {
                document.getElementById('grid-deportistas').innerHTML = d.deportistas.map(function (p) {
                    return '<div class="card-deporte">'
                        + (p.fotografia_url ? '<img class="card-img" src="' + esc(p.fotografia_url) + '" alt="' + esc(p.nombre) + '" loading="lazy">' : '')
                        + '<div class="card-body"><h3>' + esc(p.nombre) + '</h3>'
                        + '<p class="card-meta">' + [p.posicion, p.categoria, p.edad ? p.edad + ' años' : null, p.pierna, p.club, p.ciudad].filter(Boolean).join(' · ') + '</p>'
                        + (p.perfil ? '<p>' + esc(p.perfil) + '</p>' : '')
                        + (p.logros && p.logros.length ? '<p class="card-meta">🏆 ' + esc(p.logros.join(' · ')) + '</p>' : '')
                        + '</div></div>';
                }).join('');
                mostrar('deportistas');
            }
            if (d.planes && d.planes.length) {
                document.getElementById('grid-planes').innerHTML = d.planes.map(function (p) {
                    return '<div class="card-deporte plan-card">'
                        + '<div class="card-body"><h3>' + esc(p.nombre) + '</h3>'
                        + (p.descripcion ? '<p>' + esc(p.descripcion) + '</p>' : '')
                        + '<p class="precio">' + fmtPesos(p.precio_cents) + ' <span style="font-size:.75rem">/ ' + esc(p.periodo || 'mes') + '</span></p>'
                        + waLink(null, 'Consultar por WhatsApp')
                        + '</div></div>';
                }).join('');
                mostrar('planes');
            }
            if (d.visorias && d.visorias.length) {
                document.getElementById('grid-visorias').innerHTML = d.visorias.map(function (v) {
                    var fecha = v.fecha ? new Date(v.fecha).toLocaleDateString('es-CO') : 'Por definir';
                    return '<div class="card-deporte">'
                        + '<div class="card-body"><h3>' + esc(v.titulo) + '</h3>'
                        + '<p class="card-meta">' + fecha + (v.lugar ? ' · ' + esc(v.lugar) : '') + (v.cupo ? ' · Cupo ' + v.cupo : '') + '</p>'
                        + (v.descripcion ? '<p>' + esc(v.descripcion) + '</p>' : '')
                        + '<p class="precio">' + fmtPesos(v.costo_cents) + '</p>'
                        + waLink(null, 'Inscribirme')
                        + '</div></div>';
                }).join('');
                mostrar('visorias');
            }
            if (d.noticias && d.noticias.length) {
                document.getElementById('grid-noticias').innerHTML = d.noticias.slice(0, 6).map(function (n) {
                    var fecha = n.fecha_publicacion ? new Date(n.fecha_publicacion).toLocaleDateString('es-CO') : '';
                    return '<div class="card-deporte">'
                        + (n.imagen_url ? '<img class="card-img" src="' + esc(n.imagen_url) + '" alt="' + esc(n.titulo) + '" loading="lazy">' : '')
                        + '<div class="card-body"><h3>' + esc(n.titulo) + '</h3>'
                        + '<p class="card-meta">' + esc(n.categoria || 'General') + (fecha ? ' · ' + fecha : '') + '</p>'
                        + (n.contenido ? '<p>' + esc(n.contenido.slice(0, 140)) + '…</p>' : '')
                        + '</div></div>';
                }).join('');
                mostrar('noticias');
            }
        }).catch(function () {});
    })();
    </script>
`;

// Idempotente: si el HTML ya renderiza el módulo de Deportes, no cambia nada.
function inyectarDeportesEnHtml(html) {
    if (!html) return html;
    if (/grid-deportistas/.test(html) || /catalogo_publico/.test(html) || /d\.deportistas/.test(html)) {
        // Ya tiene el módulo: si el JS del catálogo quedó corrupto en el repo
        // (p. ej. un resync viejo grabó cierres como '</html>' dentro del string,
        // rompiendo el parseo y dejando las secciones ocultas), repararlo.
        return repararJsCatalogo(html);
    }

    // 1) Secciones (antes del footer o de la página de suspensión si existe).
    let conSecciones = html;
    if (!/id="deportistas"/.test(html)) {
        const loc = /<footer[^>]*>/i.exec(html) || /<\/body>/i.exec(html);
        if (loc) conSecciones = html.slice(0, loc.index) + SNIPPET_DEPORTES_SECCIONES + '\n' + html.slice(loc.index);
    }

    // 2) CSS del módulo (idempotente para los selectores que lo requieren).
    //    Nota: se usa callback (no string) en replace() porque el snippet contiene
    //    '$' (signo de pesos del precio); un string replacement interpreta '$'' como
    //    "el resto tras la coincidencia" y corrompe el JS. Un callback se inserta tal cual.
    let conCss = conSecciones;
    if (!/#grid-deportistas/.test(conCss)) {
        if (/<\/head>/i.test(conCss)) conCss = conCss.replace(/<\/head>/i, () => SNIPPET_DEPORTES_CSS + '\n</head>');
        else if (/<\/body>/i.test(conCss)) conCss = conCss.replace(/<\/body>/i, () => SNIPPET_DEPORTES_CSS + '\n</body>');
    }

    // 3) JS de carga pública. Misma precaución con '$' → callback de replace.
    let conJs = conCss;
    if (!/catalogo_publico/.test(conJs)) {
        if (/<\/body>/i.test(conJs)) conJs = conJs.replace(/<\/body>/i, () => SNIPPET_DEPORTES_JS + '\n</body>');
        else conJs = conJs + '\n' + SNIPPET_DEPORTES_JS + '\n</body>';
    }
    return repararJsCatalogo(conJs);
}

// El fragmento del catálogo público debe parsear como JS. Si un resync viejo
// grabó el bloque con cierres sueltos (p. ej. '</html>' incrustado en una cadena,
// típico de scripts generados desde PowerShell/shell), el navegador aborta el <script>
// y las secciones quedan ocultas aunque el módulo esté presente. Este paso detecta ese
// daño y sustituye el bloque completo por el snippet limpio, conservando el resto del HTML.
function repararJsCatalogo(html) {
    if (!html) return html;
    const m = /<script>[\s\S]*?var fmtPesos = function[\s\S]*?<\/script>/i.exec(html);
    if (!m) return html;
    // Marca de corrupción: la cadena del formateador de precios quedó con un cierre suelto
    // ('</html>' incrustado dentro del string), lo que rompe el parseo JS y deja las
    // secciones ocultas aunque el módulo esté presente en el HTML.
    if (/<\/html>\s*\+ \(Number\(/.test(m[0])) {
        return html.replace(m[0], () => SNIPPET_DEPORTES_JS);
    }
    return html;
}

// ── Seguridad por dominio del agente ──
// chat.js valida que el Origin del sitio embebido esté en agente.dominios_permitidos.
// Aquí garantizamos que los sitios generados queden autorizados automáticamente.
function hostnameDeUrl(url) {
    if (!url) return '';
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

function hostnamesParaSitio(netlifyUrl, dominio) {
    const lista = new Set();
    const net = hostnameDeUrl(netlifyUrl);
    if (net) lista.add(net);
    if (dominio) {
        const d = String(dominio).toLowerCase().trim()
            .replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '');
        if (d) { lista.add(d); lista.add('www.' + d); }
    }
    return [...lista];
}

async function garantizarDominiosAgente(agenteId, hostnames) {
    const nuevos = (Array.isArray(hostnames) ? hostnames : [])
        .map(h => String(h).toLowerCase().trim()
            .replace(/^https?:\/\//, '').replace(/\/+$/, ''))
        .filter(h => h && h.includes('.') && !h.startsWith('.'));
    if (!agenteId || nuevos.length === 0) return;
    const { data: agente } = await supabase
        .from('agentes_ia')
        .select('id, dominios_permitidos')
        .eq('id', Number(agenteId))
        .maybeSingle();
    if (!agente) return;
    const actuales = Array.isArray(agente.dominios_permitidos) ? agente.dominios_permitidos : [];
    const faltantes = nuevos.filter(h => !actuales.includes(h));
    if (faltantes.length === 0) return;
    await supabase.from('agentes_ia')
        .update({ dominios_permitidos: [...actuales, ...faltantes] })
        .eq('id', agente.id);
}

// ── IA para Web Factory: propuesta de diseño asistido (OpenCode Zen free) ──
// Proveedor principal: OpenCode Zen (modelos "Free", por tiempo limitado).
// Fallback automático: DeepSeek → OpenAI (misma infraestructura que chat.js/site-editor.js).
async function llamarIAWebFactory(mensajes, maxTokens = 3000) {
    const zenKey = process.env.ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY;
    const zenModel = process.env.ZEN_MODEL || 'big-pickle';
    const errores = [];

    if (zenKey) {
        try {
            const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${zenKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: zenModel, messages: mensajes, temperature: 0.3, max_tokens: maxTokens }),
                signal: AbortSignal.timeout(45000)
            });
            const data = await res.json();
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
            errores.push('Zen: ' + (data.error?.message || `HTTP ${res.status}`));
        } catch (e) { errores.push('Zen: ' + e.message); }
    }

    if (process.env.DEEPSEEK_API_KEY) {
        try {
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-v4-flash', messages: mensajes, temperature: 0.2, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
                signal: AbortSignal.timeout(45000)
            });
            const data = await res.json();
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
            errores.push('DeepSeek: ' + (data.error?.message || `HTTP ${res.status}`));
        } catch (e) { errores.push('DeepSeek: ' + e.message); }
    }

    const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENIA_KEY;
    if (fallbackKey) {
        try {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${fallbackKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-4o-mini', messages: mensajes, temperature: 0.3, max_tokens: maxTokens }),
                signal: AbortSignal.timeout(60000)
            });
            const data = await res.json();
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
            errores.push('OpenAI: ' + (data.error?.message || `HTTP ${res.status}`));
        } catch (e) { errores.push('OpenAI: ' + e.message); }
    }

    throw new Error('No hay proveedor de IA disponible: ' + (errores.join(' | ') || 'sin claves configuradas'));
}

// Prompt de sistema fijo (vive en el backend, no se escribe por sitio): condensa la
// metodología UX/UI del producto. Se combina con el contexto del negocio para producir
// una propuesta de contenido + dirección visual en JSON estricto.
const PROMPT_DISENO_UXUI = `Eres un Senior UX/UI Designer + Product Designer + Art Director. Diseñas experiencias digitales personalizadas para cada negocio, NO plantillas reutilizadas.

Metodología:
1. PRIMERO entiende el negocio, su público y su objetivo comercial (usa SOLO el contexto proporcionado; NO inventes datos: ni precios, productos, testimonios, certificaciones, estadísticas ni ubicaciones).
2. Define la dirección visual que encaje con ESE negocio específico (editorial, premium, minimalista, tecnológico, cálido, inmersivo...). No todas las marcas usan el mismo hero/colores/estilo.
3. Propón contenido real por sección (hero, propuesta de valor, servicios/productos, prueba de confianza, CTA, contacto), jerarquía clara, CTA principal + secundarios que correspondan al negocio (no siempre "Comprar"/"Contactar").
4. Elige paleta (accent en hex) y tipografía (fuente: inter|poppins|montserrat|roboto|lora|playfair|oswald) coherentes con la marca.
5. Aplica: jerarquía visual, mobile-first, accesibilidad, estados de interfaz, escaneabilidad. Evita sobrecarga (demasiados gradientes, sombras o animaciones).

Responde SOLO JSON estricto (sin markdown), con este esquema:
{
  "resumen": "2-3 líneas: qué propone y por qué encaja con este negocio",
  "descripcion": "Descripción comercial corta (1-2 frases) del negocio",
  "slogan": "Slogan corto y memorable",
  "accent_color": "#RRGGBB",
  "fuente": "inter|poppins|montserrat|roboto|lora|playfair|oswald",
  "secciones": [
    {"titulo": "Título de la sección", "contenido": "Contenido breve (1-3 frases) que puede usarse en esa sección"}
  ]
}
Siempre en español.`;

async function generarPropuestaDiseno(body) {
    const { contexto, nombre, descripcion, slogan, plantilla } = body;
    if (!contexto || !String(contexto).trim()) throw new Error('Falta el contexto del negocio');

    let plantillaNombre = plantilla || 'landing';
    try {
        const pl = leerPlantillas().find(p => p.slug === plantilla);
        if (pl) plantillaNombre = pl.nombre;
    } catch (_) {}

    const userPrompt = `NEGOCIO: ${nombre || '(sin nombre)'}
PLANTILLA BASE: ${plantillaNombre}
DESCRIPCION ACTUAL: ${descripcion || '(vacía)'}
SLOGAN ACTUAL: ${slogan || '(vacío)'}

CONTEXTO DEL NEGOCIO:
${String(contexto).slice(0, 6000)}

Analiza el negocio y responde el JSON:`;

    const raw = await llamarIAWebFactory([
        { role: 'system', content: PROMPT_DISENO_UXUI },
        { role: 'user', content: userPrompt }
    ], 3000);

    const limpio = String(raw).replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(limpio);
    } catch (_) {
        throw new Error('La IA no devolvió JSON válido');
    }

    const accent = validarAccent(parsed.accent_color || null) || null;
    const fuente = fuenteElegida(parsed.fuente || '') ? String(parsed.fuente).trim() : null;
    const secciones = Array.isArray(parsed.secciones)
        ? parsed.secciones.slice(0, 12).map(s => ({
            titulo: sanearTexto(s && s.titulo),
            contenido: sanearTexto(s && s.contenido)
        })).filter(s => s.titulo)
        : [];

    return {
        resumen: sanearTexto(parsed.resumen) || 'Propuesta generada.',
        descripcion: sanearTexto(parsed.descripcion),
        slogan: sanearTexto(parsed.slogan),
        accent_color: accent,
        fuente,
        secciones
    };
}

// ── Helpers GitHub ──
async function detalleErrorGitHub(res) {
    let detalle = '';
    try {
        const e = await res.json();
        detalle = Array.isArray(e.errors) ? e.errors.map(x => x.message).join('; ') : (e.message || '');
    } catch (_) {}
    return detalle;
}

async function esperarRepoListo(owner, slug, headers, maxMs = 10000) {
    const inicio = Date.now();
    while (Date.now() - inicio < maxMs) {
        const res = await fetch(`https://api.github.com/repos/${owner}/${slug}`, { headers });
        if (res.ok) return;
        await new Promise(r => setTimeout(r, 600));
    }
}

// ── Inyectar widget en repo existente (cuando se asigna agente a tienda sin widget) ──
async function inyectarWidgetEnRepo(proyecto) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return;
    if (!proyecto.github_owner || !proyecto.github_repo) return;

    const owner = proyecto.github_owner;
    const repo = proyecto.github_repo;
    const branch = proyecto.default_branch || 'main';
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

    // Leer index.html del repo
    const fileRes = await fetchGitHub(`${base}/contents/index.html?ref=${branch}`, { headers });
    if (!fileRes || !fileRes.ok) return;
    const fileData = await fileRes.json();
    const html = Buffer.from(fileData.content, 'base64').toString('utf8');

    // Verificar si ya tiene el widget
    if (html.includes('widget.js')) return;

    // Generar snippet
    const snippet = crearSnippetAgente(proyecto.agente_id, null, proyecto.slug);
    if (!snippet) return;

    // Inyectar antes de </body>
    const updatedHtml = html.replace(/<\/body>/i, snippet + '\n</body>');
    if (updatedHtml === html) return;

    // Commit y push
    const blobRes = await fetchGitHub(`${base}/git/blobs`, {
        method: 'POST', headers,
        body: JSON.stringify({ content: Buffer.from(updatedHtml, 'utf8').toString('base64'), encoding: 'base64' })
    });
    if (!blobRes || !blobRes.ok) return;
    const blob = await blobRes.json();

    const refRes = await fetchGitHub(`${base}/git/ref/heads/${branch}`, { headers });
    if (!refRes || !refRes.ok) return;
    const refData = await refRes.json();

    const treeRes = await fetchGitHub(`${base}/git/trees`, {
        method: 'POST', headers,
        body: JSON.stringify({ tree: [{ path: 'index.html', mode: '100644', type: 'blob', sha: blob.sha }], base_tree: refData.object.sha })
    });
    if (!treeRes || !treeRes.ok) return;
    const treeData = await treeRes.json();

    const commitRes = await fetchGitHub(`${base}/git/commits`, {
        method: 'POST', headers,
        body: JSON.stringify({ message: 'feat: inyectar widget de IA (asignación de agente)', tree: treeData.sha, parents: [refData.object.sha] })
    });
    if (!commitRes || !commitRes.ok) return;
    const commitData = await commitRes.json();

    await fetchGitHub(`${base}/git/refs/heads/${branch}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ sha: commitData.sha, force: true })
    });

    // Trigger rebuild
    if (proyecto.netlify_site_id) {
        await dispararBuild(proyecto.netlify_site_id);
    }
}

// ── Commit de uno o varios archivos en un repo privado (rama default) ──
// Sube blobs + construye un tree con los archivos dados y hace un commit+pull
// en la rama default del repo. Reutilizado por la re-sincronización de plantilla.
async function commitArchivosEnRepo(proyecto, archivos, mensaje) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Falta la variable GITHUB_TOKEN en Netlify');
    if (!proyecto.github_owner || !proyecto.github_repo) throw new Error('El proyecto no tiene repo de GitHub asociado');

    const owner = proyecto.github_owner;
    const repo = proyecto.github_repo;
    const branch = proyecto.default_branch || 'main';
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

    const tree = await Promise.all((Array.isArray(archivos) ? archivos : [archivos]).map(async f => {
        const blobRes = await fetchGitHub(`${base}/git/blobs`, {
            method: 'POST', headers,
            body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' })
        });
        if (!blobRes || !blobRes.ok) throw new Error('GitHub: no se pudo crear el blob para ' + f.path);
        const blob = await blobRes.json();
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));

    const refRes = await fetchGitHub(`${base}/git/ref/heads/${branch}`, { headers });
    if (!refRes || !refRes.ok) throw new Error(`GitHub: no se pudo leer la rama ${branch}`);
    const refData = await refRes.json();

    const treeRes = await fetchGitHub(`${base}/git/trees`, {
        method: 'POST', headers,
        body: JSON.stringify({ tree, base_tree: refData.object.sha })
    });
    if (!treeRes || !treeRes.ok) throw new Error('GitHub: no se pudo construir el árbol');
    const treeData = await treeRes.json();

    const commitRes = await fetchGitHub(`${base}/git/commits`, {
        method: 'POST', headers,
        body: JSON.stringify({ message: mensaje, tree: treeData.sha, parents: [refData.object.sha] })
    });
    if (!commitRes || !commitRes.ok) throw new Error('GitHub: no se pudo crear el commit');
    const commitData = await commitRes.json();

    const pushRes = await fetchGitHub(`${base}/git/refs/heads/${branch}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ sha: commitData.sha, force: true })
    });
    if (!pushRes || !pushRes.ok) throw new Error('GitHub: no se pudo empujar el commit a ' + branch);
    return commitData.sha;
}

async function fetchGitHub(uri, opciones, reintentos = 3) {
    let res = null;
    for (let i = 1; i <= reintentos; i++) {
        res = await fetch(uri, opciones);
        if (res.ok || ![404, 409, 429].includes(res.status)) return res;
        if (i < reintentos) await new Promise(r => setTimeout(r, 800 * i));
    }
    return res;
}

async function crearRepoGitHub(owner, slug, descripcion, archivos) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Falta la variable GITHUB_TOKEN en Netlify');
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
    };

    const repoRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            name: slug,
            private: true,
            description: descripcion || 'Sitio generado con Web Factory (AUVRO)',
            auto_init: true,
            has_issues: true,
            has_wiki: false
        })
    });
    if (!repoRes.ok) {
        const e = await repoRes.json().catch(() => ({}));
        const detalle = Array.isArray(e.errors) ? e.errors.map(x => x.message).join('; ') : (e.message || repoRes.statusText);
        throw new Error('GitHub: ' + detalle);
    }
    const repo = await repoRes.json();
    const ownerReal = (repo && repo.owner && repo.owner.login) || owner;
    const rama = (repo && repo.default_branch) || 'main';
    const base = `https://api.github.com/repos/${ownerReal}/${slug}`;

    await esperarRepoListo(ownerReal, slug, headers);

    // La rama default ya existe (la creó auto_init con un commit mínimo).
    const refRes = await fetchGitHub(`${base}/git/ref/heads/${rama}`, { headers });
    if (!refRes.ok) throw new Error(`GitHub: no se pudo leer la rama ${rama} (HTTP ${refRes.status}): ${await detalleErrorGitHub(refRes) || refRes.statusText}`);
    const refData = await refRes.json();
    const headRes = await fetchGitHub(`${base}/git/commits/${refData.object.sha}`, { headers });
    if (!headRes.ok) throw new Error(`GitHub: no se pudo leer el commit inicial (HTTP ${headRes.status}): ${await detalleErrorGitHub(headRes) || headRes.statusText}`);
    const headCommit = await headRes.json();

    const tree = [];
    for (const f of archivos) {
        const blobRes = await fetchGitHub(`${base}/git/blobs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' })
        });
        if (!blobRes.ok) {
            throw new Error(
                `GitHub: no se pudo subir el archivo ${f.path} (HTTP ${blobRes.status}): ${await detalleErrorGitHub(blobRes) || blobRes.statusText}`
            );
        }
        const blob = await blobRes.json();
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const treeRes = await fetchGitHub(`${base}/git/trees`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tree, base_tree: headCommit.tree.sha })
    });
    if (!treeRes.ok) throw new Error(`GitHub: no se pudo crear el árbol de archivos (HTTP ${treeRes.status}): ${await detalleErrorGitHub(treeRes) || treeRes.statusText}`);
    const tdata = await treeRes.json();

    const commitRes = await fetchGitHub(`${base}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            message: 'Sitio generado por Web Factory',
            tree: tdata.sha,
            parents: [refData.object.sha]
        })
    });
    if (!commitRes.ok) throw new Error(`GitHub: no se pudo crear el commit (HTTP ${commitRes.status}): ${await detalleErrorGitHub(commitRes) || commitRes.statusText}`);
    const cdata = await commitRes.json();

    const refUpdate = await fetchGitHub(`${base}/git/refs/heads/${rama}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: cdata.sha, force: true })
    });
    if (!refUpdate.ok) throw new Error(`GitHub: no se pudo actualizar la rama ${rama} (HTTP ${refUpdate.status}): ${await detalleErrorGitHub(refUpdate) || refUpdate.statusText}`);

    return { repo, owner: ownerReal, branch: rama };
}

async function obtenerOwnerGitHub() {
    if (process.env.GITHUB_OWNER) return process.env.GITHUB_OWNER;
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Falta la variable GITHUB_TOKEN en Netlify');
    const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) throw new Error('GitHub: no se pudo obtener el usuario del token');
    const data = await res.json();
    return data.login;
}

// ── Helpers Netlify ──
function netlifyHeaders() {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) throw new Error('Falta la variable NETLIFY_AUTH_TOKEN en Netlify');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function crearSitioNetlify(owner, slug, branch = 'main', repoId = null) {
    const repoBody = { provider: 'github', repo: `${owner}/${slug}`, branch, private: true, cmd: '', dir: '' };
    if (process.env.NETLIFY_GITHUB_INSTALLATION_ID) {
        repoBody.installation_id = Number(process.env.NETLIFY_GITHUB_INSTALLATION_ID);
    }
    if (repoId) repoBody.repo_id = Number(repoId);
    const intento = async (nombre) => {
        return await fetch('https://api.netlify.com/api/v1/sites', {
            method: 'POST',
            headers: netlifyHeaders(),
            body: JSON.stringify(nombre ? { name: nombre, repo: repoBody } : { repo: repoBody })
        });
    };

    // El subdominio siempre debe estar relacionado con el slug.
    // Se intenta slug, slug-1, slug-2... y solo como último recurso Netlify genera uno aleatorio.
    const nombres = [slug];
    for (let i = 1; i <= 20; i++) nombres.push(`${slug}-${i}`);

    let res = null;
    for (const nombre of nombres) {
        res = await intento(nombre);
        if (res.status !== 422) break;
    }
    if (res.status === 422) res = await intento(null);
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error('Netlify: ' + (e.message || res.statusText));
    }
    const data = await res.json();
    return { site_id: data.id, url: data.ssl_url || data.url || data.ssl_ui_url || '' };
}

async function dispararBuild(siteId) {
    await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
        method: 'POST',
        headers: netlifyHeaders()
    }).catch(() => {});
}

// ── Suspension (apagar/reactivar sitios) ──
// Para "apagar" un sitio se publica un deploy directo (sin build) que solo
// contiene index.html con una pagina de "suspendido". Al reactivar se dispara
// un build desde el repo de GitHub (que conserva el sitio real), restaurandolo.
function paginaSuspension(empresa) {
    const nom = sanearTexto(empresa);
    const titulo = nom ? `El sitio de ${nom} está suspendido` : 'Este sitio está suspendido';
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${titulo}</title>
<style>
  *{margin:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0d14;font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;color:#eef2f8;padding:24px;text-align:center}
  .card{max-width:430px;width:100%}
  .ico{width:76px;height:76px;margin:0 auto 24px;border-radius:22px;display:flex;align-items:center;justify-content:center;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.32)}
  .ico svg{width:34px;height:34px;stroke:#3b82f6}
  h1{font-size:1.3rem;font-weight:800;letter-spacing:-.02em;line-height:1.3;margin-bottom:12px}
  p{color:#94a3b8;font-size:.95rem;line-height:1.6}
  .note{margin-top:24px;padding-top:18px;border-top:1px solid rgba(148,163,184,.16);font-size:.8rem;color:#5d6b7d}
</style>
</head>
<body>
  <div class="card">
    <div class="ico">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
    </div>
    <h1>${titulo}</h1>
    <p>Este sitio está temporalmente fuera de línea.<br>Si eres el propietario, contacta a tu proveedor para reactivarlo.</p>
    <div class="note">AUVRO · Web Factory</div>
  </div>
</body>
</html>`;
}

function sha1hex(s) {
    return crypto.createHash('sha1').update(Buffer.from(s, 'utf8')).digest('hex');
}

// Publica un deploy directo (file deploy) en el sitio: solo index.html.
async function publicarSuspension(siteId, html) {
    const headers = netlifyHeaders();
    const files = { '/index.html': html };
    const digest = {};
    for (const [ruta, contenido] of Object.entries(files)) digest[ruta] = sha1hex(contenido);

    const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ files: digest })
    });
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error('Netlify: no se pudo crear el deploy de suspensión: ' + (e.message || res.statusText));
    }
    const deploy = await res.json();

    // IMPORTANTE: deploy.required contiene los SHA1 (digest) de los archivos que
    // Netlify aún no tiene, NO las rutas. Sin mapear digest -> ruta el archivo
    // nunca se sube y el deploy se queda en "uploading" hasta el timeout.
    const porDigest = {};
    for (const [ruta, contenido] of Object.entries(files)) porDigest[sha1hex(contenido)] = ruta;
    const pendientes = (deploy.required && deploy.required.length)
        ? deploy.required.map(d => porDigest[d]).filter(Boolean)
        : Object.keys(files);
    for (const ruta of pendientes) {
        const contenido = files[ruta];
        const up = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files/${ruta.replace(/^\//, '')}`, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'text/html' },
            body: contenido
        });
        if (!up.ok) throw new Error('Netlify: no se pudo subir el archivo de suspensión (' + ruta + ')');
    }

    const inicio = Date.now();
    while (Date.now() - inicio < 30000) {
        const d = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { headers });
        if (d.ok) {
            const data = await d.json();
            if (data.state === 'ready') return deploy;
            if (data.state === 'error') throw new Error('Netlify: el deploy de suspensión falló');
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('Netlify: el deploy de suspensión tardó demasiado');
}

function mapearEstadoDominio(state) {
    if (!state) return 'pendiente';
    return /^(verified|active|configured)$/i.test(state) ? 'verificado' : 'pendiente';
}

function mapearEstadoDeploy(state) {
    if (!state) return 'building';
    if (state === 'ready') return 'ready';
    if (state === 'error') return 'error';
    return 'building';
}

async function registrarDominio(siteId, dominio) {
    const reintentos = 3;
    let res = null;
    for (let i = 1; i <= reintentos; i++) {
        res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/domains`, {
            method: 'POST',
            headers: netlifyHeaders(),
            body: JSON.stringify({ hostname: dominio })
        });
        if (res.ok) {
            const data = await res.json();
            return {
                dominio_estado: mapearEstadoDominio(data.state),
                ssl_estado: data && data.ssl && data.ssl.state ? (data.ssl.state === 'issued' ? 'activo' : 'pendiente') : null
            };
        }
        if (i < reintentos) await new Promise(r => setTimeout(r, 2000 * i));
    }
    const e = await res.json().catch(() => ({}));
    throw new Error(
        `Netlify: no se pudo registrar el dominio "${dominio}" en el sitio ${siteId} (HTTP ${res.status}): ${e.message || res.statusText}`
    );
}

async function consultarEstadoNetlify(proyecto) {
    const out = { estado_deploy: proyecto.estado_deploy || 'building', dominio_estado: proyecto.dominio_estado, ssl_estado: proyecto.ssl_estado, deploy_error: null };
    if (!proyecto.netlify_site_id) return out;

    const deployRes = await fetch(
        `https://api.netlify.com/api/v1/sites/${proyecto.netlify_site_id}/deploys?per_page=1`,
        { headers: netlifyHeaders() }
    ).catch(() => null);
    if (deployRes && deployRes.ok) {
        const list = await deployRes.json();
        const d = list && list[0];
        if (d && d.state) {
            out.estado_deploy = mapearEstadoDeploy(d.state);
            if (d.state === 'error') out.deploy_error = d.error_message || 'El deploy fallo en Netlify';
        }
    }

    if (proyecto.dominio) {
        const domRes = await fetch(
            `https://api.netlify.com/api/v1/sites/${proyecto.netlify_site_id}/domains`,
            { headers: netlifyHeaders() }
        ).catch(() => null);
        if (domRes && domRes.ok) {
            const list = await domRes.json();
            const d = (list || []).find(x => x.name === proyecto.dominio);
            if (d) {
                out.dominio_estado = mapearEstadoDominio(d.state);
                out.ssl_estado = d && d.ssl && d.ssl.state ? (d.ssl.state === 'issued' ? 'activo' : 'pendiente') : null;
            }
        }
    }
    return out;
}

function estadoGeneral(estadoDeploy, dominio, dominioEstado) {
    if (estadoDeploy === 'error') return 'error';
    if (estadoDeploy === 'ready') return (dominio && dominioEstado !== 'verificado') ? 'dominio_pendiente' : 'publicado';
    return 'deploying';
}

// ── DB ──
async function actualizarProyecto(id, campos) {
    const { data, error } = await supabase
        .from('web_projects')
        .update({ ...campos, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw new Error('Supabase: ' + (error.code ? '[' + error.code + '] ' : '') + error.message);
    return data;
}

async function refrescarYGuardar(proyecto) {
    try {
        const estado = await consultarEstadoNetlify(proyecto);
        const { deploy_error, ...campos } = estado;
        const nuevo = {
            ...proyecto,
            ...campos,
            estado: proyecto.activo === false ? 'inactivo' : estadoGeneral(estado.estado_deploy, proyecto.dominio, estado.dominio_estado),
            error: estado.estado_deploy === 'error' ? (deploy_error || 'El deploy fallo en Netlify') : null
        };
        return await actualizarProyecto(proyecto.id, nuevo);
    } catch (err) {
        return actualizarProyecto(proyecto.id, { error: err.message }).catch(() => proyecto);
    }
}

// ── Pipeline de creación (background) ──
async function pipelineCrear(body, adminId) {
    const { cliente, nombre, slug, plantilla, dominio, descripcion, logo, slogan, whatsapp, agente_id, accent_color, fuente, contexto, propuesta_ia, modulos } = body;

    // Si el admin aprobó una propuesta de IA, los valores de contenido/diseño provienen de ella
    // (el usuario puede editarlos en el modal antes de aprobar; aquí solo se aplican).
    const diseno = (propuesta_ia && typeof propuesta_ia === 'object') ? propuesta_ia : null;
    const descripcionFinal = (diseno && diseno.descripcion) ? String(diseno.descripcion) : (descripcion || '');
    const sloganFinal = (diseno && diseno.slogan) ? String(diseno.slogan) : (slogan || '');
    const accentFinal = (diseno && diseno.accent_color && validarAccent(diseno.accent_color)) ? diseno.accent_color : accent_color;
    const fuenteFinal = (diseno && diseno.fuente && fuenteElegida(diseno.fuente)) ? diseno.fuente : (fuente || '');

    const accent = validarAccent(accentFinal);
    if (accent === null) throw new Error('Color principal inválido (usa #RRGGBB)');
    const fuenteInfo = fuenteElegida(fuenteFinal);

    const plantillas = leerPlantillas();
    const plantillaElegida = plantillas.find(p => p.slug === plantilla) || plantillas[0];
    if (!plantillaElegida) throw new Error('No hay plantillas disponibles');

    // Agente IA opcional: se valida ANTES de insertar (debe existir y pertenecer al admin).
    let agenteRow = null;
    if (agente_id) {
        const { data: ag, error: agErr } = await supabase
            .from('agentes_ia')
            .select('id, nombre_agente, prompt_sistema')
            .eq('id', Number(agente_id))
            .eq('user_id', adminId)
            .maybeSingle();
        if (agErr) throw new Error('Error al validar el agente: ' + (agErr.message || agErr));
        if (!ag) throw new Error('El agente de IA seleccionado no existe o no es tuyo');
        agenteRow = ag;
    }
    const snippetAgente = crearSnippetAgente(agente_id, agenteRow, slug);

    const valores = {
        EMPRESA: nombre,
        DESCRIPCION: descripcionFinal || nombre,
        SLUG: slug,
        SLOGAN: sanearTexto(sloganFinal),
        LOGO: sanearUrlLogo(logo),
        WHATSAPP: normalizarWhatsapp(whatsapp),
        ACCENT: accent,
        ACCENT_DARK: oscurecerHex(accent),
        FONT_FAMILY: (fuenteInfo ? fuenteInfo.familia : FUENTE_SISTEMA),
        FONT_NAME: (fuenteInfo ? fuenteInfo.key : 'sistema'),
        FONT_LINK: (fuenteInfo && fuenteInfo.css ? fuenteInfo.css : '')
    };

    // 1) Registrar en Supabase (estado: creando)
    const insDatos = {
        cliente, nombre, slug, plantilla: plantillaElegida.slug,
        descripcion: descripcionFinal || null, dominio: dominio || null,
        logo: valores.LOGO || null, slogan: valores.SLOGAN || null, whatsapp: valores.WHATSAPP || null,
        agente_id: agenteRow ? agenteRow.id : null,
        accent_color: accent, fuente: (fuenteInfo ? fuenteInfo.key : 'sistema'),
        modulos: Array.isArray(modulos) ? modulos.filter(m => ['deportes'].includes(m)) : [],
        estado: 'creando', created_by: adminId
    };
    let { data: fila, error: insError } = await supabase
        .from('web_projects')
        .insert(insDatos)
        .select()
        .single();
    if (insError && insError.code === '42703') {
        // Columnas accent_color/fuente aún no migradas en la BD: reintentar sin ellas.
        const { accent_color: _a, fuente: _f, ...sinExtra } = insDatos;
        ({ data: fila, error: insError } = await supabase
            .from('web_projects')
            .insert(sinExtra)
            .select()
            .single());
    }
    if (insError) {
        if (insError.code === '23505') throw new Error('El slug "' + slug + '" ya está en uso');
        throw new Error('Supabase: ' + insError.message);
    }
    const id = fila.id;

    // 2) Repo privado en GitHub + commit inicial (rama default)
    let datosRepo = null;
    try {
        const owner = await obtenerOwnerGitHub();
        const archivos = leerArchivosPlantilla(plantillaElegida.slug)
            .map(f => {
                let content = reemplazarTokens(f.content, valores);
                if (f.path === 'index.html') content = inyectarWidgetIndex(content, snippetAgente);
                if (/\.html$/i.test(f.path)) content = inyectarTema(content, accent, fuenteInfo);
                return { ...f, content };
            });

        // docs/CONTEXT.md: contexto del negocio (+ propuesta aprobada) para el editor AI
        const contextoTxt = contexto && String(contexto).trim() ? String(contexto).trim() : '';
        if (contextoTxt) {
            let md = `# CONTEXTO DEL NEGOCIO — ${nombre}\n\n${contextoTxt}\n`;
            if (diseno) {
                md += `\n## Propuesta de diseño aprobada (generada con IA)\n`;
                if (diseno.resumen) md += `\n${diseno.resumen}\n`;
                if (Array.isArray(diseno.secciones) && diseno.secciones.length) {
                    md += `\n### Secciones\n`;
                    diseno.secciones.forEach(s => {
                        if (s && s.titulo) md += `\n#### ${s.titulo}\n${s.contenido || ''}\n`;
                    });
                }
            }
            archivos.push({ path: 'docs/CONTEXT.md', content: md });
        }

        datosRepo = await crearRepoGitHub(owner, slug, (descripcionFinal || plantillaElegida.nombre).slice(0, 350), archivos);
        await actualizarProyecto(id, {
            github_owner: datosRepo.owner,
            github_repo: slug,
            default_branch: datosRepo.branch || 'main',
            github_url: datosRepo.repo.html_url,
            clone_url: datosRepo.repo.clone_url || `https://github.com/${datosRepo.owner}/${slug}.git`,
            estado: 'configurando'
        });
    } catch (err) {
        await actualizarProyecto(id, { estado: 'error', error: err.message });
        throw err;
    }

    // 3) Site en Netlify enlazado al repo + deploy inicial
    try {
        const sitio = await crearSitioNetlify(
            datosRepo.owner,
            slug,
            datosRepo.branch || 'main',
            datosRepo.repo && datosRepo.repo.id
        );
        await actualizarProyecto(id, { netlify_site_id: sitio.site_id, netlify_url: sitio.url, estado: 'deploying' });
        await dispararBuild(sitio.site_id);
    } catch (err) {
        await actualizarProyecto(id, { estado: 'error', error: err.message });
        throw err;
    }

    // 4) Dominio opcional (si falla, no tumba el proyecto: se anota en dominio_error)
    if (dominio) {
        try {
            const { data: row } = await supabase.from('web_projects').select('*').eq('id', id).single();
            const dom = await registrarDominio(row.netlify_site_id, dominio);
            await actualizarProyecto(id, { dominio_estado: dom.dominio_estado, ssl_estado: dom.ssl_estado, dominio_error: null });
        } catch (err) {
            await actualizarProyecto(id, { dominio_error: err.message }).catch(() => {});
        }
    }

    const { data: filaFinal } = await supabase.from('web_projects').select('*').eq('id', id).single();
    if (filaFinal) {
        // Autoriza el/los dominio(s) del sitio en el agente (seguridad por dominio de chat.js)
        if (agenteRow) {
            await garantizarDominiosAgente(agenteRow.id, hostnamesParaSitio(filaFinal.netlify_url, filaFinal.dominio))
                .catch(err => console.error('web-factory: no se pudieron autorizar dominios del agente:', err.message));
        }
        await refrescarYGuardar(filaFinal);
    }
    return { ok: true, id };
}

// ── Helper: verificar acceso a proyecto por usuario ──
// Retorna { ok, rol, isAdmin, isOwner } o { ok: false, error }
async function verificarAccesoProyecto(userId, proyectoId, operacion) {
    // 1. Buscar proyecto
    const { data: proyecto } = await supabase
        .from('web_projects')
        .select('id, created_by')
        .eq('id', proyectoId)
        .maybeSingle();
    if (!proyecto) return { ok: false, error: 'Proyecto no encontrado', statusCode: 404 };

    // 2. Admin global siempre pasa
    const { data: perfil } = await supabase.from('perfiles').select('is_admin').eq('id', userId).single();
    if (perfil?.is_admin) return { ok: true, rol: 'admin', isAdmin: true, isOwner: true };

    // 3. Owner siempre pasa
    if (proyecto.created_by === userId) return { ok: true, rol: 'owner', isAdmin: false, isOwner: true };

    // 4. Buscar permiso específico
    const { data: permiso } = await supabase
        .from('tienda_permisos')
        .select('rol')
        .eq('proyecto_id', proyectoId)
        .eq('user_id', userId)
        .maybeSingle();
    if (!permiso) return { ok: false, error: 'No tienes acceso a este sitio', statusCode: 403 };

    // 5. Verificar rol contra operación requerida
    // Roles de tienda equivalen a roles de sitio (un proyecto puede ser ambos)
    const PERMISOS = {
        // Sitios web (incluye roles de tienda como equivalentes)
        'ver_sitio':          ['admin_sitio', 'editor_sitio', 'visor_sitio', 'admin_tienda', 'editor_tienda', 'visor_tienda'],
        'editar_contenido':   ['admin_sitio', 'editor_sitio', 'admin_tienda', 'editor_tienda'],
        'gestionar_agente':   ['admin_sitio', 'admin_tienda'],
        'eliminar_sitio':     ['admin_sitio'],
        'config_dominio':     ['admin_sitio'],
        'recargar_tokens':    ['admin_sitio', 'editor_sitio', 'admin_tienda', 'editor_tienda'],
        'ver_tokens':         ['admin_sitio', 'editor_sitio', 'visor_sitio', 'admin_tienda', 'editor_tienda', 'visor_tienda'],
        // Tiendas
        'ver_tienda':         ['admin_tienda', 'editor_tienda', 'visor_tienda', 'admin_sitio', 'editor_sitio', 'visor_sitio'],
        'editar_productos':   ['admin_tienda', 'editor_tienda', 'admin_sitio'],
        'gestionar_ordenes':  ['admin_tienda', 'editor_tienda', 'admin_sitio'],
        'config_pasarela':    ['admin_tienda', 'admin_sitio'],
        'gestionar_clientes': ['admin_tienda', 'admin_sitio'],
    };

    if (operacion && PERMISOS[operacion]) {
        if (!PERMISOS[operacion].includes(permiso.rol)) {
            return { ok: false, error: 'Tu rol (' + permiso.rol + ') no permite esta operación', statusCode: 403 };
        }
    }

    return { ok: true, rol: permiso.rol, isAdmin: false, isOwner: false };
}

// ── Handler ──
exports.handler = async (event) => {
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Token no enviado' }) };
        }

        const token = authHeader.replace('Bearer ', '');
        const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: userData, error: userError } = await supabaseUser.auth.getUser();
        if (userError || !userData?.user) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No autenticado' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { action } = body;
        const userId = userData.user.id;

        const { data: miPerfil } = await supabase
            .from('perfiles')
            .select('is_admin')
            .eq('id', userId)
            .single();
        const isAdmin = miPerfil?.is_admin === true;

        // ── LIST_PROYECTOS_PARA_USUARIO: usuario no-admin ve solo sus proyectos asignados ──
        // Acepta tanto 'list_tienda_para_usuario' (legacy) como 'list_proyectos_para_usuario' (nuevo)
        if (action === 'list_tienda_para_usuario' || action === 'list_proyectos_para_usuario') {
            const { data: permisos } = await supabase
                .from('tienda_permisos')
                .select('proyecto_id, rol')
                .eq('user_id', userId);
            if (!permisos || !permisos.length) {
                return { statusCode: 200, body: JSON.stringify({ ok: true, proyectos: [], plantillas: [], esAdmin: false }) };
            }
            const proyectoIds = permisos.map(p => p.proyecto_id);
            const { data: proyectos, error } = await supabase
                .from('web_projects')
                .select('*')
                .in('id', proyectoIds)
                .order('created_at', { ascending: false });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            // Adjuntar rol del usuario a cada proyecto
            const rolMap = {};
            permisos.forEach(p => { rolMap[p.proyecto_id] = p.rol; });
            const proyectosConRol = (proyectos || []).map(p => ({ ...p, mi_rol: rolMap[p.id] || null }));

            let plantillas = [];
            try { plantillas = leerPlantillas(); } catch (_) {}
            return { statusCode: 200, body: JSON.stringify({ ok: true, proyectos: proyectosConRol, plantillas, esAdmin: false }) };
        }

        // ── LIST_AGENTES: retorna los agentes del usuario (para selects de asignación) ──
        if (action === 'list_agentes') {
            const { data: agentes } = await supabase
                .from('agentes_ia')
                .select('id, nombre_agente, tienda_id')
                .eq('user_id', userId)
                .order('id', { ascending: true });
            return { statusCode: 200, body: JSON.stringify({ ok: true, agentes: agentes || [] }) };
        }

        // ── UPDATE_AGENTE: asignar/desasignar agente de IA a una tienda/sitio ──
        // Accesible para admin Y para usuarios con permiso admin_sitio o admin_tienda.
        if (action === 'update_agente') {
            const { proyecto_id, agente_id } = body;
            if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };

            // Validar acceso con permisos
            const acceso = await verificarAccesoProyecto(userId, proyecto_id, 'gestionar_agente');
            if (!acceso.ok) return { statusCode: acceso.statusCode || 403, body: JSON.stringify({ error: acceso.error }) };

            // Leer proyecto actual
            const { data: proyecto } = await supabase
                .from('web_projects')
                .select('id, agente_id, plantilla, created_by')
                .eq('id', proyecto_id)
                .maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const nuevoAgenteId = agente_id ? Number(agente_id) : null;
            const agenteAnteriorId = proyecto.agente_id ? Number(proyecto.agente_id) : null;

            // Si se asigna un agente, validar que existe y pertenece al admin (creador de la tienda)
            let agenteRow = null;
            if (nuevoAgenteId) {
                const { data: ag } = await supabase
                    .from('agentes_ia')
                    .select('id, nombre_agente, dominios_permitidos')
                    .eq('id', nuevoAgenteId)
                    .eq('user_id', userId)
                    .maybeSingle();
                if (!ag) return { statusCode: 404, body: JSON.stringify({ error: 'Agente no encontrado o no pertenece a tu cuenta' }) };
                agenteRow = ag;
            }

            // 1. Actualizar web_projects.agente_id
            const { error: upErr } = await supabase
                .from('web_projects')
                .update({ agente_id: nuevoAgenteId, updated_at: new Date().toISOString() })
                .eq('id', proyecto_id);
            if (upErr) return { statusCode: 500, body: JSON.stringify({ error: upErr.message }) };

            // 2. Sincronizar agentes_ia.tienda_id (bidireccional)
            if (nuevoAgenteId && agenteRow) {
                // Setear tienda_id en el agente nuevo
                await supabase.from('agentes_ia').update({ tienda_id: proyecto_id }).eq('id', nuevoAgenteId);
                // Autorizar dominios del sitio en el agente
                const { data: sitio } = await supabase.from('web_projects').select('netlify_url, dominio').eq('id', proyecto_id).maybeSingle();
                if (sitio) {
                    await garantizarDominiosAgente(nuevoAgenteId, hostnamesParaSitio(sitio.netlify_url, sitio.dominio));
                }
            }

            // Si el agente anterior es diferente al nuevo: limpiar tienda_id del agente anterior
            if (agenteAnteriorId && agenteAnteriorId !== nuevoAgenteId) {
                await supabase.from('agentes_ia').update({ tienda_id: null }).eq('id', agenteAnteriorId);
            }

            // 3. Si se asignó un agente, inyectar widget en el repo si falta y trigger rebuild
            if (nuevoAgenteId) {
                try {
                    const { data: projCompleto } = await supabase
                        .from('web_projects')
                        .select('github_owner, github_repo, default_branch, netlify_site_id, slug')
                        .eq('id', proyecto_id)
                        .maybeSingle();
                    if (projCompleto) {
                        await inyectarWidgetEnRepo({ ...projCompleto, agente_id: nuevoAgenteId });
                    }
                } catch (e) {
                    console.error('web-factory: inyectar widget en repo falló:', e.message);
                }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    agente_id: nuevoAgenteId,
                    agente_nombre: agenteRow?.nombre_agente || null
                })
            };
        }

        // ── Todas las demás acciones requieren admin o permiso específico ──
        // Acciones que un usuario con permiso puede ejecutar sobre SU proyecto
        const accionesPermitidasConPermiso = ['get', 'get_by_slug', 'refresh_status'];
        const proyectoIdParaPermiso = body.proyecto_id || body.id;

        if (!isAdmin && !accionesPermitidasConPermiso.includes(action)) {
            return { statusCode: 403, body: JSON.stringify({ error: 'No eres admin' }) };
        }

        // Para acciones permitidas con permiso, verificar acceso al proyecto específico
        if (!isAdmin && accionesPermitidasConPermiso.includes(action) && proyectoIdParaPermiso) {
            const acceso = await verificarAccesoProyecto(userId, proyectoIdParaPermiso, 'ver_sitio');
            if (!acceso.ok) return { statusCode: acceso.statusCode || 403, body: JSON.stringify({ error: acceso.error }) };
        }

        // ── GENERAR_DISENO: propuesta de diseño asistido por IA (OpenCode Zen free) ──
        // Requiere admin (se controla arriba). Devuelve JSON con propuesta de contenido,
        // paleta y tipografía, SIN modificar nada todavía. El admin aprueba y el create
        // la usa (se pasa via propuesta_ia en el body del create).
        if (action === 'generar_diseno') {
            const { contexto } = body;
            if (!contexto || !String(contexto).trim()) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Falta el contexto del negocio' }) };
            }
            try {
                const propuesta = await generarPropuestaDiseno(body);
                return { statusCode: 200, body: JSON.stringify({ ok: true, propuesta }) };
            } catch (err) {
                return { statusCode: 502, body: JSON.stringify({ error: 'IA no disponible: ' + (err.message || err) }) };
            }
        }

        // ── LIST: proyectos + plantillas ──
        if (!action || action === 'list') {
            const { data: proyectos, error } = await supabase
                .from('web_projects')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

            // Reconciliación: si un sitio tiene agente, garantiza que su dominio
            // esté autorizado (idempotente, repara sitios creados antes de este cambio).
            if (proyectos && Array.isArray(proyectos)) {
                await Promise.all(proyectos
                    .filter(p => p.agente_id)
                    .map(async (p) => {
                        try {
                            await garantizarDominiosAgente(p.agente_id, hostnamesParaSitio(p.netlify_url, p.dominio));
                        } catch (e) {
                            console.error('web-factory: reconciliar dominios falló:', e.message);
                        }
                    }));
            }

            let plantillas = [];
            let plantillas_error = null;
            try { plantillas = leerPlantillas(); } catch (e) { plantillas_error = e.message; }

            return { statusCode: 200, body: JSON.stringify({
                ok: true,
                proyectos: proyectos || [],
                plantillas,
                plantillas_error,
                env: {
                    github: !!process.env.GITHUB_TOKEN,
                    netlify: !!process.env.NETLIFY_AUTH_TOKEN,
                    github_installation: !!process.env.NETLIFY_GITHUB_INSTALLATION_ID,
                    owner: process.env.GITHUB_OWNER || null
                }
            }) };
        }

        // ── GET_BY_SLUG: buscar proyecto por slug ──
        // Lo usa el dashboard tras el create background (que responde 202 vacío)
        // para hacer polling hasta que la fila exista y leer el estado real.
        if (action === 'get_by_slug') {
            const { slug } = body;
            if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'Falta slug' }) };
            const { data: proyecto, error } = await supabase
                .from('web_projects')
                .select('*')
                .eq('slug', String(slug).trim().toLowerCase())
                .maybeSingle();
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true, proyecto: proyecto || null }) };
        }

        // ── GET: proyecto por id (y refresco si está en curso) ──
        if (action === 'get') {
            const { id } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            let { data: proyecto, error } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (error) return { statusCode: 404, body: JSON.stringify({ error: error.message }) };
            if (['creando', 'configurando', 'deploying', 'suspending'].includes(proyecto.estado)) {
                proyecto = await refrescarYGuardar(proyecto);
            }
            return { statusCode: 200, body: JSON.stringify({ ok: true, proyecto }) };
        }

        // ── REFRESH_STATUS: consultar Netlify y actualizar ──
        if (action === 'refresh_status') {
            const { id } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            const { data: proyecto, error } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (error) return { statusCode: 404, body: JSON.stringify({ error: error.message }) };
            const actualizado = await refrescarYGuardar(proyecto);
            return { statusCode: 200, body: JSON.stringify({ ok: true, proyecto: actualizado }) };
        }

        // ── RESYNC_TEMPLATE: aplicar la plantilla/módulos actuales a un sitio existente ──
        // Los sitios creados antes de añadir un módulo (p. ej. Deportes) mantienen su
        // index.html como snapshot de creación y no reciben los módulos nuevos. Este action
        // re-sincroniza el index.html del repo con la plantilla tienda ACTUAL sin reemplazar
        // el contenido personalizado: inserta solo lo que falta (secciones/CSS/JS de Deportes).
        // Admin-only (controlado por el guard genérico arriba). Reutilizable para cualquier store.
        if (action === 'resync_template') {
            const { id } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };

            const { data: proyecto, error } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (error) return { statusCode: 404, body: JSON.stringify({ error: error.message }) };
            if (!proyecto.github_owner || !proyecto.github_repo) {
                return { statusCode: 400, body: JSON.stringify({ error: 'El proyecto no tiene repo de GitHub asociado' }) };
            }

            try {
                const owner = proyecto.github_owner;
                const repo = proyecto.github_repo;
                const branch = proyecto.default_branch || 'main';
                const base = `https://api.github.com/repos/${owner}/${repo}`;
                const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };

                // Leer index.html actual del repo (base para el merge quirúrgico).
                const fileRes = await fetchGitHub(`${base}/contents/index.html?ref=${branch}`, { headers });
                if (!fileRes || !fileRes.ok) {
                    throw new Error(`No se pudo leer index.html del repo (HTTP ${fileRes ? fileRes.status : 'sin respuesta'})`);
                }
                const fileData = await fileRes.json();
                const htmlActual = Buffer.from(fileData.content, 'base64').toString('utf8');

                const resulado = inyectarDeportesEnHtml(htmlActual);

                if (resulado === htmlActual) {
                    // Ya tiene el módulo; no hay cambios que publicar.
                    return { statusCode: 200, body: JSON.stringify({ ok: true, cambios: null, msg: 'El sitio ya tiene el módulo de Deportes (nada que re-sincronizar)' }) };
                }

                await commitArchivosEnRepo(
                    proyecto,
                    [{ path: 'index.html', content: resulado }],
                    'feat: re-sincronizar plantilla (módulo Deportes)'
                );

                if (proyecto.netlify_site_id) await dispararBuild(proyecto.netlify_site_id);

                return { statusCode: 200, body: JSON.stringify({ ok: true, cambios: 'deportes', msg: 'Plantilla re-sincronizada. La publicación se está reconstruyendo en Netlify.' }) };
            } catch (e) {
                return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Falló la re-sincronización' }) };
            }
        }

        // ── SET_ACTIVO: apagar (suspender) o reactivar un sitio ──
        // Apagar: publica un deploy directo con la pagina de "suspendido" (instantáneo, ~2s).
        // Reactivar: dispara un build desde el repo (el sitio real sigue en GitHub) y devuelve
        // enseguida; el build termina en segundo plano y el dashboard lo ve por polling.
        // Síncrono a propósito: es rápido y el cliente recibe el ok/error real.
        if (action === 'set_activo') {
            const { id, activo } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            if (typeof activo !== 'boolean') return { statusCode: 400, body: JSON.stringify({ error: 'activo debe ser true o false' }) };

            const { data: proyecto, error: getErr } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (getErr) return { statusCode: 404, body: JSON.stringify({ error: getErr.message }) };
            if (!proyecto.netlify_site_id) return { statusCode: 400, body: JSON.stringify({ error: 'El sitio aún no tiene un sitio de Netlify asociado' }) };

            const errMigracion = 'Supabase: la tabla web_projects no tiene la columna "activo". Ejecuta la migración 20260816_web_factory_activo en el SQL Editor de Supabase.';

            if (activo === false) {
                // Apagar: primero marcar en DB, luego publicar la página de suspensión.
                await actualizarProyecto(id, { activo: false, estado: 'suspending', error: null })
                    .catch(e => {
                        if (String(e.message).includes('42703') || String(e.message).includes('"activo"')) throw new Error(errMigracion);
                        throw e;
                    });
                try {
                    await publicarSuspension(proyecto.netlify_site_id, paginaSuspension(proyecto.nombre));
                    await actualizarProyecto(id, { estado: 'inactivo', estado_deploy: 'ready' });
                } catch (err) {
                    await actualizarProyecto(id, { activo: true, estado: 'publicado', error: 'No se pudo apagar: ' + err.message }).catch(() => {});
                    throw err;
                }
                return { statusCode: 200, body: JSON.stringify({ ok: true, activo: false }) };
            }

            // Reactivar: dispara el build desde GitHub y marca como desplegando.
            await actualizarProyecto(id, { activo: true, estado: 'deploying', error: null })
                .catch(e => {
                    if (String(e.message).includes('42703') || String(e.message).includes('"activo"')) throw new Error(errMigracion);
                    throw e;
                });
            await dispararBuild(proyecto.netlify_site_id);
            return { statusCode: 200, body: JSON.stringify({ ok: true, activo: true }) };
        }

        // ── CREATE ──
        // El pipeline completo (GitHub + Netlify + build + dominio) es largo; vive en
        // web-factory-background.js (background function, hasta 15 min). El dashboard
        // recibe 202 al instante y hace polling de refresh_status / get.
        if (action === 'create') {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'El create corre como background function: usa /.netlify/functions/web-factory-background' })
            };
        }

        // ── DELETE: elimina el registro de AUVRO (no borra repo/site en GitHub/Netlify) ──
        if (action === 'delete') {
            const { id } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            const { error } = await supabase.from('web_projects').delete().eq('id', id);
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
            return { statusCode: 200, body: JSON.stringify({ ok: true }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida' }) };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};

module.exports.handler = exports.handler;
module.exports.helpers = Object.freeze({
    templatesDir,
    leerPlantillas,
    leerArchivosPlantilla,
    reemplazarTokens,
    validarSlug,
    validarDominio,
    normalizarWhatsapp,
    sanearTexto,
    sanearUrlLogo,
    crearSnippetAgente,
    inyectarWidgetIndex,
    validarAccent,
    oscurecerHex,
    fuenteElegida,
    inyectarTema,
    inyectarDeportesEnHtml,
    commitArchivosEnRepo,
    hostnameDeUrl,
    hostnamesParaSitio,
    pipelineCrear,
    generarPropuestaDiseno,
    actualizarProyecto,
    dispararBuild,
    paginaSuspension,
    sha1hex,
    publicarSuspension,
    mapearEstadoDominio,
    mapearEstadoDeploy,
    estadoGeneral
});
Object.assign(module.exports, module.exports.helpers);