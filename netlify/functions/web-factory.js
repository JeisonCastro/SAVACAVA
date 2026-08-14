// web-factory.js — Web Factory: generar sitios web para clientes
// Flujo: AUVRO Admin -> crear proyecto -> Supabase -> GitHub (repo privado + commit) ->
//        Netlify (site enlazado al repo) -> dominio -> deploy -> estado.
//
// Validación de admin: mismo patrón que admin-data.js (token del usuario + perfiles.is_admin).
// Los secretos (GITHUB_TOKEN, NETLIFY_AUTH_TOKEN) se leen SOLO de variables de entorno.
//
// El action `create` está pensado para ejecutarse como background function de Netlify
// (el cliente envía el header "X-NF-Background: true"): responde 202 al instante y la
// función termina el pipeline en segundo plano (hasta 15 min). El dashboard hace polling
// de `refresh_status` / `get` hasta ver el estado final.

const fs = require('fs');
const path = require('path');
const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// ── Plantillas (archivos reales en web-factory/templates, incluidas en el bundle) ──
function templatesDir() {
    const candidates = [
        path.resolve(process.cwd(), 'web-factory', 'templates'),
        path.resolve(__dirname, '..', '..', 'web-factory', 'templates'),
        path.resolve(__dirname, 'web-factory', 'templates')
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'manifest.json'))) return c;
    }
    throw new Error(
        'No se encontraron las plantillas (web-factory/templates). Verifica included_files en netlify.toml. Rutas probadas: ' +
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

async function crearSitioNetlify(owner, slug, branch = 'main') {
    const repoBody = { provider: 'github', repo: `${owner}/${slug}`, branch, private: true, cmd: '', dir: '' };
    const intento = async (conNombre) => {
        return await fetch('https://api.netlify.com/api/v1/sites', {
            method: 'POST',
            headers: netlifyHeaders(),
            body: JSON.stringify(conNombre ? { name: slug, repo: repoBody } : { repo: repoBody })
        });
    };

    let res = await intento(true);
    if (res.status === 422) {
        // el subdominio slug.netlify.app ya está tomado: Netlify genera uno aleatorio
        res = await intento(false);
    }
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
    for (let i = 1; i <= reintentos; i++) {
        const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/domains`, {
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
    if (error) throw new Error('Supabase: ' + error.message);
    return data;
}

async function refrescarYGuardar(proyecto) {
    try {
        const estado = await consultarEstadoNetlify(proyecto);
        const nuevo = {
            ...proyecto,
            ...estado,
            estado: estadoGeneral(estado.estado_deploy, proyecto.dominio, estado.dominio_estado),
            error: estado.estado_deploy === 'error' ? (estado.deploy_error || 'El deploy fallo en Netlify') : null
        };
        return await actualizarProyecto(proyecto.id, nuevo);
    } catch (err) {
        return actualizarProyecto(proyecto.id, { error: err.message }).catch(() => proyecto);
    }
}

// ── Pipeline de creación (background) ──
async function pipelineCrear(body, adminId) {
    const { cliente, nombre, slug, plantilla, dominio, descripcion } = body;

    const plantillas = leerPlantillas();
    const plantillaElegida = plantillas.find(p => p.slug === plantilla) || plantillas[0];
    if (!plantillaElegida) throw new Error('No hay plantillas disponibles');

    const valores = { EMPRESA: nombre, DESCRIPCION: descripcion || nombre };

    // 1) Registrar en Supabase (estado: creando)
    const { data: fila, error: insError } = await supabase
        .from('web_projects')
        .insert({
            cliente, nombre, slug, plantilla: plantillaElegida.slug,
            descripcion: descripcion || null, dominio: dominio || null,
            estado: 'creando', created_by: adminId
        })
        .select()
        .single();
    if (insError) {
        if (insError.code === '23505') throw new Error('El slug "' + slug + '" ya está en uso');
        throw new Error('Supabase: ' + insError.message);
    }
    const id = fila.id;

    // 2) Repo privado en GitHub + commit inicial (rama main)
    try {
        const owner = await obtenerOwnerGitHub();
        const archivos = leerArchivosPlantilla(plantillaElegida.slug)
            .map(f => ({ ...f, content: reemplazarTokens(f.content, valores) }));
        const { repo, owner: ownerReal, branch } = await crearRepoGitHub(owner, slug, descripcion || plantillaElegida.nombre, archivos);
        await actualizarProyecto(id, {
            github_owner: ownerReal,
            github_repo: slug,
            default_branch: branch || 'main',
            github_url: repo.html_url,
            clone_url: repo.clone_url || `https://github.com/${ownerReal}/${slug}.git`,
            estado: 'configurando'
        });
    } catch (err) {
        await actualizarProyecto(id, { estado: 'error', error: err.message });
        throw err;
    }

    // 3) Site en Netlify enlazado al repo + deploy inicial
    try {
        const { data: row } = await supabase.from('web_projects').select('*').eq('id', id).single();
        const sitio = await crearSitioNetlify(row.github_owner, slug, row.default_branch || 'main');
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
    if (filaFinal) await refrescarYGuardar(filaFinal);
    return { ok: true, id };
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

        const { data: miPerfil } = await supabase
            .from('perfiles')
            .select('is_admin')
            .eq('id', userData.user.id)
            .single();
        if (!miPerfil?.is_admin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'No eres admin' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { action } = body;
        const adminId = userData.user.id;

        // ── LIST: proyectos + plantillas ──
        if (!action || action === 'list') {
            const { data: proyectos, error } = await supabase
                .from('web_projects')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };

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
                    owner: process.env.GITHUB_OWNER || null
                }
            }) };
        }

        // ── GET: proyecto por id (y refresco si está en curso) ──
        if (action === 'get') {
            const { id } = body;
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'Falta id' }) };
            let { data: proyecto, error } = await supabase.from('web_projects').select('*').eq('id', id).single();
            if (error) return { statusCode: 404, body: JSON.stringify({ error: error.message }) };
            if (['creando', 'configurando', 'deploying'].includes(proyecto.estado)) {
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

        // ── CREATE: pipeline completo (background) ──
        if (action === 'create') {
            const { cliente, nombre, slug, plantilla, dominio, descripcion } = body;
            if (!cliente || !String(cliente).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Falta el cliente' }) };
            if (!nombre || !String(nombre).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'Falta el nombre' }) };
            if (!validarSlug(slug)) return { statusCode: 400, body: JSON.stringify({ error: 'Slug inválido (solo minusculas, numeros y guiones)' }) };
            if (!validarDominio(dominio)) return { statusCode: 400, body: JSON.stringify({ error: 'Dominio inválido' }) };
            if (!process.env.GITHUB_TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'Falta GITHUB_TOKEN en las variables de entorno' }) };
            if (!process.env.NETLIFY_AUTH_TOKEN) return { statusCode: 500, body: JSON.stringify({ error: 'Falta NETLIFY_AUTH_TOKEN en las variables de entorno' }) };

            const resultado = await pipelineCrear(body, adminId);
            return { statusCode: 200, body: JSON.stringify(resultado) };
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
module.exports.helpers = {
    templatesDir,
    leerPlantillas,
    leerArchivosPlantilla,
    reemplazarTokens,
    validarSlug,
    validarDominio,
    mapearEstadoDominio,
    mapearEstadoDeploy,
    estadoGeneral
};
