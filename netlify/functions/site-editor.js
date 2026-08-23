// site-editor.js — Editor AI de contenido para sitios web
//
// Permite a usuarios con permisos editar el contenido de sus sitios web
// a través de un agente de IA, con sistema de consumo de tokens.
//
// Acciones:
//   get_content    → leer y parsear HTML del sitio en GitHub
//   edit_content   → ejecutar edición AI y commitear cambios
//   check_tokens   → verificar tokens disponibles
//   recharge_tokens → recargar tokens (post-pago)

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');
const wf = require('./web-factory.js').helpers;

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

async function esAdmin(userId) {
    const { data } = await supabase.from('perfiles').select('is_admin').eq('id', userId).single();
    return data?.is_admin === true;
}

async function verificarAcceso(userId, proyectoId,requiereEdicion) {
    // Admin siempre pasa
    if (await esAdmin(userId)) return { ok: true, rol: 'admin', isOwner: true };

    // Owner siempre pasa
    const { data: proyecto } = await supabase
        .from('web_projects')
        .select('id, created_by')
        .eq('id', proyectoId)
        .maybeSingle();
    if (!proyecto) return { ok: false, error: 'Proyecto no encontrado' };
    if (proyecto.created_by === userId) return { ok: true, rol: 'owner', isOwner: true };

    // Buscar permiso
    const { data: permiso } = await supabase
        .from('tienda_permisos')
        .select('rol')
        .eq('proyecto_id', proyectoId)
        .eq('user_id', userId)
        .maybeSingle();
    if (!permiso) return { ok: false, error: 'No tienes acceso a este sitio' };

    // Verificar nivel de acceso
    if (requiereEdicion && !ROLES_EDICION.includes(permiso.rol)) {
        return { ok: false, error: 'Tu rol (' + permiso.rol + ') no permite edición de contenido' };
    }
    if (!ROLES_LECTURA.includes(permiso.rol)) {
        return { ok: false, error: 'Tu rol no permite ver este sitio' };
    }

    return { ok: true, rol: permiso.rol, isOwner: false };
}

// Parsear HTML en secciones editables
function parseSiteSections(html) {
    const sections = [];
    const sectionRegex = /<(section|header|footer|main|article)[^>]*(?:\sid=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = sectionRegex.exec(html)) !== null) {
        const tag = match[1].toLowerCase();
        const id = match[2] || `${tag}-${sections.length}`;
        const content = match[3].trim();
        // Extraer título significativo
        const titleMatch = content.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i);
        const title = titleMatch ? titleMatch[1].trim() : id.replace(/-/g, ' ');
        sections.push({ id, title, tag, html_content: content.substring(0, 500) + (content.length > 500 ? '...' : '') });
    }
    // Si no se encontraron secciones, crear una genérica
    if (!sections.length) {
        sections.push({ id: 'contenido', title: 'Contenido principal', tag: 'div', html_content: html.substring(0, 1000) + (html.length > 1000 ? '...' : '') });
    }
    return sections;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const user = await getUser(event);
        const body = JSON.parse(event.body || '{}');
        const { action, proyecto_id } = body;

        if (!proyecto_id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta proyecto_id' }) };

        // ── CHECK_TOKENS: verificar tokens disponibles ──
        if (action === 'check_tokens') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { data: proyecto } = await supabase
                .from('web_projects')
                .select('edit_tokens, edit_tokens_used')
                .eq('id', proyecto_id)
                .maybeSingle();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    tokens: proyecto?.edit_tokens || 0,
                    tokens_used: proyecto?.edit_tokens_used || 0,
                    puede_editar: (proyecto?.edit_tokens || 0) > 0
                })
            };
        }

        // ── GET_CONTENT: leer y parsear HTML del sitio ──
        if (action === 'get_content') {
            const acceso = await verificarAcceso(user.id, proyecto_id, false);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { data: proyecto } = await supabase
                .from('web_projects')
                .select('github_owner, github_repo, default_branch, slug, netlify_url, edit_tokens, edit_tokens_used')
                .eq('id', proyecto_id)
                .maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
            if (!proyecto.github_owner || !proyecto.github_repo) return { statusCode: 400, body: JSON.stringify({ error: 'El sitio aún no tiene repositorio en GitHub' }) };

            // Leer index.html del repo
            const branch = proyecto.default_branch || 'main';
            const url = `https://api.github.com/repos/${proyecto.github_owner}/${proyecto.github_repo}/contents/index.html?ref=${branch}`;
            const res = await fetch(url, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (!res.ok) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer el archivo del sitio' }) };
            const fileData = await res.json();
            const html = Buffer.from(fileData.content, 'base64').toString('utf-8');
            const sha = fileData.sha;

            const sections = parseSiteSections(html);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    sections,
                    sha,
                    full_html_length: html.length,
                    tokens: proyecto.edit_tokens || 0,
                    tokens_used: proyecto.edit_tokens_used || 0,
                    puede_editar: (proyecto.edit_tokens || 0) > 0,
                    site_url: proyecto.netlify_url
                })
            };
        }

        // ── EDIT_CONTENT: ejecutar edición AI y commitear ──
        if (action === 'edit_content') {
            const acceso = await verificarAcceso(user.id, proyecto_id, true);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { instruction, section_id } = body;
            if (!instruction) return { statusCode: 400, body: JSON.stringify({ error: 'Falta instruction (instrucción de edición)' }) };

            // Verificar tokens
            const { data: proyecto } = await supabase
                .from('web_projects')
                .select('github_owner, github_repo, default_branch, slug, netlify_url, netlify_site_id, edit_tokens, edit_tokens_used')
                .eq('id', proyecto_id)
                .maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };
            if ((proyecto.edit_tokens || 0) <= 0) {
                return { statusCode: 402, body: JSON.stringify({ error: 'Sin tokens disponibles. Recarga tokens para continuar editando.' }) };
            }

            // Leer HTML actual
            const branch = proyecto.default_branch || 'main';
            const ghUrl = `https://api.github.com/repos/${proyecto.github_owner}/${proyecto.github_repo}/contents/index.html?ref=${branch}`;
            const ghRes = await fetch(ghUrl, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (!ghRes.ok) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer el archivo del sitio' }) };
            const fileData = await ghRes.json();
            const html = Buffer.from(fileData.content, 'base64').toString('utf-8');
            const sha = fileData.sha;

            // Llamar a AI para modificar el HTML
            const OpenAI = require('openai');
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const sections = parseSiteSections(html);
            const sectionContext = section_id ? sections.find(s => s.id === section_id) : null;

            const systemPrompt = `Eres un editor de contenido web. Modifica el HTML proporcionado según la instrucción del usuario.
Reglas:
- SOLO modifica el contenido visible (texto, imágenes, enlaces), NO cambies la estructura CSS/JS
- Mantén todas las clases CSS y IDs existentes
- Responde SOLO con el HTML modificado completo, sin explicaciones ni markdown
- Si la instrucción no es clara, haz tu mejor interpretación`;

            const userPrompt = `HTML actual del sitio:
${html}

${sectionContext ? `Sección a modificar: ${sectionContext.id} (${sectionContext.title})` : 'Modificar en todo el sitio'}

Instrucción: ${instruction}

HTML modificado:`;

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 4000,
                temperature: 0.3
            });

            let newHtml = completion.choices[0]?.message?.content?.trim();
            if (!newHtml) return { statusCode: 500, body: JSON.stringify({ error: 'La IA no generó respuesta' }) };

            // Limpiar posibles marcadores markdown
            newHtml = newHtml.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '');

            // Calcular tokens consumidos
            const tokensUsed = Math.ceil((instruction.length + newHtml.length) / 4) + 10;
            const tokensRestantes = Math.max(0, (proyecto.edit_tokens || 0) - tokensUsed);

            // Commit a GitHub
            const commitMessage = `edit: ${instruction.substring(0, 80)}`;
            const commitUrl = `https://api.github.com/repos/${proyecto.github_owner}/${proyecto.github_repo}/contents/index.html`;
            const commitRes = await fetch(commitUrl, {
                method: 'PUT',
                headers: {
                    Authorization: `token ${GITHUB_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: commitMessage,
                    content: Buffer.from(newHtml).toString('base64'),
                    sha: sha,
                    branch: branch
                })
            });
            if (!commitRes.ok) {
                const errData = await commitRes.json();
                return { statusCode: 502, body: JSON.stringify({ error: 'Error al guardar en GitHub: ' + (errData.message || commitRes.statusText) }) };
            }

            // Actualizar tokens en DB
            await supabase.from('web_projects').update({
                edit_tokens: tokensRestantes,
                edit_tokens_used: (proyecto.edit_tokens_used || 0) + tokensUsed,
                updated_at: new Date().toISOString()
            }).eq('id', proyecto_id);

            // Log de consumo
            await supabase.from('edit_token_log').insert({
                proyecto_id,
                tokens_used: tokensUsed,
                description: instruction.substring(0, 200)
            });

            // Trigger deploy en Netlify
            if (proyecto.netlify_site_id) {
                try {
                    await wf.dispararBuild(proyecto.netlify_site_id);
                } catch (e) {
                    console.error('site-editor: trigger deploy falló:', e.message);
                }
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    tokens_used: tokensUsed,
                    tokens_remaining: tokensRestantes,
                    preview_url: proyecto.netlify_url,
                    message: `Edición aplicada. ${tokensUsed} tokens consumidos. ${tokensRestantes} tokens restantes.`
                })
            };
        }

        // ── RECHARGE_TOKENS: recargar tokens (post-pago) ──
        if (action === 'recharge_tokens') {
            const acceso = await verificarAcceso(user.id, proyecto_id, true);
            if (!acceso.ok) return { statusCode: 403, body: JSON.stringify({ error: acceso.error }) };

            const { tokens_to_add, order_id } = body;
            if (!tokens_to_add || tokens_to_add <= 0) return { statusCode: 400, body: JSON.stringify({ error: 'Falta tokens_to_add' }) };

            const { data: proyecto } = await supabase
                .from('web_projects')
                .select('edit_tokens, edit_tokens_used')
                .eq('id', proyecto_id)
                .maybeSingle();
            if (!proyecto) return { statusCode: 404, body: JSON.stringify({ error: 'Proyecto no encontrado' }) };

            const newTokens = (proyecto.edit_tokens || 0) + tokens_to_add;
            await supabase.from('web_projects').update({
                edit_tokens: newTokens,
                updated_at: new Date().toISOString()
            }).eq('id', proyecto_id);

            // Log
            await supabase.from('edit_token_log').insert({
                proyecto_id,
                tokens_used: -tokens_to_add,
                description: order_id ? `Recarga orden #${order_id}` : 'Recarga manual'
            });

            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true, tokens: newTokens, tokens_added: tokens_to_add })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Acción no válida: ' + action }) };

    } catch (err) {
        console.error('site-editor error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};
