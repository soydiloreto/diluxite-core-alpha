-- TOTP — secretos de 2FA por usuario.
--
-- Una fila por usuario que tenga 2FA habilitado (enroll completado). La fila
-- aparece DESPUÉS del verify-enroll: el secreto en memoria durante el enroll
-- NO se persiste hasta que el user confirma con un código válido. Esto evita
-- dejar secretos huérfanos si el usuario abandona el flow.
--
-- `confirmed_at` puede sonar redundante (si la fila existe, está confirmada),
-- pero lo dejamos por dos razones: (1) audit-friendly ("¿desde cuándo está
-- esta cuenta con 2FA?"), y (2) si el futuro permite enroll-in-progress
-- guardado, la columna distingue rows confirmadas vs pending.
--
-- `secret` se guarda en plaintext en la DB. Argumentos a favor: el secret
-- TOTP no es un password (es un secret de máquina, se rota cuando el user
-- pierde el dispositivo), y encriptarlo con una key local solo añade
-- complejidad sin elevar el barrier — quien tenga acceso a la DB también
-- tendría acceso a la encryption key. Para deploys que necesitan defensa
-- en profundidad acá, el path correcto es pgcrypto + KMS — fuera de scope.
--
-- `backup_codes` es un array de hashes (SHA-256). Cada uso los marca como
-- consumidos: la fila se reescribe sin ese hash. Tener N códigos de un solo
-- uso es la forma estándar de recuperar acceso cuando se pierde el dispositivo.

CREATE TABLE IF NOT EXISTS totp_secrets (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret          text NOT NULL,
  confirmed_at    timestamptz NOT NULL DEFAULT now(),
  backup_codes    text[] NOT NULL DEFAULT '{}'::text[]
);
