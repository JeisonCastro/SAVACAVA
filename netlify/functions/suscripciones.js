// suscripciones.js — Logica compartida del ciclo de suscripciones
// Estados: sin_plan, activo, por_vencer, vencido (gracia), desactivado

const DURACION_DIAS = 30;
const AVISO_DIAS = 3;
const GRACIA_DIAS = 5;
const FREE_PLAN_ID = 1;

function calcularEstado(planId, planVencimiento, ahora = Date.now()) {
    if (!planVencimiento) {
        return { estado: planId ? 'activo' : 'sin_plan', dias: null };
    }
    const ms = new Date(planVencimiento).getTime() - ahora;
    const dias = Math.ceil(ms / 86400000);
    if (dias > AVISO_DIAS) return { estado: 'activo', dias };
    if (dias > 0) return { estado: 'por_vencer', dias };
    if (dias > -GRACIA_DIAS) return { estado: 'vencido', dias };
    return { estado: 'desactivado', dias };
}

function fechaVencimiento(dias = DURACION_DIAS) {
    return new Date(Date.now() + dias * 86400000).toISOString();
}

module.exports = { DURACION_DIAS, AVISO_DIAS, GRACIA_DIAS, FREE_PLAN_ID, calcularEstado, fechaVencimiento };
