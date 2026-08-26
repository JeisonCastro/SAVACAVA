-- Agregar columna para botón de WhatsApp en productos catálogo
ALTER TABLE tienda_productos 
ADD COLUMN whatsapp_button boolean NOT NULL DEFAULT false;
