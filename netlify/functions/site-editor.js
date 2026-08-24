// site-editor.js — Editor AI de contenido para sitios web
// Usa el mismo sistema de tokens que chat.js (perfiles.token_balance)
// y los mismos proveedores de IA (DeepSeek primario, OpenAI respaldo).

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
                signal: AbortSignal.timeout(20000)
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
            signal: AbortSignal.timeout(25000)
        });
        const data = await res.json();
        if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim();
    }

    throw new Error('No hay proveedor de IA disponible');
}

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

            const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html?ref=${branch}`, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (!ghRes.ok) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html del repositorio' }) };

            const fileData = await ghRes.json();
            const html = Buffer.from(fileData.content, 'base64').toString('utf-8');
            const sections = parseSiteSections(html);

            const { data: perfil } = await supabase.from('perfiles').select('token_balance').eq('id', user.id).maybeSingle();

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    sections,
                    sha: fileData.sha,
                    full_html_length: html.length,
                    tokens: perfil?.token_balance || 0,
                    site_url: proyecto.netlify_url,
                    github_owner: owner,
                    github_repo: repo,
                    branch
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

            const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html?ref=${branch}`, {
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
            });
            if (!ghRes.ok) return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo leer index.html' }) };

            const fileData = await ghRes.json();
            const html = Buffer.from(fileData.content, 'base64').toString('utf-8');

            const systemPrompt = `Eres un editor de contenido web experto. Modifica el HTML según la instrucción.
Reglas:
- SOLO modifica contenido visible (texto, imagenes, enlaces, colores inline)
- NO cambies la estructura CSS/JS ni elimines clases/IDs
- Responde SOLO con el HTML modificado completo, sin explicaciones ni markdown
- Si la instruccion es vaga, haz tu mejor interpretacion
- Mantén el idioma original del sitio`;

            const userPrompt = `HTML actual:\n${html}\n\nInstruccion: ${instruction}\n\nHTML modificado:`;

            let newHtml;
            try {
                newHtml = await llamarIA([
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ], instruction.length + html.length);
            } catch (e) {
                return { statusCode: 502, body: JSON.stringify({ error: 'Error del proveedor de IA: ' + e.message }) };
            }

            newHtml = newHtml.replace(/^```html?\s*/i, '').replace(/\s*```$/i, '');

            if (!newHtml || newHtml.length < 100) {
                return { statusCode: 500, body: JSON.stringify({ error: 'La IA no generó un HTML válido' }) };
            }

            const tokensUsed = Math.ceil((instruction.length + newHtml.length) / 4) + 10;
            const tokensRestantes = Math.max(0, tokens - tokensUsed);

            const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/index.html`, {
                method: 'PUT',
                headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: `edit: ${instruction.substring(0, 80)}`, content: Buffer.from(newHtml).toString('base64'), sha: fileData.sha, branch })
            });
            if (!commitRes.ok) {
                const errData = await commitRes.json();
                return { statusCode: 502, body: JSON.stringify({ error: 'Error al guardar en GitHub: ' + (errData.message || commitRes.statusText) }) };
            }

            await supabase.from('perfiles').update({ token_balance: tokensRestantes }).eq('id', user.id);

            await supabase.from('edit_token_log').insert({
                proyecto_id, user_id: user.id, tokens_used: tokensUsed,
                description: instruction.substring(0, 200)
            });

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
                    preview_url: proyecto.netlify_url,
                    message: `Edicion aplicada. ${tokensUsed} tokens consumidos. ${tokensRestantes} restantes.`
                })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'Accion no valida: ' + action }) };

    } catch (err) {
        console.error('site-editor error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Error interno' }) };
    }
};
