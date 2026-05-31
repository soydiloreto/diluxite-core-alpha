#!/usr/bin/env bash
# ==============================================================================
# Diluxite installer — Linux / macOS / WSL2 / Git Bash on Windows.
#
# One installer for every platform. In Windows the user runs this from WSL2
# (which Docker Desktop already requires) or Git Bash — there is no separate
# .ps1 to maintain.
#
# Flow:
#   1. Detect platform (linux / macos / wsl / gitbash).
#   2. Verify pre-requisites. If Docker is missing, open the official
#      download page in the user's browser and abort. We deliberately
#      DO NOT install Docker for the user — Docker Desktop on Mac/Windows
#      cannot be installed silently, and `get.docker.com` on Linux needs
#      sudo + group changes that we don't want to do behind the user's back.
#   3. Prompt for: data path, embedder (Ollama mxbai by default), seed.
#   4. If Ollama is selected and `ollama` is missing, offer to install it
#      automatically (Linux/macOS/WSL: `ollama install.sh`; Windows: opens
#      the download page).
#   5. Pull the model.
#   6. Generate docker-compose.yml from the all-in-one template + bring up.
#   7. Optional: trigger the 1500-note demo seed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
# ==============================================================================
set -euo pipefail

# When invoked via `curl ... | bash`, stdin is the script pipe — so any
# `read -rp` would consume the next line of the script itself instead of
# waiting for the user. We CANNOT do `exec < /dev/tty` here either: bash
# is reading the script from stdin, so redirecting stdin globally would
# cut off the rest of the script body. Instead, every `read` below uses
# `< "$TTY"` where TTY is the controlling terminal (or stdin if we already
# have one). Same pattern rustup, homebrew and others use.
TTY=/dev/stdin
if [ ! -t 0 ] && [ -r /dev/tty ]; then
  TTY=/dev/tty
fi

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()   { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()     { echo -e "${GREEN}[OK]${NC} $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()    { echo -e "${RED}[ERROR]${NC} $*"; }
header() { echo -e "\n${CYAN}${BOLD}═══ $* ═══${NC}\n"; }

# ─── Repo metadata ──────────────────────────────────────────────────────────
DILUXITE_REPO_RAW="https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"
DEFAULT_VERSION="latest"

# ─── Platform detection ─────────────────────────────────────────────────────
# Recognises: linux, macos, wsl (Linux under WSL2), gitbash (MINGW/MSYS on
# native Windows). For Docker Desktop in WSL2 the platform is `wsl`; for
# `bash install.sh` inside Git Bash it is `gitbash`.
detect_platform() {
  local kernel
  kernel="$(uname -s 2>/dev/null || echo unknown)"
  case "${kernel}" in
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo "wsl"
      else echo "linux"; fi ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "gitbash" ;;
    *) echo "unknown" ;;
  esac
}
PLATFORM=$(detect_platform)

# ─── Helpers ────────────────────────────────────────────────────────────────
# Open a URL in the user's default browser, cross-platform.
open_url() {
  local url="$1"
  case "${PLATFORM}" in
    linux)   xdg-open "${url}" >/dev/null 2>&1 || true ;;
    macos)   open "${url}" >/dev/null 2>&1 || true ;;
    wsl)     # WSL: prefer wslview if available, else cmd.exe.
             if command -v wslview &>/dev/null; then wslview "${url}" >/dev/null 2>&1 || true
             else cmd.exe /c start "" "${url}" >/dev/null 2>&1 || true; fi ;;
    gitbash) cmd //c start "" "${url}" >/dev/null 2>&1 || true ;;
  esac
}

# ─── Banner ─────────────────────────────────────────────────────────────────
header "Diluxite Installer"
echo -e "La memoria de tu IA, en tu maquina. Self-host, multi-tenant, AGPL-3.0.\n"

if [ "$(id -u 2>/dev/null || echo 1000)" -eq 0 ]; then
  err "No ejecutes este script como root. Usa un usuario con sudo."
  exit 1
fi

ok "Plataforma: ${PLATFORM}"

if [ "${PLATFORM}" = "unknown" ]; then
  warn "Plataforma no reconocida. Este script soporta Linux, macOS, WSL2 y Git Bash."
  read -rp "Continuar de todas formas? [y/N]: " FORCE <"$TTY"
  [[ "${FORCE}" =~ ^[Yy]$ ]] || exit 1
fi

# ─── Pre-requisites ─────────────────────────────────────────────────────────
header "1 / 7 — Verificando pre-requisitos"

# Docker missing → open browser to official install page + abort. We do not
# install Docker for the user (it requires sudo / GUI / restart of shell).
if ! command -v docker &>/dev/null; then
  err "Docker no esta instalado."
  case "${PLATFORM}" in
    macos|gitbash) url="https://www.docker.com/products/docker-desktop/" ;;
    wsl)           url="https://www.docker.com/products/docker-desktop/" ;;
    *)             url="https://docs.docker.com/engine/install/" ;;
  esac
  info "Abriendo: ${url}"
  open_url "${url}"
  info "Instala Docker, abrilo, y volvé a correr este script."
  exit 1
fi
ok "docker: $(docker --version)"

if ! docker info >/dev/null 2>&1; then
  err "El daemon de Docker no esta corriendo."
  case "${PLATFORM}" in
    linux) info "Arrancalo: sudo systemctl start docker" ;;
    *)     info "Abri Docker Desktop y espera que arranque." ;;
  esac
  exit 1
fi
ok "Daemon Docker en marcha"

if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 no esta disponible. Actualizá Docker."
  exit 1
fi
ok "docker compose v2 disponible"

# Port availability — silently skipped when neither ss nor lsof is around
# (e.g. Git Bash). Docker compose itself will error if a port is taken.
for port in 3030 5173 5432; do
  if command -v ss &>/dev/null && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\b"; then
    err "Puerto ${port} ocupado."; exit 1
  fi
  if command -v lsof &>/dev/null && lsof -iTCP:${port} -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN; then
    err "Puerto ${port} ocupado."; exit 1
  fi
done
ok "Puertos 3030 / 5173 / 5432 libres"

# Disk: mxbai-embed-large is ~669 MB and the all-in-one image is ~700 MB.
# Insist on ≥ 3 GB free as a safety margin.
free_mb=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}' || echo 999999)
if [ "${free_mb}" -lt 3000 ]; then
  err "Espacio libre insuficiente (${free_mb} MB). Diluxite necesita al menos 3 GB."
  exit 1
fi
ok "Espacio libre: ${free_mb} MB"

# ─── Data directory + install directory ─────────────────────────────────────
header "2 / 7 — Donde guardar los datos"

default_data="${HOME}/diluxite/data"
read -rp "Ruta para los datos [${default_data}]: " DATA_PATH <"$TTY"
DATA_PATH="${DATA_PATH:-${default_data}}"
mkdir -p "${DATA_PATH}/postgres"
ok "Datos en: ${DATA_PATH}"

default_install="${HOME}/diluxite"
read -rp "Ruta de instalacion (docker-compose.yml) [${default_install}]: " INSTALL_DIR <"$TTY"
INSTALL_DIR="${INSTALL_DIR:-${default_install}}"
mkdir -p "${INSTALL_DIR}"
ok "Instalacion en: ${INSTALL_DIR}"

# ─── Embedder ───────────────────────────────────────────────────────────────
header "3 / 7 — Embeddings (motor semantico)"
echo "  1) Ollama local con mxbai-embed-large (RECOMENDADO)"
echo "     Calidad alta, multilenguaje, sin claves, sin internet. 669 MB de modelo."
echo "  2) Azure OpenAI (calidad maxima, requiere cuenta + costo por token)"
echo "  3) Deterministico local (sin calidad semantica — solo para probar)"
echo ""
read -rp "Opcion [1]: " EMB_OPT <"$TTY"
EMB_OPT=${EMB_OPT:-1}

OLLAMA_MODEL=""; OLLAMA_DIMS=""; OLLAMA_ENDPOINT=""
AZURE_ENDPOINT=""; AZURE_KEY=""; AZURE_DEPLOYMENT=""

ensure_ollama() {
  # If Ollama is already present we are done. Otherwise: on Linux/macOS/WSL
  # we offer the official one-line installer; on Windows we open the
  # download page (no silent install path for the .exe).
  if command -v ollama &>/dev/null; then
    ok "Ollama: $(ollama --version 2>&1 | head -1)"
    return 0
  fi
  warn "Ollama no esta instalado en el host."
  case "${PLATFORM}" in
    linux|wsl|macos)
      read -rp "Querés que lo instale ahora (curl ollama.com/install.sh | sh)? [Y/n]: " GO <"$TTY"
      GO=${GO:-Y}
      if [[ "${GO}" =~ ^[Yy]$ ]]; then
        info "Instalando Ollama..."
        curl -fsSL https://ollama.com/install.sh | sh
        if ! command -v ollama &>/dev/null; then
          err "La instalacion fallo. Probá manualmente: https://ollama.com/download"
          exit 1
        fi
        ok "Ollama instalado: $(ollama --version 2>&1 | head -1)"
      else
        info "Sin Ollama no podemos continuar con esta opcion."; exit 1
      fi
      ;;
    gitbash)
      info "Abriendo: https://ollama.com/download/windows"
      open_url "https://ollama.com/download/windows"
      info "Instalá Ollama (te abrimos la pagina) y volvé a correr este script."
      exit 1
      ;;
    *)
      info "Bajalo desde https://ollama.com/download y volvé a correr este script."
      exit 1
      ;;
  esac
}

case "${EMB_OPT}" in
  1)
    ensure_ollama
    info "Bajando mxbai-embed-large (~669 MB, una sola vez)..."
    ollama pull mxbai-embed-large:335m
    ok "Modelo descargado"
    OLLAMA_MODEL="mxbai-embed-large:335m"
    OLLAMA_DIMS="1024"
    OLLAMA_ENDPOINT="http://host.docker.internal:11434"
    ;;
  2)
    read -rp "Azure OpenAI endpoint (https://<recurso>.openai.azure.com): " AZURE_ENDPOINT <"$TTY"
    read -rsp "Azure OpenAI API key: " AZURE_KEY <"$TTY"; echo
    read -rp "Deployment name [text-embedding-3-large]: " AZURE_DEPLOYMENT <"$TTY"
    AZURE_DEPLOYMENT=${AZURE_DEPLOYMENT:-text-embedding-3-large}
    ok "Azure OpenAI configurado"
    ;;
  3)
    warn "Embedder deterministico — sin busqueda semantica de calidad."
    ;;
  *)
    err "Opcion invalida: ${EMB_OPT}"; exit 1 ;;
esac

# ─── Seed ───────────────────────────────────────────────────────────────────
header "4 / 7 — Datos iniciales"
echo "  1) Vault vacio"
echo "  2) Seed demo (1500 notas tecnicas — para explorar features sin escribir)"
read -rp "Opcion [1]: " SEED_OPT <"$TTY"
SEED_OPT=${SEED_OPT:-1}

# ─── Generate docker-compose.yml ────────────────────────────────────────────
header "5 / 7 — Que version querés instalar"

# Override directo: DILUXITE_VERSION=1.0.0-alpha.5 ./install.sh → salta el menu.
# Sino: el user elige canal (estable o pre-release) y resolvemos contra
# GitHub Releases para usar el tag exacto correspondiente.
#   - Estable  → /releases/latest (404 si no hay ninguna estable todavia)
#   - Pre-rel  → primer item de /releases (cualquier tipo, mas reciente)

VERSION="${DILUXITE_VERSION:-}"

if [ -z "${VERSION}" ]; then
  echo "  1) Estable (:latest) — release probada, sin sorpresas (RECOMENDADO para uso real)"
  echo "  2) Pre-release (:next) — alpha/beta/rc, features mas nuevas, puede romperse"
  echo ""
  read -rp "Opcion [1]: " CHANNEL <"$TTY"
  CHANNEL=${CHANNEL:-1}

  case "${CHANNEL}" in
    1)
      info "Consultando ultima release ESTABLE..."
      VERSION=$(curl -fsSL "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases/latest" 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tag_name','').lstrip('v'))" 2>/dev/null || true)
      if [ -z "${VERSION}" ]; then
        warn "Todavia no hay una release estable publicada en este repo."
        read -rp "Probar con la ultima pre-release? [Y/n]: " GOPRE <"$TTY"
        GOPRE=${GOPRE:-Y}
        if [[ "${GOPRE}" =~ ^[Yy]$ ]]; then
          CHANNEL=2
        else
          err "Sin version que pinear. Saliendo."; exit 1
        fi
      fi
      ;;
  esac

  if [ "${CHANNEL}" = "2" ]; then
    info "Consultando ultima PRE-release..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases" 2>/dev/null \
      | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['tag_name'].lstrip('v') if r else '')" 2>/dev/null || true)
    if [ -z "${VERSION}" ]; then
      err "No encontre ninguna release en el repo. Saliendo."; exit 1
    fi
  fi
fi

ok "Version a instalar: ${VERSION}"

header "6 / 7 — Generando configuracion"

template_path="${INSTALL_DIR}/docker-compose.template.yml"
compose_path="${INSTALL_DIR}/docker-compose.yml"

if [ -f "$(dirname "$0")/docker-compose.template.yml" ]; then
  cp "$(dirname "$0")/docker-compose.template.yml" "${template_path}"
else
  curl -fsSL "${DILUXITE_REPO_RAW}/docker-compose.template.yml" -o "${template_path}"
fi

# Linux native sin Docker Desktop necesita host.docker.internal mapeado al
# host gateway para que el container alcance al Ollama daemon del host.
# Docker Desktop (Mac/Win/WSL) ya lo resuelve solo — ahi extra_hosts vacio.
EXTRA_HOSTS_LINE=""
if [ "${EMB_OPT}" = "1" ] && [ "${PLATFORM}" = "linux" ]; then
  EXTRA_HOSTS_LINE='    extra_hosts:\
      - "host.docker.internal:host-gateway"'
fi

sed -e "s|__DILUXITE_VERSION__|${VERSION}|g" \
    -e "s|__DATA_PATH__|${DATA_PATH}|g" \
    -e "s|__OLLAMA_MODEL__|${OLLAMA_MODEL}|g" \
    -e "s|__OLLAMA_DIMS__|${OLLAMA_DIMS}|g" \
    -e "s|__OLLAMA_ENDPOINT__|${OLLAMA_ENDPOINT}|g" \
    -e "s|__AZURE_ENDPOINT__|${AZURE_ENDPOINT}|g" \
    -e "s|__AZURE_KEY__|${AZURE_KEY}|g" \
    -e "s|__AZURE_DEPLOYMENT__|${AZURE_DEPLOYMENT}|g" \
    -e "s|__EXTRA_HOSTS__|${EXTRA_HOSTS_LINE}|" \
    "${template_path}" > "${compose_path}"

ok "docker-compose.yml generado"

# ─── Up ─────────────────────────────────────────────────────────────────────
header "7 / 7 — Levantando Diluxite"

cd "${INSTALL_DIR}"
info "Pulleando imagenes desde Docker Hub..."
docker compose pull
info "Arrancando..."
docker compose up -d
ok "Containers en marcha"

info "Esperando que Diluxite este healthy..."
# /api/update/check existe en la API y va via nginx proxy (puerto 5173 es
# el unico expuesto en el compose). Es la senial canonica de "todo arriba"
# porque exige que API + nginx + ruteo /api/* esten funcionando.
for i in $(seq 1 60); do
  if curl -fsS http://localhost:5173/api/update/check >/dev/null 2>&1; then
    ok "Diluxite saludable"
    break
  fi
  sleep 2
  if [ "${i}" -eq 60 ]; then
    err "Diluxite no respondio en 2 minutos."
    err "Logs: cd ${INSTALL_DIR} && docker compose logs"
    exit 1
  fi
done

if [ "${SEED_OPT}" = "2" ]; then
  info "Cargando seed demo (1500 notas)... esto tarda unos minutos."
  docker compose exec -T diluxite pnpm seed || warn "El seed fallo — corré despues: docker compose exec diluxite pnpm seed"
fi

# ─── Done ───────────────────────────────────────────────────────────────────
header "Listo"
echo "Abri http://localhost:5173 para empezar."
echo ""
echo "Comandos utiles (desde ${INSTALL_DIR}):"
echo "  docker compose logs -f                          # ver logs"
echo "  docker compose down                             # detener (datos persisten)"
echo "  docker compose pull && docker compose up -d     # actualizar"
echo "  docker compose --profile autoupdate up -d       # Watchtower auto-update"
echo ""
echo "Datos: ${DATA_PATH}"
echo "Backup: copiar esa carpeta."
