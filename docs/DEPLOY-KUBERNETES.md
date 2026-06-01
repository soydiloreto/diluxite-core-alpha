# Diluxite — Deploy en Kubernetes

> **Estado:** doc con decisiones tomadas (sin manifests todavía). La validación
> end-to-end se hace en `kind` local antes de publicar manifests definitivos.
> Ver [Estado y próximos pasos](#estado-y-próximos-pasos).

Esta guía es para empresas que quieren correr Diluxite en su propio cluster
Kubernetes en vez de single-machine con `install.sh` (Docker Compose).

Si solo querés probar Diluxite, usá el [`install.sh`](../README.md#correr-en-local) —
levanta el stack completo en 5 minutos. K8s tiene sentido para empresas con
cluster propio, equipos SRE, requisitos de HA y compliance.

## Cuándo elegir Kubernetes

Tiene sentido si vas a:

- Correrlo para una organización con **decenas o miles de usuarios** (server mode).
- Querés **HA** (réplicas de API, web, Postgres gestionado).
- Ya tenés stack K8s (GitOps, observability, secrets management) y querés que
  Diluxite encaje ahí en vez de ser un container suelto.
- Necesitás integrar con **Postgres gestionado** por requisitos de compliance,
  backup centralizado, etc.

Si nada de eso aplica, `install.sh` te da el mismo motor con mucho menos overhead.

## Receta oficial — Diluxite enterprise en Azure (AKS)

Estas son las decisiones recomendadas para una empresa Azure. Si tu cloud es
otro (AWS / GCP / on-prem), las elecciones cambian de proveedor pero el patrón
es el mismo — pedí al final del doc que armemos la variante de tu cloud.

### 1. Postgres → Azure Database for PostgreSQL Flexible Server

**Gestionado**, no in-cluster. Backup, HA, point-in-time recovery, monitoring,
patches vienen incluidos — cero DB ops para tu equipo.

Requisitos:
- Activá la extensión **`vector`** (Settings → Server parameters → `azure.extensions` → add `vector`). Sin esto la búsqueda semántica no anda.
- SKU mínimo recomendado: **B2ms** (2 vCPU, 4 GB RAM) para PoC; **D4ds_v5** o superior para producción con tráfico real.
- Private endpoint en la misma VNet que el AKS para no exponer la DB a internet.
- High availability (zone-redundant) si tu plan lo justifica.

La connection string completa va a un Secret en el cluster (ver punto 5).

> **¿Por qué no in-cluster?** Hacer DB ops en K8s (CloudNativePG operator, backups
> a object storage, restores, upgrades) es un proyecto en sí mismo. Solo tiene
> sentido si ya tenés ese expertise. Para Diluxite enterprise, usá DBaaS.

### 2. Embeddings → Azure OpenAI

**Gestionado**, no Ollama in-cluster.

Requisitos:
- Crear un recurso **Azure OpenAI** en la región más cercana al AKS.
- Hacer deployment del modelo **`text-embedding-3-large`** (1536 o 3072 dims).
- Tomar nota de: endpoint (`https://<recurso>.openai.azure.com`), key, deployment name.

Las 3 cosas van a Secret en el cluster.

> **¿Por qué no Ollama in-cluster?** Para producción enterprise: Ollama
> necesita GPU node pool o CPU pesada, el modelo (~669 MB) tiene que estar en
> un volumen, manage version del modelo, etc. Azure OpenAI te da latencia baja,
> cuotas claras, top quality model, sin infra extra. Vale la pena el costo.
>
> Solo elegí Ollama in-cluster si tenés un requisito explícito de no enviar
> datos a OpenAI/Azure (ej. air-gapped, datos clasificados). Si ese es el caso,
> el doc se extiende — abrí un issue.

### 3. Auth mode → `server`

Multi-usuario con email + password, sesiones opacas + Bearer tokens, opcional
passkeys (WebAuthn). En K8s siempre es `server`. El admin inicial se configura
via env vars `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` desde un Secret.

`local` mode no tiene sentido en K8s (es passwordless single-user para tu PC personal).

### 4. Packaging → manifests YAML crudos primero, Helm chart después

**Hoy:** publicamos manifests YAML crudos para que entiendas qué hace cada pieza
y puedas adaptarlos a tu cluster.

**Mañana:** una vez los manifests están validados en `kind` y en un AKS real,
los empaquetamos como **Helm chart** publicado en
`soydiloreto/diluxite-helm`, con `values.yaml` parametrizable para Postgres host,
admin email, Azure OpenAI endpoint, réplicas, ingress host, etc.

Helm es el "apt/npm de Kubernetes": un chart te permite hacer
```bash
helm install diluxite diluxite/diluxite \
  --set postgres.host=mi-server.postgres.database.azure.com \
  --set adminEmail=admin@empresa.com \
  --set azureOpenAI.endpoint=https://mi-recurso.openai.azure.com
```
y todo se levanta. Hasta entonces, los manifests crudos sirven como referencia
para `kubectl apply -f`.

### 5. Packaging de la app → api y web separados (NO all-in-one)

En K8s usá las imágenes **separadas**:
- `soydiloreto/diluxite-api:1.0.0-alpha.9` (o tag rolling `:next` / `:latest`)
- `soydiloreto/diluxite-web:1.0.0-alpha.9`

NO uses `soydiloreto/diluxite` (all-in-one) — sirve para Docker Compose
single-machine, pero en K8s perdés la capacidad de escalar api y web
independientemente, hacer rolling updates por separado, aplicar network
policies por workload.

### 6. Secrets — empezá simple, escalá si la empresa lo pide

Filosofía: **aceptable en seguridad sin volvernos locos**. Default sano para
arrancar, opciones de hardening cuando hagan falta.

**Default recomendado: `Secret` nativos de K8s.**
- Los 4 secretos viven como `Secret` resources en el cluster:
  `diluxite-admin-email`, `diluxite-admin-password`,
  `diluxite-postgres-connstring`, `diluxite-azure-openai-key`.
- Están en base64 (no encriptados), pero el RBAC del cluster limita quién los lee.
  Para la mayoría de empresas eso es suficiente.
- Los YAMLs con secrets **NO van a Git** — se aplican con `kubectl apply -f` desde
  un secret manager local o pipeline CI.

**Hardening opcional (si la empresa lo pide):**

| Mejora | Cuándo agregarla |
|---|---|
| **[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets)** | Querés tener los secrets en Git encriptados (GitOps puro). Instalás el controller en el cluster, encriptás con su clave pública, commiteás. Bajo overhead. |
| **[External Secrets Operator](https://external-secrets.io) + Azure Key Vault** | Tu empresa ya tiene Key Vault corporativo con rotación/audit. Setup más complejo pero los secretos nunca salen del Vault al filesystem. Para enterprise maduro. |

Empezá con `Secret` nativos. Si después de 3-6 meses la empresa pide hardening
formal, agregás Sealed Secrets o External Secrets según contexto. **No empieces
con External Secrets si todavía no tenés Key Vault.**

### 7. Updates — empezá manual, agregá automation cuando duela

Watchtower es para Docker Compose. En K8s tampoco hace falta full GitOps de
entrada.

**Default recomendado: actualización manual con `kubectl`.**

Cuando salga una nueva versión (te enteras por el banner amarillo en la UI
o porque te suscribiste a los releases del repo en GitHub):

```bash
# Apuntar al nuevo tag
kubectl set image deployment/diluxite-api diluxite-api=soydiloreto/diluxite-api:1.0.0-alpha.10
kubectl set image deployment/diluxite-web diluxite-web=soydiloreto/diluxite-web:1.0.0-alpha.10

# O si ya está con :next y querés forzar pull de la última
kubectl rollout restart deployment/diluxite-api
kubectl rollout restart deployment/diluxite-web

# Ver el estado del rollout
kubectl rollout status deployment/diluxite-api
```

Acción consciente, queda en el shell history o en tu pipeline CI. Para
rollback: `kubectl rollout undo deployment/diluxite-api`.

**Automation opcional (si lo necesitás):**

| Mejora | Cuándo agregarla |
|---|---|
| **[Renovate](https://docs.renovatebot.com/)** abriendo PRs en tu repo de manifests cuando hay versión nueva | Querés automatizar el "te enteraste de la nueva versión" sin GitOps todavía. El humano sigue aprobando, pero no tiene que monitorear Docker Hub. |
| **GitOps con [Flux](https://fluxcd.io) o [ArgoCD](https://argo-cd.readthedocs.io) + Renovate** | Tu empresa ya tiene GitOps para otras apps. Combina con Renovate para ciclo completo: PR → merge → Flux aplica. Para equipos SRE maduros. |

Empezá con `kubectl set image` manual. Es **aceptable y trazable** sin más infra.

## Quick start (PoC en `kind`)

> **Pendiente** — los manifests YAML se publican después de validarlos
> end-to-end en `kind` local. Ver [estado](#estado-y-próximos-pasos).

Outline planeado:

1. `brew install kind && kind create cluster --name diluxite`
2. **Postgres en kind** (CloudNativePG operator o StatefulSet simple — para PoC
   está bien in-cluster; en producción Azure es Flexible Server).
3. `Deployment` + `Service` para `diluxite-api` (1 réplica, env vars desde
   ConfigMap, secrets desde Secret en plano — para PoC).
4. `Deployment` + `Service` para `diluxite-web` (2 réplicas).
5. `Ingress` (nginx ingress controller) ruteando `/api` → api-service y `/` → web-service.
6. `Secret` con admin email + password + Azure OpenAI key (para el PoC, secret
   en plano — en producción se reemplaza por ExternalSecret).
7. Bootstrap: el admin se crea solo en el primer boot del api pod (idempotente).
8. Smoke test: navegar al Ingress, login con admin, crear nota, búsqueda semántica.

## Producción Azure (AKS) — versión "aceptable, no enterprise hardcore"

> **Pendiente** — se documenta después del PoC con manifests probados.

Outline planeado para una producción **saludable sin pasarse de rosca**:

- **AKS** con node pool standard (3 nodos D4s_v5 alcanza para empezar).
- **Azure DB for PostgreSQL Flexible Server** con extensión `vector` + private
  endpoint en la VNet del AKS. Backup automático del servicio (incluido en SLA).
- **Azure OpenAI** con deployment `text-embedding-3-large`.
- 2-3 réplicas de api, 2 de web (HPA opcional — agregar cuando haya carga real).
- **`Secret` nativos de K8s** para los 4 valores sensibles, aplicados con
  `kubectl` desde un pipeline o desde la máquina del operador. Sealed Secrets
  o External Secrets cuando la empresa pida hardening formal.
- **Updates manuales con `kubectl set image`** cuando salga nueva versión.
  Suscribirse a los releases del repo en GitHub para enterarse. Automation
  (Renovate / GitOps) cuando el ciclo manual moleste.
- Ingress con TLS via cert-manager + Let's Encrypt (gratis) o Azure Application
  Gateway (si la empresa ya tiene).
- Network Policies básicas: api solo accesible desde web e ingress; postgres
  solo desde api. (Skip si no estás familiarizado con Network Policies — no es
  bloqueante para arrancar.)
- Observability cuando haga falta: logs a Azure Monitor / Log Analytics (el
  driver de AKS lo trae). Metrics más adelante.

Filosofía: arrancar con lo mínimo "saludable" y agregar capas conforme la
empresa madure el deployment. No imponer GitOps + ExternalSecrets + HPA + NetworkPolicies + Helm
de entrada — eso espanta al sysadmin promedio.

## Helm chart

> **Roadmap.** Una vez los manifests crudos estén validados en `kind` y en
> un AKS real, los empaquetamos como Helm chart oficial en
> `soydiloreto/diluxite-helm` (repo separado) con `values.yaml` parametrizable
> para las 7 decisiones de arriba. Hasta entonces, los manifests crudos sirven
> como referencia.

## Otros clouds (no-Azure)

La receta de arriba es Azure-first porque Diluxite Cloud va a correr ahí. Si tu
cluster está en otro cloud, los componentes mappean directo:

| Pieza | Azure | AWS | GCP | On-prem |
|---|---|---|---|---|
| Cluster | AKS | EKS | GKE | k3s / RKE2 / kubeadm |
| Postgres + vector | Azure DB for PostgreSQL Flexible Server | Aurora PostgreSQL (con extensión `vector`) | CloudSQL for PostgreSQL | CloudNativePG operator |
| Embeddings | Azure OpenAI | Bedrock (Cohere/Titan) o OpenAI directo | Vertex AI | Ollama in-cluster |
| Ingress TLS | Application Gateway + cert-manager | ALB + cert-manager | GKE Ingress + Managed Certs | nginx + cert-manager + Let's Encrypt |
| Secrets (hardening opcional) | Azure Key Vault + ExternalSecrets | AWS Secrets Manager + ExternalSecrets | GCP Secret Manager + ExternalSecrets | HashiCorp Vault o Sealed Secrets |

Para arrancar usá `Secret` nativos + `kubectl set image` manual en cualquier cloud
— el hardening (vault, GitOps) es opcional y se agrega cuando la empresa lo pida.

Si vas a deployar en AWS/GCP/on-prem y querés una receta validada, abrí un
issue contando tu setup y armamos esa variante.

## Estado y próximos pasos

| Pieza | Estado |
|---|---|
| Decisiones de diseño tomadas (las 7) | ✅ Este doc |
| Manifests YAML crudos para `kind` (PoC) | ⏳ Pendiente — próximo paso |
| Validación end-to-end en `kind` local | ⏳ Pendiente |
| Manifests para producción Azure (Postgres gestionado, ExternalSecrets, GitOps) | ⏳ Pendiente — depende del PoC |
| Validación end-to-end en AKS real | ⏳ Pendiente |
| Helm chart oficial | ⏳ Pendiente — después de validar manifests crudos |
| Receta para AWS / GCP / on-prem | ⏳ Pendiente — bajo demanda (issue) |

**No publicamos manifests YAML "best guess" sin validar.** Si te sirvió esta guía
de decisiones y querés colaborar con manifests probados, abrí un issue en
[soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha/issues)
contando tu setup objetivo y armamos el quick start juntos.
