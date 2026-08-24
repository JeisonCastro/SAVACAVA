// site-editor.js — Editor AI de contenido para sitios web
// Lee /docs del repositorio para contexto del proyecto.
// Soporta edición de index.html y styles.css.
// Usa perfiles.token_balance (mismo sistema que chat.js).

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

const ROLES_EDICION = ['admin_sitio', 'editor_sitio'];
const ROLES_LECTURA = ['admin_sitio', 'editor_sitio', 'visor_sitio'];

const GH_HEADERS = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' };

async function getUser(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) throw new Error('No autenticado');
    return userData.user;
}

async function verificarAcceso(userId, proyectoId, requiereEdicion) {
    const { data: perfil } = await supabase.from('perfiles').select('is_admin').eq('id', userId).maybeSingle();
    if (perfil?.is_admin) return { ok: true, rol: 'admin', isOwner: true };

    const { data: proyecto } = await supabase
        .from('web_projects').select('id, created_by').eq('id', proyectoId).maybeSingle();
    if (!proyecto) return { ok: false, error: 'Proyecto no encontrado' };
    if (proyecto.created_by === userId) return { ok: true, rol: 'owner', isOwner: true };

    const { data: permiso } = await supabase
        .from('tienda_permisos').select('rol')
        .eq('proyecto_id', proyectoId).eq('user_id', userId).maybeSingle();
    if (!permiso) return { ok: false, error: 'No tienes acceso a este sitio' };

    if (requiereEdicion && !ROLES_EDICION.includes(permiso.rol))
        return { ok: false, error: 'Tu rol (' + permiso.rol + ') no permite edición' };
    if (!ROLES_LECTURA.includes(permiso.rol))
        return { ok: false, error: 'Tu rol no permite ver este sitio' };

    return { ok: true, rol: permiso.rol, isOwner: false };
}

async function llamarIA(mensajes, inputChars) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const fallbackKey = process.env.FALLBACK_API_KEY || process.env.OPENIA_KEY;

    if (deepseekKey) {
        try {
            const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-v4-flash', messages: mensajes, temperature: 0.2, max_tokens: 4000, thinking: { type: 'disabled' } }),
                signal: AbortSignal.timeout(30000)
            });
            const data = await res.json();
            if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
        } catch (e) { console.warn('DeepSeek falló:', e.message); }
    }

    if (fallbackKey) {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${fallbackKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: mensajes, temperature: 0.3, max_tokens: 4000 }),
            signal: AbortSignal.timeout(35000)
        });
        const data = await res.json();
        if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    }

    throw new Error('No hay proveedor de IA disponible');
}

// ── GitHub helpers ──

async function ghReadFile(owner, repo, branch, path) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: GH_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

async function ghListDir(owner, repo, branch, path) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: GH_HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(f => f.type === 'file');
}

// ── Docs reading ──

async function leerDocsProyecto(owner, repo, branch) {
    const files = await ghListDir(owner, repo, branch, 'docs');
    const mdFiles = files.filter(f => f.name.endsWith('.md'));
    if (!mdFiles.length) return { archivos: [], contenido: '' };

    const partes = [];
    const nombres = [];
    for (const f of mdFiles) {
        const file = await ghReadFile(owner, repo, branch, `docs/${f.name}`);
        if (file) {
            nombres.push(f.name);
            partes.push(`--- ${f.name} ---\n${file.content}`);
        }
    }
    return { archivos: nombres, contenido: partes.join('\n\n') };
}

// ── Site parsing ──

function parseSiteSections(html) {
    const sections = [];
    const regex = /<(section|header|footer|main|article)[^>]*(?:\sid=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = regex.exec(html)) !== null) {
        const tag = m[1].toLowerCase();
        const id = m[2] || `${tag}-${sections.length}`;
        const content = m[3].trim();
        const titleMatch = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i);
        const title = titleMatch ? titleMatch[1].trim() : id.replace(/-/g, ' ');
        sections.push({ id, title, tag, preview: content.substring(0, 300) + (content.length > 300 ? '...' : '') });
    }
    if (!sections.length) {
        sections.push({ id: 'contenido', title: 'Contenido principal', tag: 'div', preview: html.substring(0, 600) + (html.length > 600 ? '...' : '') });
    }
    return sections;
}

function validarHTML(html) {
    if (!html || html.length < 100) return false;
    const lower = html.toLowerCase();
    return lower.includes('<head') && lower.includes('<body') && lower.includes('</html>');
}

function separarArchivos(raw) {
    const htmlMatch = raw.match(/<!--HTML_START-->([\s\S]*?)<!--HTML_END-->/i);
    const cssMatch = raw.match(/<!--CSS_START-->([\s\S]*?)<!--CSS_END-->/i);

    if (htmlMatch) {
        return {
            html: htmlMatch[1].trim(),
            css: cssMatch ? cssMatch[1].trim() : null
        };
    }

    return { html: raw, css: null };
}

// ── Handler ──

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const user = await getUser(event);
        const body = JSON.parse(event.body || '{}');
        const { action, proyecto_id } = body;

        if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };

        // ── CHECK_TOKENS ──
        if (action === 'check_tokens') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const tokens = perfil?.token_balance || 0;

            return { statusCode: 200, body: JSON.stringify({ ok: true, tokens, puede_editar: tokens > 0 }) };
        }

        // ── GET_CONTENT ──
        if (action === 'get_content') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            const indexFile = await ghReadFile(owner, repo, branch, 'index.html');
            if (!indexFile) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html del repositorio' }) };

            const sections = parseSiteSections(indexFile.content);
            const docs = await leerDocsProyecto(owner, repo, branch);
            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    sections,
                    sha: indexFile.sha,
                    full_html_length: indexFile.content.length,
                    tokens: perfil?.token_balance || 0,
                    site_url: proyecto.netlify_url,
                    github_owner: owner,
                    github_repo: repo,
                    branch,
                    docs_archivos: docs.archivos,
                    docs_contenido: docs.contenido
                })
            };
        }

        // ── EDIT_CONTENT ──
        if (action === 'edit_content') {
            const acceso = await verificarAcceso(user.id, proyecto_id, true);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { instruction } = body;
            if (!instruction) return { statusCode: 400, body: JSON.stringify({ error: 'Falta instruction' }) };

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();
            const tokens = perfil?.token_balance || 0;
            if (tokens <= 0) return { statusCode: 402, body: JSON.stringify({ error: 'Sin tokens disponibles. Recarga tokens para continuar editando.' }) };

            const { data: proyecto } = await supabase.from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const owner = proyecto.github_owner || 'JeisonCastro';
            const repo = proyecto.github_repo || proyecto.slug;
            const branch = proyecto.default_branch || 'main';

            // Leer index.html
            const indexFile = await ghReadFile(owner, repo, branch, 'index.html');
            if (!indexFile) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html' }) };

            // Leer styles.css (opcional)
            const cssFile = await ghReadFile(owner, repo, branch, 'styles.css');

            // Leer docs/ para contexto del proyecto
            const docs = await leerDocsProyecto(owner, repo, branch);

            // ── Construir system prompt con contexto ──
            const docsSection = docs.contenido
                ? `\n\nDOCUMENTACIÓN DEL PROYECTO:\n${docs.contenido}\n`
                : '\n\nNo hay documentación disponible en /docs para este proyecto.\n';

            const systemPrompt = `Eres un editor de contenido web especializado en el sitio del cliente.

IDENTIDAD DEL PROYECTO:
- Nombre: ${proyecto.nombre || 'Sitio web'}
- Slug: ${proyecto.slug || 'sitio'}
- URL: ${proyecto.netlify_url || 'N/A'}
${docsSection}
REGLAS PRINCIPALES (en orden de prioridad):
1. CAMBIOS MÍNIMOS: Modifica ÚNICAMENTE lo necesario para cumplir la instrucción exacta del usuario. NO cambies layout, estructura, CSS no relacionado, JS, ni funcionalidades que no estén directamente implicadas en el cambio.
2. PRESERVAR IDENTIDAD: Respeta colores, tipografía, branding, estilo y tono existente definidos en la documentación del proyecto.
3. NO INVENTAR CONTENIDO: Si la instrucción pide información que no existe en /docs ni en el código actual (ej: "agrega información de servicios"), solicita al usuario que proporcione esa información.
4. MANTENER INTACTO: No elimines formularios, WhatsApp, navegación, menús, footer, integraciones, PWA, responsive, dark mode, analytics, ni ninguna funcionalidad existente.
5. RESPETAR ESTRUCTURA: No reorganices secciones, no muevas componentes, no cambies el orden del contenido a menos que se pida explícitamente.
6. CLARIDAD: Si la instrucción es ambigua y un cambio radical podría romper el sitio, responde explicando qué podrías hacer y pide confirmación.

ARCHIVOS DEL PROYECTO:
- index.html (contenido principal)
- styles.css (estilos)
Si el cambio es solo de contenido (textos, imágenes, colores inline, enlaces), modifica solo index.html.
Si el cambio requiere modificar estilos CSS (colores de fondo, tamaños, espaciado, etc.), indica el cambio en CSS también.

FORMATO DE RESPUESTA:
Primero escribe una línea breve explicando qué vas a cambiar.
Luego el HTML modificado entre las marcas:
<!--HTML_START-->
html modificado completo
<!--HTML_END-->
Si necesitas cambiar CSS, inclúyelo también:
<!--CSS_START-->
css modificado completo
<!--CSS_END-->
Responde SOLO con eso. Sin explicaciones adicionales. Sin markdown.`;

            const userPrompt = `INSTRUCCIÓN DEL USUARIO:\n${instruction}\n\nHTML ACTUAL:\n${indexFile.content}` + (cssFile ? `\n\nCSS ACTUAL:\n${cssFile.content}` : '');

            let rawResponse;
            try {
                rawResponse = await llamarIA([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ], instruction.length + indexFile.content.length + (cssFile ? cssFile.content.length : 0));
            } catch (e) {
                return { statusCode: 502, body: JSON.stringify({ error: 'Error del proveedor de IA: ' + e.message }) };
            }

            // Limpiar markdown code blocks si la IA los incluye
            rawResponse = rawResponse.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '');

            const { html: newHtml, css: newCss } = separarArchivos(rawResponse);

            // Validar HTML
            if (!validarHTML(newHtml)) {
                return { statusCode: 500, body: JSON.stringify({ error: 'La IA no generó un HTML válido. Intenta con una instrucción más clara.' }) };
            }

            // ── Commit cambios ──
            const commits = [];

            // Commit index.html
            const commitIndex = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html`, {
                method: 'PUT',
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `edit: ${instruction.substring(0, 80)}`, content: Buffer.from(newHtml).toString('base64'), sha: indexFile.sha, branch })
            });
            if (!commitIndex.ok) {
                const errData = await commitIndex.json();
                return { statusCode: 502, body: JSON.stringify({ error: 'Error al guardar index.html en GitHub: ' + (errData.message || commitIndex.statusText) }) };
            }
            commits.push('index.html');

            // Commit styles.css si cambió
            if (newCss && cssFile) {
                const commitCss = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/styles.css`, {
                    method: 'PUT',
                    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: `edit: ${instruction.substring(0, 80)} (css)`, content: Buffer.from(newCss).toString('base64'), sha: cssFile.sha, branch })
                });
                if (commitCss.ok) commits.push('styles.css');
            }

            // ── Deduct tokens ──
            const tokensUsed = Math.ceil((instruction.length + newHtml.length + (newCss ? newCss.length : 0)) / 4) + 10;
            const tokensRestantes = Math.max(0, tokens - tokensUsed);

            await supabase.from('perfiles').update({ token_balance: tokensRestantes }).eq('id', user.id);
            await supabase.from('edit_token_log').insert({
                proyecto_id, user_id: user.id, tokens_used: tokensUsed,
                description: instruction.substring(0, 200)
            });

            // ── Trigger Netlify deploy ──
            if (proyecto.netlify_site_id) {
                try {
                    await fetch(`https://api.netlify.com/api/v1/sites/${proyecto.netlify_site_id}/builds`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN || ''}` }
                    });
                } catch (e) { console.error('site-editor: deploy trigger falló:', e.message); }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true, tokens_used: tokensUsed, tokens_remaining: tokensRestantes,
                    preview_url: proyecto.netlify_url, commits,
                    message: `Edición aplicada en ${commits.join(' + ')}. ${tokensUsed} tokens consumidos. ${tokensRestantes} restantes.`
                })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida: ' + action }) };

    } catch (err) {
        console.error('site-editor error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};
