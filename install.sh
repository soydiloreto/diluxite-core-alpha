#!/usr/bin/env bash
# ==============================================================================
# Diluxite installer — Linux / macOS / WSL2 / Git Bash on Windows.
#
# One installer for every platform. In Windows the user runs this from WSL2
# (which Docker Desktop already requires) or Git Bash — there is no separate
# .ps1 to maintain.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
# ==============================================================================
set -euo pipefail

# When invoked via `curl ... | bash`, stdin is the script pipe — every read
# would consume the next line of the script. Cannot do `exec < /dev/tty`
# globally (bash is reading the script body from stdin). Each `read` below
# pipes from $TTY explicitly. Same pattern rustup / homebrew use.
TTY=/dev/stdin
if [ ! -t 0 ] && [ -r /dev/tty ]; then
  TTY=/dev/tty
fi

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()   { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()     { echo -e "${GREEN}[OK]${NC} $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()    { echo -e "${RED}[ERROR]${NC} $*"; }
header() { echo -e "\n${CYAN}${BOLD}═══ $* ═══${NC}\n"; }
nice()   { echo -e "\n${MAGENTA}${BOLD}$*${NC}\n"; }

# ─── Repo metadata ──────────────────────────────────────────────────────────
DILUXITE_REPO_RAW="https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"
DEFAULT_VERSION="latest"

# ─── Platform detection ─────────────────────────────────────────────────────
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

platform_name() {
  case "${PLATFORM}" in
    linux)   echo "Linux" ;;
    macos)   echo "macOS" ;;
    wsl)     echo "Windows (WSL2)" ;;
    gitbash) echo "Windows (Git Bash)" ;;
    *)       echo "an unknown OS" ;;
  esac
}

# ─── Helpers ────────────────────────────────────────────────────────────────
open_url() {
  local url="$1"
  case "${PLATFORM}" in
    linux)   xdg-open "${url}" >/dev/null 2>&1 || true ;;
    macos)   open "${url}" >/dev/null 2>&1 || true ;;
    wsl)     if command -v wslview &>/dev/null; then wslview "${url}" >/dev/null 2>&1 || true
             else cmd.exe /c start "" "${url}" >/dev/null 2>&1 || true; fi ;;
    gitbash) cmd //c start "" "${url}" >/dev/null 2>&1 || true ;;
  esac
}

# ─── Banner ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}             Diluxite Installer${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Self-hosted memory for your AI.${NC}"
echo -e "  ${DIM}Markdown notes + hybrid search + MCP server. AGPL-3.0.${NC}"
echo ""
echo -e "  ${DIM}By Pablo Ariel Di Loreto · @soydiloreto${NC}"
echo -e "  ${DIM}github.com/soydiloreto/diluxite-core-alpha${NC}"
echo ""

if [ "$(id -u 2>/dev/null || echo 1000)" -eq 0 ]; then
  err "Don't run this as root. Use a normal user with sudo access."
  exit 1
fi

nice "Hi there — looks like you're running $(platform_name). Let's get Diluxite installed on this machine."

if [ "${PLATFORM}" = "unknown" ]; then
  warn "We didn't recognise your OS. Diluxite officially supports Linux, macOS, WSL2 and Git Bash on Windows."
  read -rp "Continue anyway? [y/N]: " FORCE <"$TTY"
  [[ "${FORCE}" =~ ^[Yy]$ ]] || exit 1
fi

# ─── Step 1 — Pre-requisites ────────────────────────────────────────────────
header "Step 1 / 7 — Checking pre-requisites"

if ! command -v docker &>/dev/null; then
  err "Docker isn't installed."
  case "${PLATFORM}" in
    macos|gitbash|wsl) url="https://www.docker.com/products/docker-desktop/" ;;
    *)                 url="https://docs.docker.com/engine/install/" ;;
  esac
  info "Opening Docker download page in your browser: ${url}"
  open_url "${url}"
  info "Install Docker, start it, then re-run this script."
  exit 1
fi
ok "Docker present: $(docker --version)"

if ! docker info >/dev/null 2>&1; then
  err "Docker is installed but the daemon isn't running."
  case "${PLATFORM}" in
    linux) info "Start it with: sudo systemctl start docker" ;;
    *)     info "Open Docker Desktop and wait until it's ready." ;;
  esac
  exit 1
fi
ok "Docker daemon is up"

if ! docker compose version >/dev/null 2>&1; then
  err "Docker Compose v2 isn't available. Update Docker."
  exit 1
fi
ok "Docker Compose v2 available"

for port in 3030 5173 5432; do
  if command -v ss &>/dev/null && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\b"; then
    err "Port ${port} is busy. Free it and try again."; exit 1
  fi
  if command -v lsof &>/dev/null && lsof -iTCP:${port} -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN; then
    err "Port ${port} is busy. Free it and try again."; exit 1
  fi
done
ok "Ports 3030 / 5173 / 5432 are free"

free_mb=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}' || echo 999999)
if [ "${free_mb}" -lt 3000 ]; then
  err "Not enough free disk space (${free_mb} MB). Diluxite needs at least 3 GB."
  exit 1
fi
ok "Free disk: ${free_mb} MB"

# ─── Step 2 — Data directory ────────────────────────────────────────────────
nice "Great — your system is ready. Now let's decide where Diluxite stores your data."

header "Step 2 / 7 — Where to keep your data"

default_data="${HOME}/diluxite/data"
echo -e "  ${DIM}This is the folder where your notes, the Postgres database and the${NC}"
echo -e "  ${DIM}configuration will live. To back up Diluxite you just copy this folder.${NC}"
echo ""
read -rp "Path for your data [${default_data}]: " DATA_PATH <"$TTY"
DATA_PATH="${DATA_PATH:-${default_data}}"
mkdir -p "${DATA_PATH}/postgres"
ok "Data path: ${DATA_PATH}"

default_install="${HOME}/diluxite"
read -rp "Install path (where docker-compose.yml lives) [${default_install}]: " INSTALL_DIR <"$TTY"
INSTALL_DIR="${INSTALL_DIR:-${default_install}}"
mkdir -p "${INSTALL_DIR}"
ok "Install path: ${INSTALL_DIR}"

# ─── Step 3 — Embedder ──────────────────────────────────────────────────────
nice "Perfect. Now let's pick your AI embeddings engine — what powers semantic search."

header "Step 3 / 7 — Embeddings engine"
echo "  1) Ollama local with mxbai-embed-large (RECOMMENDED)"
echo "     High quality, multilingual, no keys, no cloud. 669 MB one-time download."
echo "  2) Azure OpenAI (top quality, needs an account, costs per token)"
echo "  3) Deterministic local (no real semantic quality — only useful for testing)"
echo ""
read -rp "Choice [1]: " EMB_OPT <"$TTY"
EMB_OPT=${EMB_OPT:-1}

OLLAMA_MODEL=""; OLLAMA_DIMS=""; OLLAMA_ENDPOINT=""
AZURE_ENDPOINT=""; AZURE_KEY=""; AZURE_DEPLOYMENT=""

ensure_ollama() {
  if command -v ollama &>/dev/null; then
    ok "Ollama already installed: $(ollama --version 2>&1 | head -1)"
    return 0
  fi
  warn "Ollama isn't installed on this host."
  case "${PLATFORM}" in
    linux|wsl|macos)
      read -rp "Want me to install it now (curl ollama.com/install.sh | sh)? [Y/n]: " GO <"$TTY"
      GO=${GO:-Y}
      if [[ "${GO}" =~ ^[Yy]$ ]]; then
        info "Installing Ollama..."
        curl -fsSL https://ollama.com/install.sh | sh
        if ! command -v ollama &>/dev/null; then
          err "The install failed. Try manually: https://ollama.com/download"
          exit 1
        fi
        ok "Ollama installed: $(ollama --version 2>&1 | head -1)"
      else
        info "Without Ollama we can't continue with this option."; exit 1
      fi
      ;;
    gitbash)
      info "Opening: https://ollama.com/download/windows"
      open_url "https://ollama.com/download/windows"
      info "Install Ollama (the page should open in your browser) and re-run this script."
      exit 1
      ;;
    *)
      info "Download it from https://ollama.com/download and re-run this script."
      exit 1
      ;;
  esac
}

case "${EMB_OPT}" in
  1)
    ensure_ollama
    info "Pulling mxbai-embed-large (~669 MB, one-time)..."
    ollama pull mxbai-embed-large:335m
    ok "Model downloaded"
    OLLAMA_MODEL="mxbai-embed-large:335m"
    OLLAMA_DIMS="1024"
    OLLAMA_ENDPOINT="http://host.docker.internal:11434"
    ;;
  2)
    read -rp "Azure OpenAI endpoint (https://<resource>.openai.azure.com): " AZURE_ENDPOINT <"$TTY"
    read -rsp "Azure OpenAI API key: " AZURE_KEY <"$TTY"; echo
    read -rp "Deployment name [text-embedding-3-large]: " AZURE_DEPLOYMENT <"$TTY"
    AZURE_DEPLOYMENT=${AZURE_DEPLOYMENT:-text-embedding-3-large}
    ok "Azure OpenAI configured"
    ;;
  3)
    warn "Deterministic embedder — no semantic quality, only fine for trying things out."
    ;;
  *)
    err "Invalid choice: ${EMB_OPT}"; exit 1 ;;
esac

# ─── Step 4 — Seed ──────────────────────────────────────────────────────────
nice "Almost there. Want to start fresh or with a demo vault?"

header "Step 4 / 7 — Initial content"
echo "  1) Empty vault"
echo "  2) Demo seed (1500 technical notes — handy for exploring features without writing)"
read -rp "Choice [1]: " SEED_OPT <"$TTY"
SEED_OPT=${SEED_OPT:-1}

# ─── Step 5 — Version channel ───────────────────────────────────────────────
nice "Last questions: which release channel would you like to follow?"

header "Step 5 / 7 — Which version to install"

VERSION="${DILUXITE_VERSION:-}"

if [ -z "${VERSION}" ]; then
  echo "  1) Stable (:latest) — tested release, no surprises (RECOMMENDED for real use)"
  echo "  2) Pre-release (:next) — alpha/beta/rc, newer features, may have bugs"
  echo ""
  read -rp "Choice [1]: " CHANNEL <"$TTY"
  CHANNEL=${CHANNEL:-1}

  # Resolve via GitHub Releases API when possible (gives us the exact tag).
  # Fallback to rolling tags (:latest / :next) if the API call fails — most
  # common reason is the 60-req/hour rate limit on the unauthenticated API,
  # which kicks in fast when running the installer multiple times from the
  # same IP. Docker Hub serves :latest and :next regardless of GitHub API.
  api_get_tag() {
    local url="$1"
    local jq_expr="$2"
    curl -fsSL "${url}" 2>/dev/null \
      | python3 -c "import json,sys
try:
  d = json.load(sys.stdin)
  ${jq_expr}
except Exception:
  pass" 2>/dev/null || true
  }

  case "${CHANNEL}" in
    1)
      info "Looking up the latest STABLE release..."
      VERSION=$(api_get_tag \
        "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases/latest" \
        "print(d.get('tag_name','').lstrip('v'))")
      if [ -z "${VERSION}" ]; then
        warn "Couldn't resolve a stable tag from GitHub (rate-limited or no stable yet)."
        info "Falling back to the rolling ':latest' tag from Docker Hub."
        VERSION="latest"
      fi
      ;;
    2)
      info "Looking up the latest PRE-release..."
      VERSION=$(api_get_tag \
        "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases" \
        "print(d[0]['tag_name'].lstrip('v') if d else '')")
      if [ -z "${VERSION}" ]; then
        warn "Couldn't resolve a pre-release tag from GitHub (rate-limited or no releases)."
        info "Falling back to the rolling ':next' tag from Docker Hub."
        VERSION="next"
      fi
      ;;
    *)
      err "Invalid choice: ${CHANNEL}"; exit 1 ;;
  esac
fi

ok "Version to install: ${VERSION}"

# ─── Step 6 — Generate compose ──────────────────────────────────────────────
nice "Wiring everything up..."

header "Step 6 / 7 — Generating your configuration"

template_path="${INSTALL_DIR}/docker-compose.template.yml"
compose_path="${INSTALL_DIR}/docker-compose.yml"

if [ -f "$(dirname "$0")/docker-compose.template.yml" ]; then
  cp "$(dirname "$0")/docker-compose.template.yml" "${template_path}"
else
  curl -fsSL "${DILUXITE_REPO_RAW}/docker-compose.template.yml" -o "${template_path}"
fi

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

ok "docker-compose.yml ready"

# ─── Step 7 — Bring it up ───────────────────────────────────────────────────
nice "Time to bring Diluxite online — this may take a couple of minutes the first time."

header "Step 7 / 7 — Starting Diluxite"

cd "${INSTALL_DIR}"
info "Pulling images from Docker Hub..."
docker compose pull
info "Starting containers..."
docker compose up -d
ok "Containers up"

info "Waiting for Diluxite to be healthy..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:5173/api/update/check >/dev/null 2>&1; then
    ok "Diluxite is healthy"
    break
  fi
  sleep 2
  if [ "${i}" -eq 60 ]; then
    err "Diluxite didn't respond within 2 minutes."
    err "Logs: cd ${INSTALL_DIR} && docker compose logs"
    exit 1
  fi
done

if [ "${SEED_OPT}" = "2" ]; then
  info "Loading demo seed (1500 notes)... this takes a few minutes."
  # -w /app  → pnpm finds the workspace root inside the container.
  # </dev/null → docker compose exec won't try to consume the script
  #              body (which is piped to bash from `curl | bash`),
  #              otherwise the rest of this script never runs.
  docker compose exec -T -w /app diluxite pnpm seed </dev/null \
    || warn "Seed failed — you can run it later with: docker compose exec -w /app diluxite pnpm seed"
fi

# ─── Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}    🎉  Diluxite is up and running!  🎉${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Open it now:${NC}  ${GREEN}${BOLD}→  http://localhost:5173  ←${NC}"
echo ""
echo -e "  ${DIM}On first load you'll see the welcome panel. The MCP endpoint${NC}"
echo -e "  ${DIM}for connecting Claude / Copilot is at /mcp on the same port.${NC}"
echo ""
echo -e "${CYAN}${BOLD}─── What's installed ───${NC}"
echo -e "  ${BOLD}Version:${NC}      ${VERSION}"
echo -e "  ${BOLD}Embedder:${NC}     $([ -n "${OLLAMA_MODEL}" ] && echo "Ollama (${OLLAMA_MODEL})" || ([ -n "${AZURE_ENDPOINT}" ] && echo "Azure OpenAI" || echo "Deterministic local"))"
echo -e "  ${BOLD}Data folder:${NC}  ${DATA_PATH}"
echo -e "  ${BOLD}Install dir:${NC}  ${INSTALL_DIR}"
if [ "${SEED_OPT}" = "2" ]; then
  echo -e "  ${BOLD}Seed loaded:${NC}  1500 demo notes (try the search bar with Ctrl/Cmd+K)"
fi
echo ""
echo -e "${CYAN}${BOLD}─── Useful commands ───${NC} ${DIM}(run from ${INSTALL_DIR})${NC}"
echo -e "  ${YELLOW}docker compose logs -f${NC}                          ${DIM}# tail the logs${NC}"
echo -e "  ${YELLOW}docker compose down${NC}                             ${DIM}# stop everything (your data stays)${NC}"
echo -e "  ${YELLOW}docker compose pull && docker compose up -d${NC}     ${DIM}# update to a newer image${NC}"
echo -e "  ${YELLOW}docker compose --profile autoupdate up -d${NC}       ${DIM}# enable Watchtower auto-update${NC}"
echo ""
echo -e "${CYAN}${BOLD}─── Backup ───${NC}"
echo -e "  Just copy ${BOLD}${DATA_PATH}${NC} ${DIM}— that's your whole vault + DB.${NC}"
echo ""
echo -e "${MAGENTA}${BOLD}Thanks for trying Diluxite!${NC}"
echo -e "  ${DIM}Questions, issues, ideas:${NC} ${BLUE}github.com/soydiloreto/diluxite-core-alpha${NC}"
echo -e "  ${DIM}Built by:${NC} ${BOLD}Pablo Ariel Di Loreto${NC} ${DIM}·${NC} ${BLUE}@soydiloreto${NC}"
echo ""
