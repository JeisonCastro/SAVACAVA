const { supabase } = require('./supabase-admin');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };

    try {
        const body = JSON.parse(event.body || '{}');
        if (body.secret !== 'auvro-seed-2026') return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized' }) };

        const { data: existing } = await supabase.from('web_projects').select('id').eq('slug', 'mascotraoficial').maybeSingle();
        if (existing) return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Ya existe', id: existing.id }) };

        const { data, error } = await supabase.from('web_projects').insert({
            nombre: 'Mascota Ra Oficial',
            slug: 'mascotraoficial',
            cliente: 'Mascota Ra',
            plantilla: 'landing',
            descripcion: 'Pagina oficial de Mascota Ra',
            github_owner: 'JeisonCastro',
            github_repo: 'mascotraoficial',
            default_branch: 'main',
            github_url: 'https://github.com/JeisonCastro/mascotraoficial',
            clone_url: 'https://github.com/JeisonCastro/mascotraoficial.git',
            netlify_url: 'https://mascotraoficial.netlify.app',
            netlify_site_id: '8e6329c1-c5d2-4a10-9870-47812e164150',
            estado: 'publicado',
            created_by: 'c253d139-dde5-4302-81ef-321a1b81ca6d'
        }).select('id').single();

        if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true, id: data.id }) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
