# Diluxite — Modelo de seguridad

Cómo se protegen las llamadas API entre el front y el back, qué credenciales
viajan por dónde, qué garantías da cada capa, y qué huecos quedan abiertos.

> **Resumen en una línea:** no hay un IdP externo (Entra/Auth0). Toda la auth
> vive en el mismo proceso que el API (Fastify), con cuatro capas: identidad,
> middleware de gating, autorización por workspace, y RLS en Postgres.

## 1. Modos de autenticación

El comportamiento de auth se decide al boot por la env var
`DILUXITE_AUTH_MODE`:

| Modo | Provider | Credencial | Caso de uso |
|---|---|---|---|
| `local` (default) | `SingleUserAuthProvider` | **Ninguna** — toda request es el user bootstrap `local@diluxite` | Self-host single-user, dev local |
| `server` | `SessionAuthProvider` | Cookie de sesión `diluxite_session` (HttpOnly + SameSite=Lax) **o** `Authorization: Bearer <token>` | Multi-user, equipos, Cloud |

### Detalle de `server` mode

```
Set-Cookie: diluxite_session=<token-opaco>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>
```

- **HttpOnly**: JavaScript no puede leer el cookie. Protege contra XSS robando
  sesión.
- **SameSite=Lax**: el browser no envía la cookie en POST cross-site (CSRF
  básico cubierto). Sí la envía en GET de top-level navigation.
- El token es **opaco** (no JWT) — random bytes generados por el server. Lo
  que se guarda en DB es el **SHA-256** del token. Si la DB se filtra, no se
  pueden reusar sesiones.
- Bearer token equivalente: usado por clientes API/MCP que no manejan
  cookies (Claude, Copilot, cURL, scripts). Se mintea en Settings → MCP
  connection o Settings → Tokens. Mismo hash storage.

## 2. Middleware: todo `/api/*` requiere identidad

```ts
// apps/api/src/app.ts:122
app.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api')) return;       // /health y /mcp tienen sus propios paths
  if (req.url.startsWith('/api/auth/')) return;  // login/logout obviamente no
  const id = await deps.auth.resolve(req.headers);
  if (!id) {
    reply.code(401).send({ error: 'unauthenticated' });
    return reply;
  }
  req.identity = id;
});
```

Excepciones explícitas (las únicas):

- `/health`, `/health/db` — healthchecks, no exponen datos.
- `/api/auth/login`, `/api/auth/logout` — su propia lógica.
- `/api/auth/passkey/*` — flow WebAuthn, valida challenges firmados.
- `/mcp/*` — usa el mismo `AuthProvider`, pero el path es distinto del REST.

## 3. Autorización por workspace

Saber "quién es el user" no alcanza — también hay que verificar a qué
workspaces tiene acceso. Defensa en profundidad **doble**:

### 3a. Guard en code (Fastify)

```ts
async function requireMember(req, reply, spaceId) {
  if (await deps.spaces.isMember(spaceId, uid(req))) return true;
  reply.code(403).send({ error: 'no access to this space' });
  return false;
}
```

Cada endpoint que toca un space lo llama antes de hacer la query.

### 3b. RLS en Postgres (`migrations/0003_row_level_security.sql`)

Antes de cada query, el server emite:

```sql
SET LOCAL app.current_user_id = '<uuid>';
```

Y las políticas RLS sobre `notes`, `chunks`, `tags`, `links`, `spaces` exigen
que el `user_id` matchee. **Aunque alguien bypass el guard de code, la DB
todavía rechaza filas que no son del usuario.**

Esto es lo que hace seguro el multi-tenant: un bug de routing no se
convierte en data leak.

## 4. Tokens con scope (org tokens)

Distintos del session/Bearer del user: estos son tokens **del workspace**,
no del usuario que los crea. Sobreviven cuando el creador sale.

Tres scopes excluyentes:

| Scope | Permite | NO permite |
|---|---|---|
| `read` | Listar notes, search, GET endpoints | Mutaciones, admin |
| `write` | Read + crear/actualizar notes | Borrar org, manage members |
| `admin` | Write + manage members, settings de la org | Solo super_admin puede borrar org |

Implementación en `tokens` table con CHECK constraint XOR (el token es de
user **o** de org, nunca ambos a la vez).

## 5. MCP (Claude/Copilot/etc.)

`/mcp` usa el mismo `AuthProvider`, pero los clientes IA acceden con
**Bearer token** (no cookie — los IDEs no manejan cookies). El user mintea
el token desde Settings → MCP connection. Lo pega en la config de Claude
o Copilot. Cada request del IDE lleva el `Authorization: Bearer …` header
y resuelve identidad igual que el REST.

El token tiene el mismo formato y storage que un user token — no hay un
"tipo MCP" especial. Es solo un Bearer token cuya UI de creación está
puesta cerca de los settings de MCP por usabilidad.

## 6. Diagrama del flow

```
                    ┌─────────────────────────────────────┐
                    │  Diluxite API (proceso Fastify)     │
                    │                                     │
   Browser ──HTTP──►│ 1. preHandler /api/*                │
   o MCP            │    AuthProvider.resolve(headers)    │
   o curl           │    → Identity { userId } or 401     │
                    │                                     │
                    │ 2. handler-level:                   │
                    │    requireMember(spaceId, userId)   │
                    │    → 403 si no es miembro           │
                    │                                     │
                    │ 3. SET LOCAL app.current_user_id    │
                    │    → RLS Postgres                   │
                    │                                     │
                    │ 4. Query SQL                        │
                    │    ← solo rows con user_id match    │
                    └─────────────────────────────────────┘
```

## 7. Lo que SÍ protege hoy

- ✅ Sesiones server-mode con cookies `HttpOnly+SameSite=Lax`
  (XSS-resistant, CSRF-resistant básico).
- ✅ **CSRF defense-in-depth** (alpha.32 — double-submit cookie pattern).
  Al mintear sesión, el server emite un cookie `diluxite_csrf` NO-HttpOnly +
  retorna el mismo token en el body. La SPA lo lee y lo echo en
  `X-CSRF-Token` en cada POST/PUT/DELETE/PATCH. Si el header no matchea el
  cookie → 403. Bearer-token requests skip el check (no son browser-cookie
  auth, no hay CSRF risk). Toggle: `DILUXITE_CSRF_DISABLED=1`.
- ✅ Tokens hasheados en DB (SHA-256). Filtración de DB ≠ tokens reusables.
- ✅ RLS en Postgres como defensa en profundidad multi-tenant.
- ✅ Todos los `/api/*` requieren identidad explícita.
- ✅ Guards por workspace en cada endpoint que tocar uno.
- ✅ Passwords con PBKDF2-SHA512 + salt (alpha-comparable a Argon2 para el
  use case).
- ✅ Org tokens con scopes (read/write/admin).
- ✅ Passkeys WebAuthn (opt-in, sin password).
- ✅ Auth en WebSocket collab (`/collab`) — la cookie viaja en el upgrade.

## 8. Lo que NO protege (huecos honestos)

| Hueco | Riesgo | Severidad | Prioridad fix |
|---|---|---|---|
| ~~No hay rate limit en `/api/auth/login`~~ | **Cerrado en alpha.21** — 5 intentos/min por IP via `@fastify/rate-limit`. Mismo budget en `/login/totp` y `/auth/password`. | — | ✅ |
| No hay rate limit en general | DoS por flood de queries pesadas | Bajo en self-host | Media |
| ~~No hay CSRF token explícito~~ | **Cerrado en alpha.32** — double-submit cookie. SameSite=Lax sigue activo como primera línea, X-CSRF-Token es la segunda. | — | ✅ |
| ~~No hay HTTPS por default en el container~~ | **Cerrado en alpha.33** — wizard installer ofrece Caddy sidecar con ACME (Let's Encrypt) automatic; en `docker compose --profile https up -d` queda terminating TLS en :443. | — | ✅ |
| ~~No 2FA TOTP~~ | **Cerrado en alpha.36+37** — TOTP RFC 6238 con backup codes, enroll desde Settings → Two-factor authentication. Login flow gated cuando el user lo activa. | — | ✅ |
| Modo `local` confía en quien tenga el puerto 5173 | Cualquier proceso en tu PC puede leer/escribir tus notas | **Alto si exponés más allá de localhost** | Solo educación + docs |
| ~~Bearer tokens no expiran~~ | **Cerrado en alpha.20+** — `expires_at` opcional al mintear + revoke-all panic button + UI Settings → Connect & MCP. | — | ✅ |
| ~~Sin límite de sesiones concurrentes~~ | **Mitigado en alpha.39** — Settings → Sessions lista todas las activas con device + IP + last seen y permite revocar individualmente o "sign out of all other devices". No hay límite duro pero el user ve y controla. | — | ✅ |
| ~~Sin audit log~~ | **Cerrado en alpha.34+35** — `audit_events` append-only con auth/admin events + Admin Console → Audit con filtros + retention opcional (alpha.38). | — | ✅ |
| ~~Sessions no se invalidan al cambiar password~~ | **Cerrado en alpha.40** — POST /api/auth/password revoca todas las sessions excepto la del cookie current. | — | ✅ |

## 9. Cómo endurecer — orden recomendado

Cada item es task independiente con sus propios tests:

1. **Rate limit `/api/auth/login`** (5 intentos/min por IP). `@fastify/rate-limit`. ~1h.
2. **Token expiration + revoke-all UI**. ALTER `tokens.expires_at` + endpoint
   POST `/api/tokens/:id/revoke` y POST `/api/tokens/revoke-all`. ~2h.
3. **HTTPS por default** en el installer. Caddy o Traefik sidecar + Let's
   Encrypt en `--with-domain`. ~3h.
4. **CSRF token explícito** (double-submit cookie). ~2h.
5. **Audit log table** (`audit_events`: login/logout/token mint/password
   change/role change). ~3h.
6. **2FA TOTP** encima de passkeys. ~4h.
7. **Invalidar sesiones al cambiar password**. ~1h.

## 10. ¿Tenés identity server?

**No.** No hay IdP separado. No hay JWT, no hay OAuth2/OIDC externo. Para
Cloud está planeado un Entra ID (Google/Microsoft), pero eso es repo
separado (`soydiloreto/diluxite-cloud`, no este).

Si vas a integrar Diluxite Core con un IdP corporativo a futuro, la
extensión natural es agregar un `EntraAuthProvider` que implemente el
mismo `AuthProvider` interface, leyendo un JWT validado por el IdP en vez
del cookie. Toda la cadena posterior (`requireMember`, RLS) sigue igual.
