-- Interruptor d'emergència de les entregues automàtiques (README §5).
-- El cron llegeix pause_releases a cada execució: amb '1' avisa però no entrega.
-- S'activa i es desactiva amb un UPDATE, sense deploy.
CREATE TABLE system (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO system (key, value) VALUES ('pause_releases', '0');
