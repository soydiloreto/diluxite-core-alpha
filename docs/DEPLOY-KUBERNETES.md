# Diluxite — Deploy en Kubernetes

> **Estado:** esqueleto (sin manifests todavía). La validación end-to-end
> se hace en `kind` local antes de publicar manifests definitivos —
> ver [Estado y próximos pasos](#estado-y-próximos-pasos).

Esta guía es para empresas que quieren correr Diluxite en su propio cluster
Kubernetes (AKS, EKS, GKE, on-prem, k3s, etc.) en vez de single-machine con
`install.sh` (Docker Compose).

Si solo querés probar Diluxite, usá el [`install.sh`](../README.md#correr-en-local) —
levanta el stack completo en 5 minutos y es lo recomendado para uso personal
o equipos chicos.

## Cuándo elegir Kubernetes

Tiene sentido si vas a:

- Correrlo para una organización con **decenas o miles de usuarios** (server mode).
- Querés **HA** (réplicas de API, web, Postgres gestionado).
- Ya tenés stack K8s (GitOps, observability, secrets management) y querés que
  Diluxite encaje ahí en vez de ser un container suelto.
- Necesitás integrar con **Postgres gestionado** (Azure DB for PostgreSQL Flexible
  Server con extensión `vector`, AWS Aurora Postgres, Cloud SQL) por requisitos
  de compliance, backup centralizado, etc.

Si nada de eso aplica, `install.sh` te da el mismo motor con mucho menos overhead.

## Decisiones que tomar antes de escribir manifests

Estas 6 son las que más impactan en el shape de los YAML. Definí las respuestas
antes de empezar, porque cambiar a mitad de camino es costoso.

### 1. ¿Postgres in-cluster o gestionado?

| Opción | Cuándo elegir |
|---|---|
| **Gestionado** (Azure DB for PostgreSQL Flexible Server / Aurora / CloudSQL) — **recomendado para producción** | Tu empresa ya gestiona DBs así. Backup, HA, point-in-time recovery, monitoring vienen incluidos. Cero DB ops. **Necesita extensión `vector`** (todos los managed Postgres modernos la soportan; activá explícitamente). |
| **In-cluster** con [CloudNativePG](https://cloudnative-pg.io/) operator + PVC | PoC, on-prem sin DBaaS, o querés todo en un cluster. Asumís HA, backup, restore, upgrades. No es trivial. |
| **In-cluster** con StatefulSet simple + PVC | Solo para PoC / dev / kind local. **No para producción.** |

### 2. ¿Qué embedder?

| Opción | Cuándo elegir |
|---|---|
| **Azure OpenAI** — **recomendado para enterprise** | Sin infra extra, cuotas claras, latencia baja, modelo top (`text-embedding-3-large`). El operador solo configura endpoint + key + deployment name como secret. |
| **Ollama in-cluster con `mxbai-embed-large:335m`** | Self-host estricto, no querés enviar datos a OpenAI. Necesita node pool con GPU o CPU pesada (CPU funciona pero es lento en cargas grandes). Imagen Ollama + volumen para el modelo (~669 MB). |
| **Determinista** | Solo para tests. **No usar en producción** — no hay calidad semántica real. |

### 3. ¿All-in-one o api/web separados?

| Opción | Cuándo elegir |
|---|---|
| **api/web separados** (`soydiloreto/diluxite-api` + `soydiloreto/diluxite-web`) — **recomendado en K8s** | Permite escalar api y web independientemente, rolling updates por separado, network policies por workload. Más idiomatic K8s. |
| **All-in-one** (`soydiloreto/diluxite`) | Solo si querés migrar tu stack Compose tal cual al cluster sin cambiar nada. Menos flexibilidad. |

### 4. ¿Auth mode `server` (siempre)?

Para deploy K8s siempre es `server` — multi-usuario con email + password, sesiones
opacas + Bearer tokens, opcional passkeys (WebAuthn). El admin inicial se
configura via env vars `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` que
viven en un Secret.

`local` mode no tiene sentido en K8s (es passwordless single-user, pensado para
tu PC personal).

### 5. ¿Cómo gestionás secretos?

| Opción | Cuándo elegir |
|---|---|
| **External Secrets Operator** apuntando a Azure Key Vault / AWS Secrets Manager / GCP Secret Manager — **recomendado** | Los secretos viven en el vault corporativo, K8s solo sincroniza. Audit, rotación, RBAC del vault. |
| **Sealed Secrets** (Bitnami) | Secrets encriptados en Git (GitOps friendly). Para clusters sin vault gestionado. |
| **Secrets en plano** | Solo PoC. **Nunca producción.** |

Secrets requeridos: `DILUXITE_ADMIN_EMAIL`, `DILUXITE_ADMIN_PASSWORD`, password
de Postgres (si in-cluster), `AZURE_OPENAI_API_KEY` (si Azure embedder).

### 6. ¿Cómo manejás updates?

En K8s **no** se usa Watchtower (que sí va con Docker Compose). Lo idiomatic:

| Opción | Cuándo elegir |
|---|---|
| **GitOps** (Flux / ArgoCD) + **Renovate** | Renovate abre PRs cuando hay nueva versión en Docker Hub, Flux/ArgoCD aplica al cluster cuando merguás. Audit completo, rollback con `git revert`. Recomendado. |
| **Manual `kubectl set image` + `kubectl rollout`** | Para equipos sin GitOps todavía. Funciona pero pierde traceability. |
| **`imagePullPolicy: Always` + rollout cron** | Funciona pero es opaco — equivalente a Watchtower. No recomendado en serio. |

## Quick start (PoC en `kind`)

> **Pendiente** — manifests YAML se publican después de validarlos end-to-end
> en `kind` local. Ver [estado](#estado-y-próximos-pasos).

Outline planeado:

1. `kind create cluster --name diluxite`
2. Postgres con CloudNativePG (operator) + cluster con extensión `vector`.
3. `Deployment` + `Service` para `diluxite-api` (1 réplica, env vars desde
   ConfigMap, secrets desde Secret).
4. `Deployment` + `Service` para `diluxite-web` (2 réplicas).
5. `Ingress` (nginx ingress controller) ruteando `/api` → api-service y `/` → web-service.
6. `Secret` con admin email + password + Azure OpenAI key.
7. Bootstrap: el admin se crea solo en el primer boot del api pod (idempotente).
8. Smoke test: navegar al Ingress, login con admin, crear nota, búsqueda.

## Producción

> **Pendiente** — se documenta después del PoC.

Outline planeado:

- Postgres gestionado (Azure DB for PostgreSQL Flexible Server o equivalente)
  con extensión `vector` habilitada y connection string en Secret.
- 3+ réplicas de api, 2+ de web, behind HPA con métricas de CPU + latencia.
- Network Policies: api solo accesible desde web e ingress; postgres solo
  desde api.
- PodDisruptionBudget para minimizar downtime en upgrades.
- Backups: si Postgres gestionado, los backups vienen incluidos; si in-cluster
  con CloudNativePG, configurar `BackupConfiguration` a object storage.
- Observability: Prometheus scrape de `/metrics` (cuando exista — ver
  [roadmap](./ROADMAP.md)) + logs a Loki / DataDog / equivalente.
- External Secrets Operator + Key Vault.
- GitOps con Flux o ArgoCD apuntando a un repo de manifests separado del repo
  de código.

## Helm chart

> **Roadmap.** Una vez los manifests crudos estén validados en `kind` y en
> un AKS real, los empaquetamos como Helm chart en
> `soydiloreto/diluxite-helm` (repo separado) con `values.yaml` parametrizable
> para los 6 decisiones de arriba. Hasta entonces, los manifests crudos
> sirven como referencia.

## Estado y próximos pasos

| Pieza | Estado |
|---|---|
| Decisiones de diseño documentadas | ✅ Este doc |
| Manifests YAML crudos (kind / minikube / k3s) | ⏳ Pendiente — se valida en `kind` local primero |
| Producción (Postgres gestionado, ExternalSecrets, GitOps) | ⏳ Pendiente — depende del quick start |
| Helm chart oficial | ⏳ Pendiente — después de validar manifests crudos |
| Validación en AKS real | ⏳ Pendiente |

**No publicamos manifests YAML "best guess" sin validar.** Si te sirvió esta guía
de decisiones y querés colaborar con manifests probados, abrí un issue en
[soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha/issues)
contando tu setup objetivo (cloud, Postgres, embedder) y armamos el quick start juntos.
