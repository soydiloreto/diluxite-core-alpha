# Diluxite — Kubernetes Deployment

> **Status:** doc with decisions made (no manifests yet). End-to-end
> validation is done on local `kind` before publishing the final manifests.
> See [Status and next steps](#status-and-next-steps).

This guide is for companies that want to run Diluxite on their own Kubernetes
cluster instead of single-machine with `install.sh` (Docker Compose).

If you just want to try Diluxite, use [`install.sh`](../README.md#correr-en-local) —
it brings up the full stack in 5 minutes. K8s makes sense for companies with
their own cluster, SRE teams, and HA and compliance requirements.

## When to choose Kubernetes

It makes sense if you're going to:

- Run it for an organization with **tens or thousands of users** (server mode).
- Want **HA** (replicas of API, web, managed Postgres).
- Already have a K8s stack (GitOps, observability, secrets management) and want
  Diluxite to fit in there instead of being a standalone container.
- Need to integrate with **managed Postgres** due to compliance requirements,
  centralized backup, etc.

If none of that applies, `install.sh` gives you the same engine with far less overhead.

## Official recipe — Diluxite enterprise on Azure (AKS)

These are the recommended decisions for an Azure company. If your cloud is a
different one (AWS / GCP / on-prem), the choices change provider but the pattern
is the same — ask at the end of the doc and we'll put together the variant for your cloud.

### 1. Postgres → Azure Database for PostgreSQL Flexible Server

**Managed**, not in-cluster. Backup, HA, point-in-time recovery, monitoring,
and patches come included — zero DB ops for your team.

Requirements:
- Enable the **`vector`** extension (Settings → Server parameters → `azure.extensions` → add `vector`). Without this, semantic search won't work.
- Minimum recommended SKU: **B2ms** (2 vCPU, 4 GB RAM) for PoC; **D4ds_v5** or higher for production with real traffic.
- Private endpoint in the same VNet as the AKS to avoid exposing the DB to the internet.
- High availability (zone-redundant) if your plan justifies it.

The full connection string goes to a Secret in the cluster (see point 5).

> **Why not in-cluster?** Doing DB ops in K8s (CloudNativePG operator, backups
> to object storage, restores, upgrades) is a project in itself. It only makes
> sense if you already have that expertise. For Diluxite enterprise, use DBaaS.

### 2. Embeddings → Azure OpenAI

**Managed**, not Ollama in-cluster.

Requirements:
- Create an **Azure OpenAI** resource in the region closest to the AKS.
- Deploy the **`text-embedding-3-large`** model (1536 or 3072 dims).
- Make a note of: endpoint (`https://<resource>.openai.azure.com`), key, deployment name.

All 3 go to a Secret in the cluster.

> **Why not Ollama in-cluster?** For enterprise production: Ollama needs a GPU
> node pool or heavy CPU, the model (~669 MB) has to live on a volume, you have
> to manage the model version, etc. Azure OpenAI gives you low latency, clear
> quotas, a top-quality model, and no extra infra. It's worth the cost.
>
> Only choose Ollama in-cluster if you have an explicit requirement not to send
> data to OpenAI/Azure (e.g. air-gapped, classified data). If that's the case,
> the doc gets extended — open an issue.

### 3. Auth mode → `server`

Multi-user with email + password, opaque sessions + Bearer tokens, optional
passkeys (WebAuthn). In K8s it's always `server`. The initial admin is configured
via env vars `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` from a Secret.

`local` mode doesn't make sense in K8s (it's passwordless single-user for your personal PC).

### 4. Packaging → raw YAML manifests first, Helm chart later

**Today:** we publish raw YAML manifests so you understand what each piece does
and can adapt them to your cluster.

**Tomorrow:** once the manifests are validated on `kind` and on a real AKS,
we package them as a **Helm chart** published at
`soydiloreto/diluxite-helm`, with a parameterizable `values.yaml` for Postgres host,
admin email, Azure OpenAI endpoint, replicas, ingress host, etc.

Helm is the "apt/npm of Kubernetes": a chart lets you do
```bash
helm install diluxite diluxite/diluxite \
  --set postgres.host=mi-server.postgres.database.azure.com \
  --set adminEmail=admin@empresa.com \
  --set azureOpenAI.endpoint=https://mi-recurso.openai.azure.com
```
and everything comes up. Until then, the raw manifests serve as a reference
for `kubectl apply -f`.

### 5. App packaging → api and web separate (NOT all-in-one)

In K8s use the **separate** images:
- `soydiloreto/diluxite-api:1.0.0-alpha.9` (or rolling tag `:next` / `:latest`)
- `soydiloreto/diluxite-web:1.0.0-alpha.9`

Do NOT use `soydiloreto/diluxite` (all-in-one) — it's good for Docker Compose
single-machine, but in K8s you lose the ability to scale api and web
independently, do separate rolling updates, and apply network policies per
workload.

### 6. Secrets — start simple, scale up if the company asks for it

Philosophy: **acceptable on security without going crazy**. A sane default to
get started, hardening options when they're needed.

**Recommended default: native K8s `Secret`s.**
- The 4 secrets live as `Secret` resources in the cluster:
  `diluxite-admin-email`, `diluxite-admin-password`,
  `diluxite-postgres-connstring`, `diluxite-azure-openai-key`.
- They're in base64 (not encrypted), but the cluster's RBAC limits who reads them.
  For most companies that's enough.
- The YAMLs with secrets do **NOT go to Git** — they're applied with `kubectl apply -f` from
  a local secret manager or CI pipeline.

**Optional hardening (if the company asks for it):**

| Improvement | When to add it |
|---|---|
| **[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets)** | You want to keep the secrets in Git encrypted (pure GitOps). You install the controller in the cluster, encrypt with its public key, commit. Low overhead. |
| **[External Secrets Operator](https://external-secrets.io) + Azure Key Vault** | Your company already has a corporate Key Vault with rotation/audit. More complex setup but the secrets never leave the Vault to the filesystem. For mature enterprise. |

Start with native `Secret`s. If after 3-6 months the company asks for formal
hardening, you add Sealed Secrets or External Secrets depending on context. **Don't start
with External Secrets if you don't have a Key Vault yet.**

### 7. Updates — start manual, add automation when it hurts

Watchtower is for Docker Compose. In K8s you don't need full GitOps off the bat
either.

**Recommended default: manual update with `kubectl`.**

When a new version comes out (you find out from the yellow banner in the UI
or because you subscribed to the repo's releases on GitHub):

```bash
# Point to the new tag
kubectl set image deployment/diluxite-api diluxite-api=soydiloreto/diluxite-api:1.0.0-alpha.10
kubectl set image deployment/diluxite-web diluxite-web=soydiloreto/diluxite-web:1.0.0-alpha.10

# Or if it's already on :next and you want to force a pull of the latest
kubectl rollout restart deployment/diluxite-api
kubectl rollout restart deployment/diluxite-web

# Check the rollout status
kubectl rollout status deployment/diluxite-api
```

A deliberate action, recorded in the shell history or in your CI pipeline. For
rollback: `kubectl rollout undo deployment/diluxite-api`.

**Optional automation (if you need it):**

| Improvement | When to add it |
|---|---|
| **[Renovate](https://docs.renovatebot.com/)** opening PRs in your manifests repo when there's a new version | You want to automate the "you found out about the new version" without GitOps yet. The human still approves, but doesn't have to monitor Docker Hub. |
| **GitOps with [Flux](https://fluxcd.io) or [ArgoCD](https://argo-cd.readthedocs.io) + Renovate** | Your company already has GitOps for other apps. Combine with Renovate for a full cycle: PR → merge → Flux applies. For mature SRE teams. |

Start with manual `kubectl set image`. It's **acceptable and traceable** without more infra.

## Quick start (PoC on `kind`)

> **Pending** — the YAML manifests are published after validating them
> end-to-end on local `kind`. See [status](#status-and-next-steps).

Planned outline:

1. `brew install kind && kind create cluster --name diluxite`
2. **Postgres on kind** (CloudNativePG operator or simple StatefulSet — for PoC
   in-cluster is fine; in Azure production it's Flexible Server).
3. `Deployment` + `Service` for `diluxite-api` (1 replica, env vars from
   ConfigMap, secrets from Secret in plaintext — for PoC).
4. `Deployment` + `Service` for `diluxite-web` (2 replicas).
5. `Ingress` (nginx ingress controller) routing `/api` → api-service and `/` → web-service.
6. `Secret` with admin email + password + Azure OpenAI key (for the PoC, secret
   in plaintext — in production it's replaced by ExternalSecret).
7. Bootstrap: the admin is created automatically on the first boot of the api pod (idempotent).
8. Smoke test: navigate to the Ingress, log in with admin, create a note, semantic search.

## Azure production (AKS) — "acceptable, not enterprise hardcore" version

> **Pending** — documented after the PoC with tested manifests.

Planned outline for a **healthy production without going overboard**:

- **AKS** with a standard node pool (3 D4s_v5 nodes is enough to start).
- **Azure DB for PostgreSQL Flexible Server** with the `vector` extension + private
  endpoint in the AKS's VNet. Automatic backup from the service (included in the SLA).
- **Azure OpenAI** with a `text-embedding-3-large` deployment.
- 2-3 api replicas, 2 web (HPA optional — add when there's real load).
- **Native K8s `Secret`s** for the 4 sensitive values, applied with
  `kubectl` from a pipeline or from the operator's machine. Sealed Secrets
  or External Secrets when the company asks for formal hardening.
- **Manual updates with `kubectl set image`** when a new version comes out.
  Subscribe to the repo's releases on GitHub to find out. Automation
  (Renovate / GitOps) when the manual cycle becomes a nuisance.
- Ingress with TLS via cert-manager + Let's Encrypt (free) or Azure Application
  Gateway (if the company already has it).
- Basic Network Policies: api only accessible from web and ingress; postgres
  only from api. (Skip if you're not familiar with Network Policies — it's not
  a blocker to get started.)
- Observability when needed: logs to Azure Monitor / Log Analytics (the
  AKS driver brings it). Metrics later.

Philosophy: start with the minimum "healthy" setup and add layers as the
company matures the deployment. Don't impose GitOps + ExternalSecrets + HPA + NetworkPolicies + Helm
off the bat — that scares off the average sysadmin.

## Helm chart

> **Roadmap.** Once the raw manifests are validated on `kind` and on a real
> AKS, we package them as an official Helm chart at
> `soydiloreto/diluxite-helm` (separate repo) with a parameterizable `values.yaml`
> for the 7 decisions above. Until then, the raw manifests serve
> as a reference.

## Other clouds (non-Azure)

The recipe above is Azure-first because Diluxite Cloud is going to run there. If your
cluster is on another cloud, the components map directly:

| Piece | Azure | AWS | GCP | On-prem |
|---|---|---|---|---|
| Cluster | AKS | EKS | GKE | k3s / RKE2 / kubeadm |
| Postgres + vector | Azure DB for PostgreSQL Flexible Server | Aurora PostgreSQL (with `vector` extension) | CloudSQL for PostgreSQL | CloudNativePG operator |
| Embeddings | Azure OpenAI | Bedrock (Cohere/Titan) or OpenAI directly | Vertex AI | Ollama in-cluster |
| Ingress TLS | Application Gateway + cert-manager | ALB + cert-manager | GKE Ingress + Managed Certs | nginx + cert-manager + Let's Encrypt |
| Secrets (optional hardening) | Azure Key Vault + ExternalSecrets | AWS Secrets Manager + ExternalSecrets | GCP Secret Manager + ExternalSecrets | HashiCorp Vault or Sealed Secrets |

To get started use native `Secret`s + manual `kubectl set image` on any cloud
— the hardening (vault, GitOps) is optional and added when the company asks for it.

If you're going to deploy on AWS/GCP/on-prem and want a validated recipe, open an
issue describing your setup and we'll put together that variant.

## Status and next steps

| Piece | Status |
|---|---|
| Design decisions made (the 7) | ✅ This doc |
| Raw YAML manifests for `kind` (PoC) | ⏳ Pending — next step |
| End-to-end validation on local `kind` | ⏳ Pending |
| Manifests for Azure production (managed Postgres, ExternalSecrets, GitOps) | ⏳ Pending — depends on the PoC |
| End-to-end validation on real AKS | ⏳ Pending |
| Official Helm chart | ⏳ Pending — after validating the raw manifests |
| Recipe for AWS / GCP / on-prem | ⏳ Pending — on demand (issue) |

**We don't publish "best guess" YAML manifests without validation.** If this
decisions guide was useful and you want to collaborate with tested manifests, open an issue at
[soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha/issues)
describing your target setup and we'll put together the quick start together.
