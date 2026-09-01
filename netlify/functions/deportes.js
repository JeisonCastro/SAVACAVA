// deportes.js — Módulos deportivos GENÉRICOS de AUVRO (nicho deportivo)
//
// Particionado por `proyecto_id` (cualquier cliente del nicho). FORMIES es el
// primer tenant. Sigue el patrón de tienda.js: auth Bearer + perfiles.is_admin
// o tienda_permisos sobre el proyecto; service role para leer/escribir.
//
// Acciones de admin (Bearer + admin + permiso de proyecto):
//   Deportistas : listar_deportistas, buscar_deportistas, get_deportista,
//                 guardar_deportista, eliminar_deportista
//   Club        : listar_planes, guardar_plan, eliminar_plan,
//                 listar_horarios, guardar_horario, eliminar_horario
//   Visorías    : listar_visorias, guardar_visoria, eliminar_visoria
//   Inscripc.   : listar_inscripciones, guardar_inscripcion,
//                 cambiar_estado_inscripcion, evaluar_inscripcion, eliminar_inscripcion
//   Torneos     : listar_torneos, guardar_torneo, eliminar_torneo
//   Noticias    : listar_noticias, guardar_noticia, eliminar_noticia
//   Galería     : listar_galeria, guardar_item_galeria, eliminar_item_galeria
//   Consentim.  : listar_consentimientos, guardar_consentimiento, eliminar_consentimiento
//
// Acciones públicas (CORS abierto, sin auth — para el sitio del cliente):
//   catalogo_publico   -> deportistas públicos + planes + horarios + visorías +
//                          torneos + noticias + galería (todo activo) de un slug/proyecto.
//   inscribir_publico  -> crea inscripción (club/visoría) con consentimientos.

const { supabase } = require('./supabase-admin');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json"
};

function ok(body, status = 200) {
    return { statusCode: status, headers, body: JSON.stringify(body) };
}

function pagerror(msg, status = 400) {
    return ok({ ok: false, error: msg }, status);
}

function s(v) { return String(v ?? '').trim(); }

// ── Auth de admin (patrón tienda.js) ──
async function autenticarAdmin(event, proyectoId) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) throw new Error('Token no enviado');
    const token = authHeader.replace('Bearer ', '');
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !userData?.user) throw new Error('No autenticado');
    const userId = userData.user.id;
    const { data: miPerfil } = await supabase
        .from('perfiles')
        .select('is_admin')
        .eq('id', userId)
        .single();
    if (miPerfil?.is_admin) return userId;
    const ROLES = ['admin_tienda', 'editor_tienda', 'admin_sitio', 'editor_sitio'];
    if (proyectoId) {
        const { data: permiso } = await supabase
            .from('tienda_permisos')
            .select('rol')
            .eq('proyecto_id', proyectoId)
            .eq('user_id', userId)
            .maybeSingle();
        if (permiso && ROLES.includes(permiso.rol)) return userId;
    }
    throw new Error('No tienes permiso para administrar este proyecto');
}

// ── Resolver proyecto por id o slug ──
async function resolverProyecto(proyectoId, slug) {
    if (proyectoId) {
        const { data } = await supabase.from('web_projects').select('id').eq('id', proyectoId).maybeSingle();
        return data || null;
    }
    if (slug) {
        const { data } = await supabase.from('web_projects').select('id').eq('slug', slug).maybeSingle();
        return data || null;
    }
    return null;
}

// ── Helpers de body ──
function parseIds(body) {
    return {
        proyectos: Array.isArray(body.proyectos) ? body.proyectos.filter(Boolean).map(String) : null,
        ids: Array.isArray(body.ids) ? body.ids.filter(Boolean).map(String) : null
    };
}

// ============================================================
//  ACCIONES PÚBLICAS (sitio del cliente)
// ============================================================
async function accionCatalogoPublico(params) {
    const { slug, proyecto_id } = params;
    const proyecto = await resolverProyecto(proyecto_id, slug);
    if (!proyecto) return pagerror('Proyecto no encontrado', 404);
    const pid = proyecto.id;

    const [deportistas, planes, horarios, visorias, torneos, noticias, galeria] = await Promise.all([
        supabase.from('deportes_deportistas').select('id,nombre,fotografia_url,edad,categoria,posicion,pierna,altura_cm,club,pais,ciudad,nivel,perfil,logros,estadisticas,videos,ficha,publico')
            .eq('proyecto_id', pid).eq('publico', true).eq('activo', true).order('nombre'),
        supabase.from('deportes_club_planes').select('*').eq('proyecto_id', pid).eq('activo', true).order('precio_cents'),
        supabase.from('deportes_club_horarios').select('*').eq('proyecto_id', pid).eq('activo', true).order('dia'),
        supabase.from('deportes_visorias').select('*').eq('proyecto_id', pid).eq('activo', true).order('fecha'),
        supabase.from('deportes_torneos').select('*').eq('proyecto_id', pid).eq('activo', true).order('fecha_inicio'),
        supabase.from('deportes_noticias').select('*').eq('proyecto_id', pid).eq('activo', true).order('fecha_publicacion', { ascending: false }).limit(50),
        supabase.from('deportes_galeria').select('*').eq('proyecto_id', pid).eq('activo', true).order('orden')
    ]);

    return ok({
        ok: true,
        proyecto_id: pid,
        deportistas: deportistas.data || [],
        planes: planes.data || [],
        horarios: horarios.data || [],
        visorias: visorias.data || [],
        torneos: torneos.data || [],
        noticias: noticias.data || [],
        galeria: galeria.data || []
    });
}

async function accionInscribirPublico(body) {
    const { slug, proyecto_id, tipo, plan_id, visoria_id, deportista_nombre, fecha_nacimiento, deporte, horario, responsable_nombre, responsable_email, responsable_telefono, datos, consentimiento, consentimiento_uso_imagen, consentimiento_tratamiento } = body;
    if (!['club', 'visoria', 'torneo', 'gira'].includes(tipo)) return pagerror('Tipo de inscripción inválido');
    if (!responsable_nombre) return pagerror('Falta el nombre del responsable');
    if (!consentimiento) return pagerror('Debes aceptar el consentimiento de tratamiento de datos');

    const proyecto = await resolverProyecto(proyecto_id, slug);
    if (!proyecto) return pagerror('Proyecto no encontrado', 404);
    const pid = proyecto.id;

    const { data, error } = await supabase.from('deportes_inscripciones').insert({
        proyecto_id: pid,
        tipo,
        plan_id: plan_id || null,
        visoria_id: visoria_id || null,
        deportista_nombre: s(deportista_nombre),
        fecha_nacimiento: fecha_nacimiento || null,
        deporte: s(deporte),
        horario: s(horario),
        responsable_nombre: s(responsable_nombre),
        responsable_email: s(responsable_email),
        responsable_telefono: s(responsable_telefono),
        datos: datos && typeof datos === 'object' ? datos : {},
        consentimiento: !!consentimiento,
        consentimiento_uso_imagen: !!consentimiento_uso_imagen,
        consentimiento_tratamiento: !!consentimiento_tratamiento,
        estado: 'solicitada'
    }).select().single();
    if (error) return pagerror('Error al inscribir: ' + error.message, 500);

    await supabase.from('deportes_consentimientos').insert({
        proyecto_id: pid,
        sujeto_nombre: s(deportista_nombre) || s(responsable_nombre),
        sujeto_tipo: 'deportista',
        responsable: s(responsable_nombre),
        uso_imagen: !!consentimiento_uso_imagen,
        tratamiento_datos: !!consentimiento_tratamiento,
        estado: 'aceptado',
        notas: 'Consentimiento capturado en inscripción pública (' + tipo + ')'
    }).then(() => {}).catch(() => {});

    return ok({ ok: true, inscripcion_id: data.id, estado: 'solicitada' });
}

// ============================================================
//  ADMIN: DEPORTISTAS
// ============================================================
async function listarDeportistas(userId, body) {
    const { proyecto_id } = body;
    const { data, error } = await supabase
        .from('deportes_deportistas')
        .select('*')
        .eq('proyecto_id', proyecto_id)
        .order('nombre');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, deportistas: data || [] });
}

async function buscarDeportistas(userId, body) {
    const { proyecto_id, q, edad_min, edad_max, categoria, posicion, pais, ciudad, nivel } = body;
    let query = supabase
        .from('deportes_deportistas')
        .select('*')
        .eq('proyecto_id', proyecto_id);
    if (q) query = query.ilike('nombre', '%' + String(q).replace(/%/g, '') + '%');
    if (edad_min != null && edad_min !== '') query = query.gte('edad', Number(edad_min));
    if (edad_max != null && edad_max !== '') query = query.lte('edad', Number(edad_max));
    if (categoria) query = query.eq('categoria', categoria);
    if (posicion) query = query.eq('posicion', posicion);
    if (pais) query = query.eq('pais', pais);
    if (ciudad) query = query.eq('ciudad', ciudad);
    if (nivel) query = query.eq('nivel', nivel);
    query = query.order('nombre');
    const { data, error } = await query;
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, deportistas: data || [] });
}

async function getDeportista(userId, body) {
    const { id } = body;
    const { data, error } = await supabase.from('deportes_deportistas').select('*').eq('id', id).maybeSingle();
    if (error) return pagerror(error.message, 500);
    if (!data) return pagerror('Deportista no encontrado', 404);
    return ok({ ok: true, deportista: data });
}

function sanearDeportista(body) {
    return {
        proyecto_id: body.proyecto_id,
        nombre: s(body.nombre),
        fotografia_url: s(body.fotografia_url),
        fecha_nacimiento: body.fecha_nacimiento || null,
        edad: body.edad != null && body.edad !== '' ? Number(body.edad) : null,
        categoria: s(body.categoria),
        posicion: s(body.posicion),
        pierna: s(body.pierna) || 'Derecha',
        altura_cm: body.altura_cm != null && body.altura_cm !== '' ? Number(body.altura_cm) : null,
        peso_kg: body.peso_kg != null && body.peso_kg !== '' ? Number(body.peso_kg) : null,
        club: s(body.club),
        pais: s(body.pais),
        ciudad: s(body.ciudad),
        nivel: s(body.nivel),
        experiencia: s(body.experiencia),
        perfil: s(body.perfil),
        logros: Array.isArray(body.logros) ? body.logros : [],
        estadisticas: body.estadisticas && typeof body.estadisticas === 'object' ? body.estadisticas : {},
        videos: Array.isArray(body.videos) ? body.videos : [],
        ficha: body.ficha && typeof body.ficha === 'object' ? body.ficha : {},
        publico: body.publico !== false,
        activo: body.activo !== false
    };
}

async function guardarDeportista(userId, body) {
    const id = body.id || null;
    const datos = sanearDeportista(body);
    if (!datos.nombre) return pagerror('Falta el nombre del deportista');
    if (id) {
        const { data, error } = await supabase
            .from('deportes_deportistas')
            .update({ ...datos, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('proyecto_id', datos.proyecto_id)
            .select()
            .single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, deportista: data });
    }
    const { data, error } = await supabase.from('deportes_deportistas').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, deportista: data });
}

async function eliminarDeportista(userId, body) {
    const { id, proyecto_id } = body;
    const { error } = await supabase.from('deportes_deportistas').delete().eq('id', id).eq('proyecto_id', proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: CLUB (planes + horarios)
// ============================================================
async function listarPlanes(userId, body) {
    const { data, error } = await supabase
        .from('deportes_club_planes').select('*').eq('proyecto_id', body.proyecto_id).order('precio_cents');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, planes: data || [] });
}

async function guardarPlan(userId, body) {
    const { id, proyecto_id, nombre, descripcion, precio_cents, periodo, activo } = body;
    if (!nombre) return pagerror('Falta el nombre del plan');
    const datos = {
        proyecto_id, nombre: s(nombre), descripcion: s(descripcion),
        precio_cents: Math.max(0, Math.round(Number(precio_cents) || 0)),
        periodo: s(periodo) || 'mensual', activo: activo !== false
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_club_planes').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, plan: data });
    }
    const { data, error } = await supabase.from('deportes_club_planes').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, plan: data });
}

async function eliminarPlan(userId, body) {
    const { error } = await supabase.from('deportes_club_planes').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

async function listarHorarios(userId, body) {
    const { data, error } = await supabase
        .from('deportes_club_horarios').select('*').eq('proyecto_id', body.proyecto_id).order('dia');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, horarios: data || [] });
}

async function guardarHorario(userId, body) {
    const { id, proyecto_id, categoria, dia, hora_inicio, hora_fin, activo } = body;
    const datos = {
        proyecto_id, categoria: s(categoria), dia: s(dia),
        hora_inicio: s(hora_inicio), hora_fin: s(hora_fin), activo: activo !== false
    };
    if (!datos.dia) return pagerror('Falta el día del horario');
    if (id) {
        const { data, error } = await supabase.from('deportes_club_horarios').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, horario: data });
    }
    const { data, error } = await supabase.from('deportes_club_horarios').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, horario: data });
}

async function eliminarHorario(userId, body) {
    const { error } = await supabase.from('deportes_club_horarios').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: VISORÍAS
// ============================================================
async function listarVisorias(userId, body) {
    const { data, error } = await supabase
        .from('deportes_visorias').select('*').eq('proyecto_id', body.proyecto_id).order('fecha');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, visorias: data || [] });
}

async function guardarVisoria(userId, body) {
    const { id, proyecto_id, titulo, descripcion, fecha, costo_cents, cupo, lugar, activo } = body;
    if (!titulo) return pagerror('Falta el título de la visoría');
    const datos = {
        proyecto_id, titulo: s(titulo), descripcion: s(descripcion),
        fecha: fecha || null,
        costo_cents: Math.max(0, Math.round(Number(costo_cents) || 0)),
        cupo: cupo != null && cupo !== '' ? Number(cupo) : null,
        lugar: s(lugar), activo: activo !== false
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_visorias').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, visoria: data });
    }
    const { data, error } = await supabase.from('deportes_visorias').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, visoria: data });
}

async function eliminarVisoria(userId, body) {
    const { error } = await supabase.from('deportes_visorias').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: INSCRIPCIONES
// ============================================================
async function listarInscripciones(userId, body) {
    const { data, error } = await supabase
        .from('deportes_inscripciones').select('*').eq('proyecto_id', body.proyecto_id).order('created_at', { ascending: false });
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, inscripciones: data || [] });
}

async function guardarInscripcion(userId, body) {
    const { id, proyecto_id, tipo, plan_id, visoria_id, deportista_nombre, fecha_nacimiento, deporte, horario, responsable_nombre, responsable_email, responsable_telefono, datos, consentimiento, consentimiento_uso_imagen, consentimiento_tratamiento, estado } = body;
    if (!responsable_nombre) return pagerror('Falta el responsable');
    const datosFila = {
        proyecto_id, tipo: s(tipo) || 'club',
        plan_id: plan_id || null, visoria_id: visoria_id || null,
        deportista_nombre: s(deportista_nombre), fecha_nacimiento: fecha_nacimiento || null,
        deporte: s(deporte), horario: s(horario),
        responsable_nombre: s(responsable_nombre), responsable_email: s(responsable_email), responsable_telefono: s(responsable_telefono),
        datos: datos && typeof datos === 'object' ? datos : {},
        consentimiento: !!consentimiento, consentimiento_uso_imagen: !!consentimiento_uso_imagen, consentimiento_tratamiento: !!consentimiento_tratamiento,
        estado: s(estado) || 'solicitada'
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_inscripciones').update({ ...datosFila, updated_at: new Date().toISOString() }).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, inscripcion: data });
    }
    const { data, error } = await supabase.from('deportes_inscripciones').insert(datosFila).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, inscripcion: data });
}

async function cambiarEstadoInscripcion(userId, body) {
    const { id, proyecto_id, estado } = body;
    if (!estado) return pagerror('Falta el estado');
    const { data, error } = await supabase
        .from('deportes_inscripciones')
        .update({ estado: s(estado), updated_at: new Date().toISOString() })
        .eq('id', id).eq('proyecto_id', proyecto_id)
        .select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, inscripcion: data });
}

async function evaluarInscripcion(userId, body) {
    const { id, proyecto_id, evaluacion } = body;
    if (!evaluacion || typeof evaluacion !== 'object') return pagerror('Falta la evaluación');
    const { data, error } = await supabase
        .from('deportes_inscripciones')
        .update({ evaluacion, estado: 'evaluada', updated_at: new Date().toISOString() })
        .eq('id', id).eq('proyecto_id', proyecto_id)
        .select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, inscripcion: data });
}

async function eliminarInscripcion(userId, body) {
    const { error } = await supabase.from('deportes_inscripciones').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: TORNEOS
// ============================================================
async function listarTorneos(userId, body) {
    const { data, error } = await supabase
        .from('deportes_torneos').select('*').eq('proyecto_id', body.proyecto_id).order('fecha_inicio');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, torneos: data || [] });
}

async function guardarTorneo(userId, body) {
    const { id, proyecto_id, titulo, categoria, fecha_inicio, fecha_fin, lugar, descripcion, resultados, fotos, activo } = body;
    if (!titulo) return pagerror('Falta el título del torneo');
    const datos = {
        proyecto_id, titulo: s(titulo), categoria: s(categoria),
        fecha_inicio: fecha_inicio || null, fecha_fin: fecha_fin || null,
        lugar: s(lugar), descripcion: s(descripcion),
        resultados: Array.isArray(resultados) ? resultados : [],
        fotos: Array.isArray(fotos) ? fotos : [],
        activo: activo !== false
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_torneos').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, torneo: data });
    }
    const { data, error } = await supabase.from('deportes_torneos').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, torneo: data });
}

async function eliminarTorneo(userId, body) {
    const { error } = await supabase.from('deportes_torneos').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: NOTICIAS / CMS
// ============================================================
async function listarNoticias(userId, body) {
    const { data, error } = await supabase
        .from('deportes_noticias').select('*').eq('proyecto_id', body.proyecto_id)
        .order('fecha_publicacion', { ascending: false });
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, noticias: data || [] });
}

async function guardarNoticia(userId, body) {
    const { id, proyecto_id, titulo, categoria, contenido, imagen_url, fecha_publicacion, activo } = body;
    if (!titulo) return pagerror('Falta el título de la noticia');
    const datos = {
        proyecto_id, titulo: s(titulo), categoria: s(categoria) || 'General',
        contenido: s(contenido), imagen_url: s(imagen_url),
        fecha_publicacion: fecha_publicacion || new Date().toISOString(),
        activo: activo !== false
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_noticias').update({ ...datos, updated_at: new Date().toISOString() }).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, noticia: data });
    }
    const { data, error } = await supabase.from('deportes_noticias').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, noticia: data });
}

async function eliminarNoticia(userId, body) {
    const { error } = await supabase.from('deportes_noticias').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: GALERÍA
// ============================================================
async function listarGaleria(userId, body) {
    const { data, error } = await supabase
        .from('deportes_galeria').select('*').eq('proyecto_id', body.proyecto_id).order('orden');
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, galeria: data || [] });
}

async function guardarItemGaleria(userId, body) {
    const { id, proyecto_id, categoria, titulo, url, tipo, orden, activo } = body;
    if (!url) return pagerror('Falta la URL del item');
    const datos = {
        proyecto_id, categoria: s(categoria) || 'General', titulo: s(titulo),
        url: s(url), tipo: s(tipo) === 'video' ? 'video' : 'imagen',
        orden: Number(orden) || 0, activo: activo !== false
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_galeria').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, item: data });
    }
    const { data, error } = await supabase.from('deportes_galeria').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, item: data });
}

async function eliminarItemGaleria(userId, body) {
    const { error } = await supabase.from('deportes_galeria').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  ADMIN: CONSENTIMIENTOS
// ============================================================
async function listarConsentimientos(userId, body) {
    const { data, error } = await supabase
        .from('deportes_consentimientos').select('*').eq('proyecto_id', body.proyecto_id).order('fecha', { ascending: false });
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, consentimientos: data || [] });
}

async function guardarConsentimiento(userId, body) {
    const { id, proyecto_id, sujeto_nombre, sujeto_tipo, responsable, uso_imagen, tratamiento_datos, documento_version, estado, notas } = body;
    const datos = {
        proyecto_id, sujeto_nombre: s(sujeto_nombre), sujeto_tipo: s(sujeto_tipo) || 'deportista',
        responsable: s(responsable), uso_imagen: !!uso_imagen, tratamiento_datos: !!tratamiento_datos,
        documento_version: s(documento_version) || 'v1', estado: s(estado) || 'aceptado', notas: s(notas)
    };
    if (id) {
        const { data, error } = await supabase.from('deportes_consentimientos').update(datos).eq('id', id).eq('proyecto_id', proyecto_id).select().single();
        if (error) return pagerror(error.message, 500);
        return ok({ ok: true, consentimiento: data });
    }
    const { data, error } = await supabase.from('deportes_consentimientos').insert(datos).select().single();
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true, consentimiento: data });
}

async function eliminarConsentimiento(userId, body) {
    const { error } = await supabase.from('deportes_consentimientos').delete().eq('id', body.id).eq('proyecto_id', body.proyecto_id);
    if (error) return pagerror(error.message, 500);
    return ok({ ok: true });
}

// ============================================================
//  PAGO DE INSCRIPCIÓN (visoría/club) — reutiliza orden de tienda + Wompi
//  Crea una tienda_ordenes (estado pendiente) con el monto del plan/visoría,
//  genera el link de pago Wompi de la pasarela del proyecto y vincula
//  orden_id/pago_id a la inscripción.
// ============================================================
async function pagoInscripcion(userId, body) {
    const { proyecto_id, inscripcion_id } = body;
    if (!inscripcion_id) return pagerror('Falta la inscripción');

    const { data: insc, error: insErr } = await supabase
        .from('deportes_inscripciones')
        .select('*')
        .eq('id', inscripcion_id)
        .eq('proyecto_id', proyecto_id)
        .maybeSingle();
    if (insErr) return pagerror(insErr.message, 500);
    if (!insc) return pagerror('Inscripción no encontrada', 404);
    if (insc.orden_id) return pagerror('Esta inscripción ya tiene una orden de pago');

    const { data: proyecto, error: proyErr } = await supabase
        .from('web_projects').select('*').eq('id', proyecto_id).maybeSingle();
    if (proyErr || !proyecto) return pagerror('Proyecto no encontrado', 404);

    // Determinar monto y concepto
    let montoCents = 0;
    let concepto = 'Inscripción';
    if (insc.tipo === 'visoria' && insc.visoria_id) {
        const { data: vis } = await supabase.from('deportes_visorias').select('titulo, costo_cents').eq('id', insc.visoria_id).maybeSingle();
        montoCents = vis?.costo_cents || 0;
        concepto = 'Visoría: ' + (vis?.titulo || '') || concepto;
    } else if (insc.plan_id) {
        const { data: plan } = await supabase.from('deportes_club_planes').select('nombre, precio_cents').eq('id', insc.plan_id).maybeSingle();
        montoCents = plan?.precio_cents || 0;
        concepto = 'Plan Club: ' + (plan?.nombre || '') || concepto;
    } else {
        const costo = Number(insc.datos?.monto_cents) || 0;
        montoCents = costo;
        concepto = 'Inscripción (' + insc.tipo + ')';
    }
    if (!montoCents || montoCents <= 0) return pagerror('No se pudo determinar el monto de pago para esta inscripción');

    // Pasarela Wompi del proyecto
    const { data: pasarela, error: pasarelaErr } = await supabase
        .from('tienda_pasarela').select('*').eq('proyecto_id', proyecto_id).maybeSingle();
    if (pasarelaErr && !/does not exist/i.test(pasarelaErr.message || '')) return pagerror('Error leyendo pasarela', 500);
    if (!pasarela?.wompi_private_key) return pagerror('Este proyecto no tiene pasarela de pago (Wompi) configurada', 402);

    const WOMPI_BASE = pasarela.wompi_sandbox
        ? 'https://sandbox.wompi.co/v1'
        : 'https://production.wompi.co/v1';
    const SITE_URL = process.env.URL || 'https://auvro.netlify.app';
    const email = insc.responsable_email || '';
    const nombre = insc.responsable_nombre || insc.deportista_nombre || 'Cliente';

    // Orden + línea (producto ficticio de la inscripción, sin tocar tienda_productos)
    const { data: orden, error: ordenErr } = await supabase.from('tienda_ordenes').insert({
        proyecto_id,
        cliente_nombre: nombre,
        cliente_email: email,
        cliente_telefono: insc.responsable_telefono || null,
        total_cents: montoCents,
        estado: 'pendiente',
        estado_pago: 'pendiente',
        metodo_pago: 'wompi'
    }).select().single();
    if (ordenErr) return pagerror('No se pudo crear la orden: ' + ordenErr.message, 500);

    const { error: itemsErr } = await supabase.from('tienda_orden_items').insert({
        orden_id: orden.id,
        nombre: concepto,
        precio_cents: montoCents,
        cantidad: 1
    });
    if (itemsErr) {
        await supabase.from('tienda_ordenes').delete().eq('id', orden.id).catch(() => {});
        return pagerror('No se pudo guardar la línea de la orden', 500);
    }

    // Link de pago Wompi
    const redirect = (proyecto.netlify_url || SITE_URL).replace(/\/+$/, '') + `/?orden=${orden.id}`;
    const wompiRes = await fetch(`${WOMPI_BASE}/payment_links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pasarela.wompi_private_key}` },
        body: JSON.stringify({
            name: `AUVRO - ${concepto}`,
            description: concepto,
            single_use: true,
            collect_shipping: false,
            currency: 'COP',
            amount_in_cents: montoCents,
            redirect_url: redirect
        })
    });
    const wompi = await wompiRes.json();
    if (!wompiRes.ok || !wompi?.data?.id) {
        await supabase.from('tienda_ordenes').delete().eq('id', orden.id).catch(() => {});
        return pagerror(wompi?.error?.message || 'Error creando el pago en Wompi.', 502);
    }
    const paymentLinkId = wompi.data.id;

    await supabase.from('tienda_ordenes').update({ payment_link_id: paymentLinkId }).eq('id', orden.id).catch(() => {});

    const { error: pagosErr } = await supabase.from('pagos').insert({
        user_id: proyecto.created_by || null,
        tipo: 'tienda',
        concepto,
        monto_cents: montoCents,
        payment_link_id: paymentLinkId,
        orden_id: orden.id,
        estado: 'pendiente'
    });
    if (pagosErr) {
        await supabase.from('tienda_ordenes').delete().eq('id', orden.id).catch(() => {});
        await fetch(`${WOMPI_BASE}/payment_links/${paymentLinkId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${pasarela.wompi_private_key}` }
        }).catch(() => {});
        return pagerror('No se pudo registrar el pago.', 500);
    }

    // Vincular a la inscripción
    await supabase.from('deportes_inscripciones').update({
        orden_id: orden.id,
        pago_id: paymentLinkId,
        updated_at: new Date().toISOString()
    }).eq('id', insc.id).catch(() => {});

    return ok({ ok: true, url: `https://checkout.wompi.co/l/${paymentLinkId}`, orden_id: orden.id, monto_cents: montoCents });
}

// ============================================================
//  HANDLER
// ============================================================
exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
    if (!['POST', 'GET'].includes(event.httpMethod)) return ok({ ok: false, error: 'Method Not Allowed' }, 405);

    let body = {};
    try {
        body = event.httpMethod === 'GET'
            ? Object.fromEntries(new URL(event.url, 'http://x').searchParams)
            : (JSON.parse(event.body || '{}') || {});
    } catch (e) {
        return pagerror('JSON inválido');
    }

    const action = s(body.action);
    const esPublica = ['catalogo_publico', 'inscribir_publico'].includes(action);

    try {
        if (action === 'catalogo_publico') return await accionCatalogoPublico(body);
        if (action === 'inscribir_publico') return await accionInscribirPublico(body);

        // Acciones de admin: autenticar y validar acceso al proyecto
        const proyectoId = body.proyecto_id || null;
        const userId = await autenticarAdmin(event, proyectoId);
        if (!proyectoId) return pagerror('Falta proyecto_id');

        switch (action) {
            case 'listar_deportistas': return await listarDeportistas(userId, body);
            case 'buscar_deportistas': return await buscarDeportistas(userId, body);
            case 'get_deportista': return await getDeportista(userId, body);
            case 'guardar_deportista': return await guardarDeportista(userId, body);
            case 'eliminar_deportista': return await eliminarDeportista(userId, body);

            case 'listar_planes': return await listarPlanes(userId, body);
            case 'guardar_plan': return await guardarPlan(userId, body);
            case 'eliminar_plan': return await eliminarPlan(userId, body);
            case 'listar_horarios': return await listarHorarios(userId, body);
            case 'guardar_horario': return await guardarHorario(userId, body);
            case 'eliminar_horario': return await eliminarHorario(userId, body);

            case 'listar_visorias': return await listarVisorias(userId, body);
            case 'guardar_visoria': return await guardarVisoria(userId, body);
            case 'eliminar_visoria': return await eliminarVisoria(userId, body);

            case 'listar_inscripciones': return await listarInscripciones(userId, body);
            case 'guardar_inscripcion': return await guardarInscripcion(userId, body);
            case 'cambiar_estado_inscripcion': return await cambiarEstadoInscripcion(userId, body);
            case 'evaluar_inscripcion': return await evaluarInscripcion(userId, body);
            case 'eliminar_inscripcion': return await eliminarInscripcion(userId, body);
            case 'pago_inscripcion': return await pagoInscripcion(userId, body);

            case 'listar_torneos': return await listarTorneos(userId, body);
            case 'guardar_torneo': return await guardarTorneo(userId, body);
            case 'eliminar_torneo': return await eliminarTorneo(userId, body);

            case 'listar_noticias': return await listarNoticias(userId, body);
            case 'guardar_noticia': return await guardarNoticia(userId, body);
            case 'eliminar_noticia': return await eliminarNoticia(userId, body);

            case 'listar_galeria': return await listarGaleria(userId, body);
            case 'guardar_item_galeria': return await guardarItemGaleria(userId, body);
            case 'eliminar_item_galeria': return await eliminarItemGaleria(userId, body);

            case 'listar_consentimientos': return await listarConsentimientos(userId, body);
            case 'guardar_consentimiento': return await guardarConsentimiento(userId, body);
            case 'eliminar_consentimiento': return await eliminarConsentimiento(userId, body);

            default: return pagerror('Acción desconocida: ' + action, 404);
        }
    } catch (err) {
        console.error('deportes.js error:', err.message);
        return pagerror(err.message || 'Error interno', 401);
    }
};
