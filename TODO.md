# TODO — pendiente cuando volvamos a la sesión

## Cosas grandes aún no atacadas

- Scope selector en la TopBar (workspace / por carpeta).
- Sistema de notificaciones real (la 🔔 abre un popover vacío).
- Tabla `activity_log` para que el Timeline muestre eventos de carpeta
  / borrado masivo (hoy se deriva sólo de `notes.createdAt` /
  `notes.updatedAt`).

## Cómo arrancar mañana

```bash
cd ~/Repos/diluxite
git checkout feat/ux-polish
docker compose up -d db
pnpm --filter @diluxite/api dev   # API + MCP :3030
pnpm --filter @diluxite/web dev   # Web :5173
```
