#!/usr/bin/env bash
# ==============================================================================
# Diluxite installer — Linux / macOS / WSL2
#
# What it does:
#   1. Detects platform (linux / wsl / macos).
#   2. Validates pre-requisites: docker daemon up, compose v2, ports free,
#      enough disk for embeddings model.
#   3. Prompts for:
#        - data directory (bind-mount path)
#        - embedder: deterministic / Ollama (default mxbai-embed-large:335m)
#                    / Azure OpenAI
#        - seed: empty vault or 1500-note demo corpus
#   4. If Ollama: checks `ollama` is installed in host, pulls the model.
#   5. Generates docker-compose.yml from docker-compose.template.yml with
#      placeholders substituted.
#   6. Pulls images and brings the stack up.
#   7. (Optional) Triggers the seed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
#   or
#   bash install.sh
# ==============================================================================
set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()   { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()     { echo -e "${GREEN}[OK]${NC} $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()    { echo -e "${RED}[ERROR]${NC} $*"; }
header() { echo -e "\n${CYAN}${BOLD}═══ $* ═══${NC}\n"; }

# ─── Repo metadata (substituted at release time if needed) ──────────────────
DILUXITE_REPO_RAW="https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"
DEFAULT_VERSION="latest"  # users can override with DILUXITE_VERSION=4.10.0 ./install.sh

# ─── Platform detection ─────────────────────────────────────────────────────
detect_platform() {
  if grep -qi microsoft /proc/version 2>/dev/null; then
    echo "wsl"
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "linux"
  else
    echo "unknown"
  fi
}
PLATFORM=$(detect_platform)

# ─── Banner ─────────────────────────────────────────────────────────────────
header "Diluxite Installer"
echo -e "La memoria de tu IA, en tu maquina. Self-host, multi-tenant, AGPL-3.0.\n"

if [ "$(id -u)" -eq 0 ]; then
  err "No ejecutes este script como root. Usa un usuario con sudo."
  exit 1
fi

ok "Plataforma: ${PLATFORM}"

if [ "${PLATFORM}" = "unknown" ]; then
  warn "Plataforma no reconocida. Este script funciona en Linux, macOS y WSL2."
  read -rp "Continuar de todas formas? [y/N]: " FORCE
  [[ "${FORCE}" =~ ^[Yy]$ ]] || exit 1
fi

# ─── Pre-requisites ─────────────────────────────────────────────────────────
header "1 / 6 — Verificando pre-requisitos"

if ! command -v docker &>/dev/null; then
  err "Docker no esta instalado."
  case "${PLATFORM}" in
    linux|wsl)
      info "Instalar Docker: curl -fsSL https://get.docker.com | sh"
      info "Luego: sudo usermod -aG docker \$USER  (reabrir la sesion)"
      ;;
    macos)
      info "Instalar Docker Desktop: https://www.docker.com/products/docker-desktop/"
      ;;
  esac
  exit 1
fi
ok "docker presente: $(docker --version)"

if ! docker info >/dev/null 2>&1; then
  err "El daemon de Docker no esta corriendo."
  case "${PLATFORM}" in
    linux|wsl) info "Arrancalo: sudo systemctl start docker" ;;
    macos)     info "Abri Docker Desktop y espera que arranque." ;;
  esac
  exit 1
fi
ok "Daemon de Docker en marcha"

if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 no esta disponible."
  info "Necesitas Docker Engine reciente o Docker Desktop reciente (compose viene incluido)."
  exit 1
fi
ok "docker compose v2 disponible"

# Port availability
for port in 3030 5173 5432; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\b" \
     || lsof -iTCP:${port} -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN; then
    err "El puerto ${port} esta ocupado."
    info "Liberalo o cambia el mapping en docker-compose.yml luego de instalar."
    exit 1
  fi
done
ok "Puertos 3030 / 5173 / 5432 libres"

# Disk space — mxbai-embed-large weighs ~669MB plus the images (~600MB
# total once pulled) plus the user's data. Insist on at least 3GB free.
free_mb=$(df -m . | tail -1 | awk '{print $4}')
if [ "${free_mb}" -lt 3000 ]; then
  err "Espacio libre insuficiente (${free_mb} MB). Diluxite necesita al menos 3 GB."
  exit 1
fi
ok "Espacio libre: ${free_mb} MB"

# ─── Data directory ─────────────────────────────────────────────────────────
header "2 / 6 — Donde guardar los datos"

default_data="${HOME}/diluxite/data"
echo "Diluxite va a guardar tus notas, la base de datos y la configuracion"
echo "en una carpeta en tu disco. Podes cambiarla ahora o dejar la default."
echo ""
read -rp "Ruta para los datos [${default_data}]: " DATA_PATH
DATA_PATH="${DATA_PATH:-${default_data}}"
mkdir -p "${DATA_PATH}/postgres"
ok "Datos en: ${DATA_PATH}"

# ─── Install directory ──────────────────────────────────────────────────────
default_install="${HOME}/diluxite"
read -rp "Ruta de instalacion (donde va docker-compose.yml) [${default_install}]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-${default_install}}"
mkdir -p "${INSTALL_DIR}"
ok "Instalacion en: ${INSTALL_DIR}"

# ─── Embedder ───────────────────────────────────────────────────────────────
header "3 / 6 — Embeddings (motor semantico)"
echo "Que motor querés usar para los embeddings de busqueda semantica?"
echo ""
echo "  1) Ollama local con mxbai-embed-large (RECOMENDADO)"
echo "     - Calidad alta, multilenguaje, sin claves, sin internet"
echo "     - 669 MB de modelo (one-time)"
echo "     - Requiere Ollama instalado en el host"
echo ""
echo "  2) Azure OpenAI (calidad maxima, requiere cuenta + costo por token)"
echo ""
echo "  3) Deterministico local (sin calidad semantica — para probar o CI)"
echo ""
read -rp "Opcion [1]: " EMB_OPT
EMB_OPT=${EMB_OPT:-1}

OLLAMA_MODEL=""
OLLAMA_DIMS=""
OLLAMA_ENDPOINT=""
AZURE_ENDPOINT=""
AZURE_KEY=""
AZURE_DEPLOYMENT=""

case "${EMB_OPT}" in
  1)
    if ! command -v ollama &>/dev/null; then
      err "Ollama no esta instalado en el host."
      case "${PLATFORM}" in
        linux|wsl) info "Instalalo: curl -fsSL https://ollama.com/install.sh | sh" ;;
        macos)     info "Descargalo: https://ollama.com/download" ;;
      esac
      info "Despues, volvé a correr este installer."
      exit 1
    fi
    ok "Ollama presente: $(ollama --version | head -1)"

    info "Bajando el modelo mxbai-embed-large (~669 MB, una sola vez)..."
    ollama pull mxbai-embed-large:335m
    ok "Modelo descargado"

    OLLAMA_MODEL="mxbai-embed-large:335m"
    OLLAMA_DIMS="1024"
    # On macOS/WSL with Docker Desktop, host.docker.internal resolves to
    # the host. On native Linux without Docker Desktop, we need the host
    # gateway IP — `host.docker.internal` is enabled via extra_hosts in
    # newer Docker. For now we default to it; if it fails, the user can
    # adjust OLLAMA_ENDPOINT in docker-compose.yml.
    OLLAMA_ENDPOINT="http://host.docker.internal:11434"
    ;;
  2)
    read -rp "Azure OpenAI endpoint (https://<recurso>.openai.azure.com): " AZURE_ENDPOINT
    read -rsp "Azure OpenAI API key: " AZURE_KEY; echo
    read -rp "Deployment name [text-embedding-3-large]: " AZURE_DEPLOYMENT
    AZURE_DEPLOYMENT=${AZURE_DEPLOYMENT:-text-embedding-3-large}
    ok "Azure OpenAI configurado (claves nunca salen de este archivo)"
    ;;
  3)
    warn "Embedder deterministico: util para probar, baja calidad semantica."
    ;;
  *)
    err "Opcion invalida: ${EMB_OPT}"; exit 1 ;;
esac

# ─── Seed ───────────────────────────────────────────────────────────────────
header "4 / 6 — Datos iniciales"
echo "Empezar con:"
echo ""
echo "  1) Vault vacio"
echo "  2) Seed demo (1500 notas tecnicas — utiles para explorar)"
echo ""
read -rp "Opcion [1]: " SEED_OPT
SEED_OPT=${SEED_OPT:-1}

# ─── Generate docker-compose.yml ────────────────────────────────────────────
header "5 / 6 — Generando configuracion"

VERSION="${DILUXITE_VERSION:-${DEFAULT_VERSION}}"
info "Pin a version: ${VERSION}"

template_path="${INSTALL_DIR}/docker-compose.template.yml"
compose_path="${INSTALL_DIR}/docker-compose.yml"

# Pull the template from the repo. If we are running from a clone, use the
# local file instead.
if [ -f "$(dirname "$0")/docker-compose.template.yml" ]; then
  cp "$(dirname "$0")/docker-compose.template.yml" "${template_path}"
else
  curl -fsSL "${DILUXITE_REPO_RAW}/docker-compose.template.yml" -o "${template_path}"
fi

# Substitute placeholders. sed with a non-/ delimiter to handle paths
# containing slashes.
sed -e "s|__DILUXITE_VERSION__|${VERSION}|g" \
    -e "s|__DATA_PATH__|${DATA_PATH}|g" \
    -e "s|__OLLAMA_MODEL__|${OLLAMA_MODEL}|g" \
    -e "s|__OLLAMA_DIMS__|${OLLAMA_DIMS}|g" \
    -e "s|__OLLAMA_ENDPOINT__|${OLLAMA_ENDPOINT}|g" \
    -e "s|__AZURE_ENDPOINT__|${AZURE_ENDPOINT}|g" \
    -e "s|__AZURE_KEY__|${AZURE_KEY}|g" \
    -e "s|__AZURE_DEPLOYMENT__|${AZURE_DEPLOYMENT}|g" \
    "${template_path}" > "${compose_path}"

# If Ollama on native Linux, add extra_hosts so the api container can
# reach the host via host.docker.internal.
if [ "${EMB_OPT}" = "1" ] && [ "${PLATFORM}" = "linux" ]; then
  python3 - <<'PY' "${compose_path}"
import sys, re
path = sys.argv[1]
src = open(path).read()
patched = re.sub(
    r"(  api:\n(?:    [^\n]+\n)*)",
    r"\1    extra_hosts:\n      - \"host.docker.internal:host-gateway\"\n",
    src,
    count=1,
)
open(path, "w").write(patched)
PY
fi

ok "docker-compose.yml generado"

# ─── Up ─────────────────────────────────────────────────────────────────────
header "6 / 6 — Levantando Diluxite"

cd "${INSTALL_DIR}"
info "Pulleando imagenes desde Docker Hub (multi-arch)..."
docker compose pull
info "Arrancando..."
docker compose up -d
ok "Containers en marcha"

# Wait for API health
info "Esperando que la API este healthy..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:3030/health >/dev/null 2>&1; then
    ok "API saludable en http://localhost:3030"
    break
  fi
  sleep 2
  if [ "${i}" -eq 60 ]; then
    err "API no respondio en 2 minutos. Verifica los logs: docker compose logs api"
    exit 1
  fi
done

# Seed
if [ "${SEED_OPT}" = "2" ]; then
  info "Cargando seed demo (1500 notas)... esto tarda unos minutos."
  docker compose exec -T api pnpm seed || warn "El seed fallo — podes correrlo despues con: docker compose exec api pnpm seed"
fi

# ─── Done ───────────────────────────────────────────────────────────────────
header "Listo"
echo "Abri http://localhost:5173 para empezar."
echo ""
echo "Comandos utiles (desde ${INSTALL_DIR}):"
echo "  docker compose logs -f api      # ver logs de la API"
echo "  docker compose down             # detener todo (datos se mantienen)"
echo "  docker compose pull && docker compose up -d   # actualizar manualmente"
echo "  docker compose --profile autoupdate up -d     # activar auto-update via Watchtower"
echo ""
echo "Datos: ${DATA_PATH}"
echo "Backup: copiar esa carpeta entera."
