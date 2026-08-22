-- Triggers para sincronizar agentes_ia.tienda_id ↔ web_projects.agente_id
-- Cuando se asigna un agente a una tienda, se actualiza web_projects.agente_id de esa tienda
-- Cuando se desasigna un agente (tienda_id = null), se limpia web_projects.agente_id

-- 1) Trigger al UPDATE en agentes_ia (cambiar tienda_id)
CREATE OR REPLACE FUNCTION sync_agente_tienda_from_agentes()
RETURNS TRIGGER AS $$
BEGIN
    -- Si el agente tenía una tienda antes y ahora tiene otra o ninguna
    IF OLD.tienda_id IS DISTINCT FROM NEW.tienda_id THEN
        -- Limpiar la referencia en la tienda anterior (si existía)
        IF OLD.tienda_id IS NOT NULL THEN
            UPDATE web_projects
            SET agente_id = NULL
            WHERE id = OLD.tienda_id AND agente_id = NEW.id;
        END IF;
        -- Asignar en la nueva tienda (si aplica)
        IF NEW.tienda_id IS NOT NULL THEN
            -- Primero limpiar cualquier otro agente asignado a esa tienda
            UPDATE web_projects
            SET agente_id = NULL
            WHERE id = NEW.tienda_id AND agente_id IS NOT NULL AND agente_id != NEW.id;
            -- Asignar el agente
            UPDATE web_projects
            SET agente_id = NEW.id
            WHERE id = NEW.tienda_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS sync_agente_tienda_from_agentes ON agentes_ia;
CREATE TRIGGER sync_agente_tienda_from_agentes
    AFTER UPDATE OF tienda_id ON agentes_ia
    FOR EACH ROW
    WHEN (OLD.tienda_id IS DISTINCT FROM NEW.tienda_id)
    EXECUTE FUNCTION sync_agente_tienda_from_agentes();

-- 2) Trigger al UPDATE en web_projects (cambiar agente_id)
CREATE OR REPLACE FUNCTION sync_tienda_from_web_projects()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.agente_id IS DISTINCT FROM NEW.agente_id THEN
        -- Si se asignó un agente a la tienda, actualizar tienda_id del agente
        IF NEW.agente_id IS NOT NULL THEN
            -- Limpiar tienda_id de cualquier otro agente que apuntara a esta tienda
            UPDATE agentes_ia
            SET tienda_id = NULL
            WHERE tienda_id = NEW.id AND id != NEW.agente_id;
            -- Asignar la tienda al agente
            UPDATE agentes_ia
            SET tienda_id = NEW.id
            WHERE id = NEW.agente_id AND (tienda_id IS NULL OR tienda_id != NEW.id);
        END IF;
        -- Si se desasignó el agente (agente_id = NULL), limpiar tienda_id del agente anterior
        IF NEW.agente_id IS NULL AND OLD.agente_id IS NOT NULL THEN
            UPDATE agentes_ia
            SET tienda_id = NULL
            WHERE id = OLD.agente_id AND tienda_id = NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS sync_tienda_from_web_projects ON web_projects;
CREATE TRIGGER sync_tienda_from_web_projects
    AFTER UPDATE OF agente_id ON web_projects
    FOR EACH ROW
    WHEN (OLD.agente_id IS DISTINCT FROM NEW.agente_id)
    EXECUTE FUNCTION sync_tienda_from_web_projects();

-- 3) Eliminar la vista v_catalogo_unificado muerta (el código la reimplementa manualmente)
DROP VIEW IF EXISTS v_catalogo_unificado;
