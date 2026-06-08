#!/usr/bin/env bash
# ==============================================================================
# Diluxite installer — Linux / macOS / WSL2 / Git Bash on Windows.
# i18n: English / Español / Português.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
# ==============================================================================
set -euo pipefail

# TTY para leer respuestas del usuario. `DILUXITE_TTY` permite forzarlo (tests
# e2e: lo apuntan a /dev/stdin para alimentar input por pipe).
TTY="${DILUXITE_TTY:-/dev/stdin}"
if [ -z "${DILUXITE_TTY:-}" ] && [ ! -t 0 ] && [ -r /dev/tty ]; then
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

DILUXITE_REPO_RAW="https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"

# ─── CLI flags (management mode) ────────────────────────────────────────────
# Sin flags + sin instalación previa = wizard interactivo de instalación.
# Con flags, o si detectamos una instalación existente, el script entra en
# "modo gestión": actualizar / reconfigurar / estado / backup / restore /
# desinstalar. Todo vive en este único install.sh (un solo `curl | bash`).
ACTION=""
ARG_INSTALL_DIR=""
ARG_CHANNEL=""
ARG_AUTOUPDATE=""
ARG_BACKUP_OUT=""
ARG_RESTORE_IN=""
ASSUME_YES=""

print_help() {
  cat <<'HLP'
Diluxite — installer / manager

Uso:
  install.sh                         Instalar (o menú de gestión si ya está instalado)
  install.sh --update                Actualizar a la última imagen del canal actual
  install.sh --status                Estado (solo lectura): versión, containers, salud
  install.sh --reconfigure           Menú: canal, HTTPS, SSO, modo local↔server, embedder…
  install.sh --reset-admin           Resetear el password del super admin (modo server)
  install.sh --seed                  Cargar notas demo (elegís el workspace si hay varios)
  install.sh --channel latest|next   Cambiar de canal y actualizar
  install.sh --autoupdate on|off     Activar / desactivar auto-update
  install.sh --backup [--out FILE]   Backup (pg_dump + config + manifest) → .tar.gz
  install.sh --restore --in FILE     Restaurar desde un backup (sirve en un equipo
                                     NUEVO: reconstruye modo/embedder/dominio/secretos
                                     desde el backup, sin preguntar nada)
  install.sh --uninstall             Bajar el stack (con opción de borrar datos)

Opciones:
  --install-dir DIR   Directorio de instalación (default: ~/diluxite)
  -y, --yes           No preguntar confirmaciones (no interactivo)
  -h, --help          Esta ayuda
HLP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update)        ACTION="update" ;;
    --status)        ACTION="status" ;;
    --reconfigure)   ACTION="reconfigure" ;;
    --reset-admin)   ACTION="reset-admin" ;;
    --seed)          ACTION="seed" ;;
    --backup)        ACTION="backup" ;;
    --restore)       ACTION="restore" ;;
    --uninstall)     ACTION="uninstall" ;;
    --channel)       ACTION="reconfigure"; ARG_CHANNEL="${2:-}"; shift ;;
    --channel=*)     ACTION="reconfigure"; ARG_CHANNEL="${1#*=}" ;;
    --autoupdate)    ACTION="reconfigure"; ARG_AUTOUPDATE="${2:-}"; shift ;;
    --autoupdate=*)  ACTION="reconfigure"; ARG_AUTOUPDATE="${1#*=}" ;;
    --out)           ARG_BACKUP_OUT="${2:-}"; shift ;;
    --out=*)         ARG_BACKUP_OUT="${1#*=}" ;;
    --in)            ARG_RESTORE_IN="${2:-}"; shift ;;
    --in=*)          ARG_RESTORE_IN="${1#*=}" ;;
    --install-dir)   ARG_INSTALL_DIR="${2:-}"; shift ;;
    --install-dir=*) ARG_INSTALL_DIR="${1#*=}" ;;
    -y|--yes)        ASSUME_YES="1" ;;
    -h|--help)       print_help; exit 0 ;;
    *) err "Unknown option: $1 (use --help)"; exit 1 ;;
  esac
  shift
done

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
    *)       echo "${MSG_OS_UNKNOWN}" ;;
  esac
}

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

# ─── Language selector + i18n strings ───────────────────────────────────────
# En modo no interactivo (flag de acción) no preguntamos idioma: lo tomamos
# del state file de la instalación existente, o English por default.
if [ -n "${ACTION}" ]; then
  _sdir="${ARG_INSTALL_DIR:-$HOME/diluxite}"
  LANG_CHOICE="1"
  if [ -f "${_sdir}/.diluxite-install.env" ]; then
    LANG_CHOICE="$(. "${_sdir}/.diluxite-install.env" 2>/dev/null; echo "${DLX_LANG:-1}")"
  fi
else
  echo ""
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}             Diluxite Installer${NC}"
  echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Choose language / Elegí idioma / Escolha idioma:"
  echo "    1) English"
  echo "    2) Español"
  echo "    3) Português"
  echo ""
  echo -e "  ${DIM}Tip: press Enter for English · Enter para English · Enter para English${NC}"
  echo ""
  read -rp "Choice [1]: " LANG_CHOICE <"$TTY"
  LANG_CHOICE=${LANG_CHOICE:-1}
fi

case "${LANG_CHOICE}" in
  2) LANGCHOICE="es" ;;
  3) LANGCHOICE="pt" ;;
  *) LANGCHOICE="en" ;;
esac

set_messages() {
  case "${LANGCHOICE}" in
    es)
      MSG_TAGLINE="La memoria autohospedada para tu IA."
      MSG_SUBTITLE="Notas Markdown + búsqueda híbrida + servidor MCP. AGPL-3.0."
      MSG_BY="Por"
      MSG_OS_UNKNOWN="un sistema operativo desconocido"
      MSG_GREETING_PRE="¡Hola! Detecté que estás corriendo"
      MSG_GREETING_POST="Vamos a instalar Diluxite en esta máquina."
      MSG_NOT_ROOT="No corras esto como root. Usá un usuario normal con sudo."
      MSG_OS_NOT_RECOGNIZED="No reconocí tu sistema operativo. Diluxite soporta oficialmente Linux, macOS, WSL2 y Git Bash en Windows."
      MSG_CONTINUE_ANYWAY="¿Continuar de todos modos? [y/N]: "
      MSG_STEP1="Paso 1 / 9 — Verificando requisitos"
      MSG_DOCKER_MISSING="Docker no está instalado."
      MSG_DOCKER_OPEN="Abriendo la página de descarga de Docker en tu navegador:"
      MSG_DOCKER_THEN="Instalá Docker, abrilo, y volvé a correr este script."
      MSG_DOCKER_PRESENT="Docker presente:"
      MSG_DOCKER_DOWN="Docker está instalado pero el daemon no está corriendo."
      MSG_DOCKER_START_LINUX="Arrancalo con: sudo systemctl start docker"
      MSG_DOCKER_START_OTHER="Abrí Docker Desktop y esperá a que arranque."
      MSG_DOCKER_UP="El daemon de Docker está corriendo"
      MSG_COMPOSE_MISSING="Docker Compose v2 no está disponible. Actualizá Docker."
      MSG_COMPOSE_OK="Docker Compose v2 disponible"
      MSG_PORT_BUSY="El puerto"
      MSG_PORT_BUSY_AFTER="está ocupado. Liberalo y volvé a intentar."
      MSG_PORTS_FREE="Puertos 3030 / 5173 / 5432 libres"
      MSG_DISK_LOW="Poco espacio en disco"
      MSG_DISK_NEEDED="Diluxite necesita al menos 3 GB."
      MSG_DISK_FREE="Espacio libre en disco:"
      MSG_AFTER_STEP1="¡Excelente! Tu sistema está listo. Ahora elegimos dónde guardar tus datos."
      MSG_START_Q="¿Qué querés hacer?"
      MSG_START_INSTALL="Instalar Diluxite (instalación nueva)"
      MSG_START_RESTORE="Restaurar desde un backup (.tar.gz)"
      MSG_START_EXIT="Salir"
      MSG_START_BACKUP_PATH="Ruta del backup (.tar.gz)"
      MSG_START_BYE="Listo, sin cambios."
      MSG_STEP2="Paso 2 / 9 — Dónde guardar tus datos"
      MSG_STEP2_HELP1="Esta es la carpeta donde van a vivir tus notas, la base de datos Postgres"
      MSG_STEP2_HELP2="y la configuración. Para hacer backup de Diluxite copiás esta carpeta."
      MSG_STEP2_PATH="Ruta para tus datos"
      MSG_STEP2_INSTALL="Ruta de instalación (donde va docker-compose.yml)"
      MSG_DATA_AT="Datos en:"
      MSG_DATA_EXISTS="⚠️  Ya hay una base de datos de Diluxite en esta ruta (instalación previa)."
      MSG_DATA_REUSE="Reusar esos datos (mantener tus notas existentes)"
      MSG_DATA_WIPE="Empezar de cero (BORRAR la base existente)"
      MSG_DATA_WIPING="Borrando la base existente…"
      MSG_DATA_WIPED="Base anterior borrada — arrancás 100% limpio."
      MSG_DATA_REUSING="Reusando los datos existentes."
      MSG_INSTALL_AT="Instalación en:"
      MSG_AFTER_STEP2="Perfecto. Ahora elegí el motor de embeddings — lo que potencia la búsqueda semántica."
      MSG_STEP3="Paso 3 / 9 — Motor de embeddings"
      MSG_EMB_1="1) Ollama local con mxbai-embed-large (RECOMENDADO)"
      MSG_EMB_1_DESC="Alta calidad, multilenguaje, sin claves, sin nube. 669 MB de descarga una vez."
      MSG_EMB_2="2) Azure OpenAI (máxima calidad, requiere cuenta, costo por token)"
      MSG_EMB_3="3) Determinista local (sin calidad semántica real — solo para probar)"
      MSG_CHOICE="Opción"
      MSG_OLLAMA_OK="Ollama ya está instalado:"
      MSG_OLLAMA_MISSING="Ollama no está instalado en este equipo."
      MSG_OLLAMA_INSTALL_Q="¿Querés que lo instale ahora (curl ollama.com/install.sh | sh)? [Y/n]: "
      MSG_OLLAMA_INSTALLING="Instalando Ollama..."
      MSG_OLLAMA_INSTALL_FAIL="La instalación falló. Probá manualmente:"
      MSG_OLLAMA_INSTALLED="Ollama instalado:"
      MSG_OLLAMA_REQUIRED="Sin Ollama no podemos continuar con esta opción."
      MSG_OLLAMA_WIN="Abriendo:"
      MSG_OLLAMA_WIN_AFTER="Instalá Ollama (te abrimos la página) y volvé a correr este script."
      MSG_OLLAMA_OTHER="Bajalo desde https://ollama.com/download y volvé a correr este script."
      MSG_OLLAMA_PULL="Descargando mxbai-embed-large (~669 MB, una sola vez)..."
      MSG_MODEL_OK="Modelo descargado"
      MSG_AZURE_EP="Azure OpenAI endpoint (https://<recurso>.openai.azure.com)"
      MSG_AZURE_KEY="Azure OpenAI API key"
      MSG_AZURE_DEPLOY="Nombre del deployment [text-embedding-3-large]"
      MSG_AZURE_OK="Azure OpenAI configurado"
      MSG_DETERMINISTIC="Embedder determinista — sin calidad semántica real, solo para probar."
      MSG_INVALID="Opción inválida:"
      MSG_AFTER_STEP3="Casi listo. ¿Empezás con un vault vacío o con notas de demo?"
      MSG_STEP4="Paso 4 / 9 — Contenido inicial"
      MSG_SEED_1="1) Vault vacío"
      MSG_SEED_2="2) Seed demo (1500 notas técnicas — útil para explorar features sin escribir)"
      MSG_AFTER_STEP4="Últimas preguntas: ¿qué canal de releases querés seguir?"
      MSG_STEP5="Paso 5 / 9 — Qué versión instalar"
      MSG_CHAN_1="1) Estable (:latest) — release probada, sin sorpresas (RECOMENDADO para uso real)"
      MSG_CHAN_2="2) Pre-release (:next) — alpha/beta/rc, features más nuevas, puede tener bugs"
      MSG_LOOKUP_STABLE="Consultando la última release ESTABLE..."
      MSG_FALLBACK_STABLE="No pude resolver un tag estable desde GitHub (rate limit o sin estables aún)."
      MSG_FALLBACK_LATEST="Cayendo al tag rolling ':latest' de Docker Hub."
      MSG_LOOKUP_PRE="Consultando la última PRE-release..."
      MSG_FALLBACK_PRE="No pude resolver un tag de pre-release desde GitHub (rate limit o sin releases)."
      MSG_FALLBACK_NEXT="Cayendo al tag rolling ':next' de Docker Hub."
      MSG_VERSION="Versión a instalar:"
      MSG_AFTER_STEP5="Antes de generar el compose, una decisión más sobre mantenimiento."
      MSG_STEP_AUTOUPDATE="Paso 6 / 9 — Auto-actualización"
      MSG_AUTOUPDATE_DESC1="¿Querés que Diluxite se actualice solo cuando hay versión nueva?"
      MSG_AUTOUPDATE_DESC2="Watchtower revisa Docker Hub cada 6h y reconcilia los containers. Solo toca los de Diluxite (label-based, no pisa otros Watchtowers del host)."
      MSG_AUTOUPDATE_WARN="En alpha pueden colarse breaking changes — si querés controlar cada upgrade leyendo release notes, respondé N."
      MSG_AUTOUPDATE_Q="¿Activar auto-actualización? [y/N]: "
      MSG_AUTOUPDATE_ON="Auto-actualización activada (Watchtower revisa cada 6h)."
      MSG_AUTOUPDATE_OFF="Auto-actualización desactivada. El banner amarillo en la UI te avisa cuando hay versión nueva."
      MSG_AU_NOTPROD="⚠️  NO recomendado en producción. Auto-actualizar puede traer un breaking change sin que lo revises. El riesgo es tuyo."
      MSG_AU_SOCKET="⚠️  Watchtower monta el socket de Docker → tiene acceso COMPLETO a tu Docker (= root del host). Imagen: nickfedor/watchtower (fork open-source mantenido)."
      MSG_AU_ACCEPT="¿Aceptás esos riesgos y activás la auto-actualización?"
      MSG_AU_DECLINED="Perfecto, queda en updates manuales (lo más seguro). Actualizás con la opción 'Actualizar' del menú."
      MSG_AFTER_STEP_AUTOUPDATE="Última decisión: ¿personal o multi-usuario?"
      MSG_STEP6_MODE="Paso 7 / 9 — Modo de instalación"
      MSG_MODE_1="1) Local — sin login, single-user (RECOMENDADO para tu PC personal)"
      MSG_MODE_2="2) Server — login obligatorio con email + password (para equipos, empresa, internet)"
      MSG_ADMIN_EMAIL="Email del primer admin"
      MSG_ADMIN_PASSWORD="Password del admin (mínimo 8 caracteres)"
      MSG_ADMIN_PASSWORD_CONFIRM="Repetí el password"
      MSG_PASSWORD_MISMATCH="Los passwords no coinciden — empezá de nuevo."
      MSG_PASSWORD_SHORT="El password debe tener al menos 8 caracteres."
      MSG_MODE_LOCAL_OK="Modo: local (passwordless single-user)"
      MSG_MODE_SERVER_OK="Modo: server, admin:"
      MSG_AFTER_STEP6_MODE="Listo, ya tengo todo. Generando configuración."
      MSG_STEP7="Paso 8 / 9 — Generando la configuración"
      MSG_COMPOSE_READY="docker-compose.yml listo"
      MSG_AFTER_STEP7="Hora de levantar Diluxite — puede tardar unos minutos la primera vez."
      MSG_STEP8="Paso 9 / 9 — Arrancando Diluxite"
      MSG_PULLING="Descargando imágenes desde Docker Hub..."
      MSG_STARTING="Levantando containers..."
      MSG_CONTAINERS_UP="Containers arriba"
      MSG_WAITING="Esperando que Diluxite esté saludable..."
      MSG_HEALTHY="Diluxite está saludable"
      MSG_HEALTH_TIMEOUT="Diluxite no respondió en 2 minutos."
      MSG_LOGS="Logs:"
      MSG_SEED_LOADING="Cargando seed demo (1500 notas)... tarda unos minutos."
      MSG_SEED_FAIL="El seed falló — podés correrlo después con:"
      MSG_DONE_TITLE="🎉  ¡Diluxite está corriendo!  🎉"
      MSG_OPEN_NOW="Abrilo ahora:"
      MSG_FIRST_LOAD1="En la primera carga vas a ver el panel de bienvenida. El endpoint MCP"
      MSG_FIRST_LOAD2="para conectar Claude / Copilot está en /mcp en el mismo puerto."
      MSG_WHATS_INSTALLED="─── Qué se instaló ───"
      MSG_VERSION_LABEL="Versión:"
      MSG_EMBEDDER_LABEL="Embedder:"
      MSG_DATA_LABEL="Carpeta de datos:"
      MSG_INSTALL_LABEL="Directorio de instalación:"
      MSG_SEED_LOADED="Seed cargado:"
      MSG_SEED_LOADED_DESC="1500 notas demo (probá la búsqueda con Ctrl/Cmd+K)"
      MSG_EMB_OLLAMA="Ollama"
      MSG_EMB_AZURE="Azure OpenAI"
      MSG_EMB_DET="Determinista local"
      MSG_USEFUL_CMDS="─── Comandos útiles ───"
      MSG_USEFUL_FROM="(corré desde"
      MSG_CMD_LOGS="ver logs en tiempo real"
      MSG_CMD_DOWN="detener todo (tus datos se mantienen)"
      MSG_CMD_UPDATE="actualizar a una imagen más nueva"
      MSG_CMD_AUTOUPDATE="habilitar auto-update con Watchtower"
      MSG_CMD_FORCE_UPDATE="forzar update ahora (sin esperar a Watchtower)"
      MSG_AUTOUPDATE_LABEL="Auto-update:"
      MSG_AUTOUPDATE_LABEL_ON="ON (Watchtower revisa cada 6 h)"
      MSG_AUTOUPDATE_LABEL_OFF="OFF (manual — banner amarillo te avisa)"
      MSG_BACKUP="─── Backup ───"
      MSG_BACKUP_DESC="Copiá"
      MSG_BACKUP_DESC2="— es tu vault completo + DB."
      MSG_THANKS="¡Gracias por probar Diluxite!"
      MSG_QUESTIONS="Preguntas, issues, ideas:"
      MSG_BUILT_BY="Hecho por:"
      MSG_HINT_PATH="Tip: apretá Enter para usar la ruta propuesta entre corchetes, o escribí una propia."
      MSG_HINT_OPTION="Tip: apretá Enter para la opción predeterminada [1] (la recomendada), o tipeá el número que prefieras."
      MSG_HINT_YN_Y="Tip: Enter = Sí. Tipeá N para decir No."
      MSG_HINT_TEXT="Tip: Enter usa el valor propuesto entre corchetes, o escribí uno propio."
      MSG_HINT_LANG="Tip: Enter usa English. Tipeá 2 o 3 para los otros idiomas."
      ;;
    pt)
      MSG_TAGLINE="A memória auto-hospedada para sua IA."
      MSG_SUBTITLE="Notas Markdown + busca híbrida + servidor MCP. AGPL-3.0."
      MSG_BY="Por"
      MSG_OS_UNKNOWN="um SO desconhecido"
      MSG_GREETING_PRE="Olá! Detectei que você está rodando"
      MSG_GREETING_POST="Vamos instalar o Diluxite nesta máquina."
      MSG_NOT_ROOT="Não rode isto como root. Use um usuário comum com sudo."
      MSG_OS_NOT_RECOGNIZED="Não reconheci seu SO. O Diluxite suporta oficialmente Linux, macOS, WSL2 e Git Bash no Windows."
      MSG_CONTINUE_ANYWAY="Continuar mesmo assim? [y/N]: "
      MSG_STEP1="Passo 1 / 9 — Verificando pré-requisitos"
      MSG_DOCKER_MISSING="O Docker não está instalado."
      MSG_DOCKER_OPEN="Abrindo a página de download do Docker no seu navegador:"
      MSG_DOCKER_THEN="Instale o Docker, abra-o, e rode este script de novo."
      MSG_DOCKER_PRESENT="Docker presente:"
      MSG_DOCKER_DOWN="O Docker está instalado mas o daemon não está rodando."
      MSG_DOCKER_START_LINUX="Inicie com: sudo systemctl start docker"
      MSG_DOCKER_START_OTHER="Abra o Docker Desktop e espere ele subir."
      MSG_DOCKER_UP="Daemon do Docker rodando"
      MSG_COMPOSE_MISSING="Docker Compose v2 não disponível. Atualize o Docker."
      MSG_COMPOSE_OK="Docker Compose v2 disponível"
      MSG_PORT_BUSY="A porta"
      MSG_PORT_BUSY_AFTER="está ocupada. Libere-a e tente novamente."
      MSG_PORTS_FREE="Portas 3030 / 5173 / 5432 livres"
      MSG_DISK_LOW="Pouco espaço em disco"
      MSG_DISK_NEEDED="O Diluxite precisa de pelo menos 3 GB."
      MSG_DISK_FREE="Espaço livre em disco:"
      MSG_AFTER_STEP1="Ótimo! Seu sistema está pronto. Agora vamos escolher onde guardar seus dados."
      MSG_START_Q="O que você quer fazer?"
      MSG_START_INSTALL="Instalar o Diluxite (instalação nova)"
      MSG_START_RESTORE="Restaurar de um backup (.tar.gz)"
      MSG_START_EXIT="Sair"
      MSG_START_BACKUP_PATH="Caminho do backup (.tar.gz)"
      MSG_START_BYE="Pronto, sem alterações."
      MSG_STEP2="Passo 2 / 9 — Onde guardar seus dados"
      MSG_STEP2_HELP1="Esta é a pasta onde vão viver suas notas, o banco Postgres"
      MSG_STEP2_HELP2="e a configuração. Para fazer backup do Diluxite, copie essa pasta."
      MSG_STEP2_PATH="Caminho para seus dados"
      MSG_STEP2_INSTALL="Caminho de instalação (onde fica docker-compose.yml)"
      MSG_DATA_AT="Dados em:"
      MSG_DATA_EXISTS="⚠️  Já existe um banco de dados do Diluxite neste caminho (instalação anterior)."
      MSG_DATA_REUSE="Reusar esses dados (manter suas notas existentes)"
      MSG_DATA_WIPE="Começar do zero (APAGAR o banco existente)"
      MSG_DATA_WIPING="Apagando o banco existente…"
      MSG_DATA_WIPED="Banco anterior apagado — começa 100% limpo."
      MSG_DATA_REUSING="Reusando os dados existentes."
      MSG_INSTALL_AT="Instalação em:"
      MSG_AFTER_STEP2="Perfeito. Agora escolha o motor de embeddings — o que faz a busca semântica."
      MSG_STEP3="Passo 3 / 9 — Motor de embeddings"
      MSG_EMB_1="1) Ollama local com mxbai-embed-large (RECOMENDADO)"
      MSG_EMB_1_DESC="Alta qualidade, multilíngue, sem chaves, sem nuvem. 669 MB de download uma vez."
      MSG_EMB_2="2) Azure OpenAI (qualidade máxima, precisa de conta, custo por token)"
      MSG_EMB_3="3) Determinístico local (sem qualidade semântica real — só para testar)"
      MSG_CHOICE="Opção"
      MSG_OLLAMA_OK="Ollama já instalado:"
      MSG_OLLAMA_MISSING="O Ollama não está instalado neste host."
      MSG_OLLAMA_INSTALL_Q="Quer que eu instale agora (curl ollama.com/install.sh | sh)? [Y/n]: "
      MSG_OLLAMA_INSTALLING="Instalando Ollama..."
      MSG_OLLAMA_INSTALL_FAIL="A instalação falhou. Tente manualmente:"
      MSG_OLLAMA_INSTALLED="Ollama instalado:"
      MSG_OLLAMA_REQUIRED="Sem Ollama não podemos continuar com essa opção."
      MSG_OLLAMA_WIN="Abrindo:"
      MSG_OLLAMA_WIN_AFTER="Instale o Ollama (abrimos a página) e rode este script de novo."
      MSG_OLLAMA_OTHER="Baixe de https://ollama.com/download e rode este script de novo."
      MSG_OLLAMA_PULL="Baixando mxbai-embed-large (~669 MB, uma vez só)..."
      MSG_MODEL_OK="Modelo baixado"
      MSG_AZURE_EP="Azure OpenAI endpoint (https://<recurso>.openai.azure.com)"
      MSG_AZURE_KEY="Azure OpenAI API key"
      MSG_AZURE_DEPLOY="Nome do deployment [text-embedding-3-large]"
      MSG_AZURE_OK="Azure OpenAI configurado"
      MSG_DETERMINISTIC="Embedder determinístico — sem qualidade semântica real, só para testar."
      MSG_INVALID="Opção inválida:"
      MSG_AFTER_STEP3="Quase lá. Você quer começar com um vault vazio ou com notas de demo?"
      MSG_STEP4="Passo 4 / 9 — Conteúdo inicial"
      MSG_SEED_1="1) Vault vazio"
      MSG_SEED_2="2) Seed demo (1500 notas técnicas — útil para explorar features sem escrever)"
      MSG_AFTER_STEP4="Últimas perguntas: que canal de releases você quer seguir?"
      MSG_STEP5="Passo 5 / 9 — Qual versão instalar"
      MSG_CHAN_1="1) Estável (:latest) — release testada, sem surpresas (RECOMENDADO para uso real)"
      MSG_CHAN_2="2) Pre-release (:next) — alpha/beta/rc, features mais novas, pode ter bugs"
      MSG_LOOKUP_STABLE="Buscando a última release ESTÁVEL..."
      MSG_FALLBACK_STABLE="Não consegui resolver um tag estável do GitHub (rate limit ou sem estáveis ainda)."
      MSG_FALLBACK_LATEST="Caindo para o tag rolling ':latest' do Docker Hub."
      MSG_LOOKUP_PRE="Buscando a última PRE-release..."
      MSG_FALLBACK_PRE="Não consegui resolver um tag de pre-release do GitHub (rate limit ou sem releases)."
      MSG_FALLBACK_NEXT="Caindo para o tag rolling ':next' do Docker Hub."
      MSG_VERSION="Versão a instalar:"
      MSG_AFTER_STEP5="Antes de gerar o compose, mais uma decisão sobre manutenção."
      MSG_STEP_AUTOUPDATE="Passo 6 / 9 — Auto-atualização"
      MSG_AUTOUPDATE_DESC1="Quer que o Diluxite se atualize sozinho quando sair uma versão nova?"
      MSG_AUTOUPDATE_DESC2="O Watchtower verifica o Docker Hub a cada 6h e reconcilia os containers. Só mexe nos do Diluxite (por label, não pisa outros Watchtowers do host)."
      MSG_AUTOUPDATE_WARN="Em alpha podem entrar breaking changes — se quiser controlar cada upgrade lendo os release notes, responda N."
      MSG_AUTOUPDATE_Q="Ativar auto-atualização? [y/N]: "
      MSG_AUTOUPDATE_ON="Auto-atualização ativada (Watchtower verifica a cada 6h)."
      MSG_AUTOUPDATE_OFF="Auto-atualização desativada. O banner amarelo na UI avisa quando há versão nova."
      MSG_AU_NOTPROD="⚠️  NÃO recomendado em produção. Auto-atualizar pode trazer um breaking change sem revisão. O risco é seu."
      MSG_AU_SOCKET="⚠️  Watchtower monta o socket do Docker → tem acesso COMPLETO ao seu Docker (= root do host). Imagem: nickfedor/watchtower (fork open-source mantido)."
      MSG_AU_ACCEPT="Você aceita esses riscos e ativa a auto-atualização?"
      MSG_AU_DECLINED="Beleza, fica em updates manuais (mais seguro). Atualize com a opção 'Atualizar' do menu."
      MSG_AFTER_STEP_AUTOUPDATE="Última decisão: pessoal ou multi-usuário?"
      MSG_STEP6_MODE="Passo 7 / 9 — Modo de instalação"
      MSG_MODE_1="1) Local — sem login, single-user (RECOMENDADO para o seu PC pessoal)"
      MSG_MODE_2="2) Server — login obrigatório com email + password (para times, empresa, internet)"
      MSG_ADMIN_EMAIL="Email do primeiro admin"
      MSG_ADMIN_PASSWORD="Password do admin (mínimo 8 caracteres)"
      MSG_ADMIN_PASSWORD_CONFIRM="Repita o password"
      MSG_PASSWORD_MISMATCH="Os passwords não coincidem — comece de novo."
      MSG_PASSWORD_SHORT="O password deve ter pelo menos 8 caracteres."
      MSG_MODE_LOCAL_OK="Modo: local (passwordless single-user)"
      MSG_MODE_SERVER_OK="Modo: server, admin:"
      MSG_AFTER_STEP6_MODE="Pronto, tenho tudo. Gerando configuração."
      MSG_STEP7="Passo 8 / 9 — Gerando a configuração"
      MSG_COMPOSE_READY="docker-compose.yml pronto"
      MSG_AFTER_STEP7="Hora de subir o Diluxite — pode demorar alguns minutos na primeira vez."
      MSG_STEP8="Passo 9 / 9 — Iniciando o Diluxite"
      MSG_PULLING="Baixando imagens do Docker Hub..."
      MSG_STARTING="Iniciando containers..."
      MSG_CONTAINERS_UP="Containers no ar"
      MSG_WAITING="Esperando o Diluxite ficar saudável..."
      MSG_HEALTHY="Diluxite está saudável"
      MSG_HEALTH_TIMEOUT="Diluxite não respondeu em 2 minutos."
      MSG_LOGS="Logs:"
      MSG_SEED_LOADING="Carregando seed demo (1500 notas)... isso leva alguns minutos."
      MSG_SEED_FAIL="O seed falhou — você pode rodar depois com:"
      MSG_DONE_TITLE="🎉  Diluxite no ar!  🎉"
      MSG_OPEN_NOW="Abra agora:"
      MSG_FIRST_LOAD1="Na primeira carga você vai ver o painel de boas-vindas. O endpoint MCP"
      MSG_FIRST_LOAD2="para conectar Claude / Copilot está em /mcp na mesma porta."
      MSG_WHATS_INSTALLED="─── O que foi instalado ───"
      MSG_VERSION_LABEL="Versão:"
      MSG_EMBEDDER_LABEL="Embedder:"
      MSG_DATA_LABEL="Pasta de dados:"
      MSG_INSTALL_LABEL="Diretório de instalação:"
      MSG_SEED_LOADED="Seed carregado:"
      MSG_SEED_LOADED_DESC="1500 notas demo (tente a busca com Ctrl/Cmd+K)"
      MSG_EMB_OLLAMA="Ollama"
      MSG_EMB_AZURE="Azure OpenAI"
      MSG_EMB_DET="Determinístico local"
      MSG_USEFUL_CMDS="─── Comandos úteis ───"
      MSG_USEFUL_FROM="(rode a partir de"
      MSG_CMD_LOGS="acompanhar os logs"
      MSG_CMD_DOWN="parar tudo (seus dados ficam)"
      MSG_CMD_UPDATE="atualizar para uma imagem mais nova"
      MSG_CMD_AUTOUPDATE="habilitar auto-update via Watchtower"
      MSG_CMD_FORCE_UPDATE="forçar update agora (sem esperar pelo Watchtower)"
      MSG_AUTOUPDATE_LABEL="Auto-atualização:"
      MSG_AUTOUPDATE_LABEL_ON="ON (Watchtower verifica a cada 6 h)"
      MSG_AUTOUPDATE_LABEL_OFF="OFF (manual — banner amarelo avisa)"
      MSG_BACKUP="─── Backup ───"
      MSG_BACKUP_DESC="Copie"
      MSG_BACKUP_DESC2="— é seu vault completo + DB."
      MSG_THANKS="Obrigado por experimentar o Diluxite!"
      MSG_QUESTIONS="Perguntas, issues, ideias:"
      MSG_BUILT_BY="Feito por:"
      MSG_HINT_PATH="Dica: aperte Enter para usar o caminho proposto entre colchetes, ou digite um próprio."
      MSG_HINT_OPTION="Dica: aperte Enter para a opção padrão [1] (a recomendada), ou digite o número que preferir."
      MSG_HINT_YN_Y="Dica: Enter = Sim. Digite N para dizer Não."
      MSG_HINT_TEXT="Dica: Enter usa o valor proposto entre colchetes, ou digite um próprio."
      MSG_HINT_LANG="Dica: Enter usa English. Digite 2 ou 3 para os outros idiomas."
      ;;
    *)
      MSG_TAGLINE="Self-hosted memory for your AI."
      MSG_SUBTITLE="Markdown notes + hybrid search + MCP server. AGPL-3.0."
      MSG_BY="By"
      MSG_OS_UNKNOWN="an unknown OS"
      MSG_GREETING_PRE="Hi there — looks like you're running"
      MSG_GREETING_POST="Let's get Diluxite installed on this machine."
      MSG_NOT_ROOT="Don't run this as root. Use a normal user with sudo access."
      MSG_OS_NOT_RECOGNIZED="We didn't recognise your OS. Diluxite officially supports Linux, macOS, WSL2 and Git Bash on Windows."
      MSG_CONTINUE_ANYWAY="Continue anyway? [y/N]: "
      MSG_STEP1="Step 1 / 9 — Checking pre-requisites"
      MSG_DOCKER_MISSING="Docker isn't installed."
      MSG_DOCKER_OPEN="Opening Docker download page in your browser:"
      MSG_DOCKER_THEN="Install Docker, start it, then re-run this script."
      MSG_DOCKER_PRESENT="Docker present:"
      MSG_DOCKER_DOWN="Docker is installed but the daemon isn't running."
      MSG_DOCKER_START_LINUX="Start it with: sudo systemctl start docker"
      MSG_DOCKER_START_OTHER="Open Docker Desktop and wait until it's ready."
      MSG_DOCKER_UP="Docker daemon is up"
      MSG_COMPOSE_MISSING="Docker Compose v2 isn't available. Update Docker."
      MSG_COMPOSE_OK="Docker Compose v2 available"
      MSG_PORT_BUSY="Port"
      MSG_PORT_BUSY_AFTER="is busy. Free it and try again."
      MSG_PORTS_FREE="Ports 3030 / 5173 / 5432 are free"
      MSG_DISK_LOW="Not enough free disk space"
      MSG_DISK_NEEDED="Diluxite needs at least 3 GB."
      MSG_DISK_FREE="Free disk:"
      MSG_AFTER_STEP1="Great — your system is ready. Now let's decide where Diluxite stores your data."
      MSG_START_Q="What do you want to do?"
      MSG_START_INSTALL="Install Diluxite (fresh install)"
      MSG_START_RESTORE="Restore from a backup (.tar.gz)"
      MSG_START_EXIT="Exit"
      MSG_START_BACKUP_PATH="Backup path (.tar.gz)"
      MSG_START_BYE="Done, no changes."
      MSG_STEP2="Step 2 / 9 — Where to keep your data"
      MSG_STEP2_HELP1="This is the folder where your notes, the Postgres database and the"
      MSG_STEP2_HELP2="configuration will live. To back up Diluxite you just copy this folder."
      MSG_STEP2_PATH="Path for your data"
      MSG_STEP2_INSTALL="Install path (where docker-compose.yml lives)"
      MSG_DATA_AT="Data path:"
      MSG_DATA_EXISTS="⚠️  There is already a Diluxite database at this path (previous install)."
      MSG_DATA_REUSE="Reuse that data (keep your existing notes)"
      MSG_DATA_WIPE="Start fresh (DELETE the existing database)"
      MSG_DATA_WIPING="Deleting the existing database…"
      MSG_DATA_WIPED="Previous database deleted — starting 100% clean."
      MSG_DATA_REUSING="Reusing the existing data."
      MSG_INSTALL_AT="Install path:"
      MSG_AFTER_STEP2="Perfect. Now let's pick your AI embeddings engine — what powers semantic search."
      MSG_STEP3="Step 3 / 9 — Embeddings engine"
      MSG_EMB_1="1) Ollama local with mxbai-embed-large (RECOMMENDED)"
      MSG_EMB_1_DESC="High quality, multilingual, no keys, no cloud. 669 MB one-time download."
      MSG_EMB_2="2) Azure OpenAI (top quality, needs an account, costs per token)"
      MSG_EMB_3="3) Deterministic local (no real semantic quality — only useful for testing)"
      MSG_CHOICE="Choice"
      MSG_OLLAMA_OK="Ollama already installed:"
      MSG_OLLAMA_MISSING="Ollama isn't installed on this host."
      MSG_OLLAMA_INSTALL_Q="Want me to install it now (curl ollama.com/install.sh | sh)? [Y/n]: "
      MSG_OLLAMA_INSTALLING="Installing Ollama..."
      MSG_OLLAMA_INSTALL_FAIL="The install failed. Try manually:"
      MSG_OLLAMA_INSTALLED="Ollama installed:"
      MSG_OLLAMA_REQUIRED="Without Ollama we can't continue with this option."
      MSG_OLLAMA_WIN="Opening:"
      MSG_OLLAMA_WIN_AFTER="Install Ollama (the page should open in your browser) and re-run this script."
      MSG_OLLAMA_OTHER="Download it from https://ollama.com/download and re-run this script."
      MSG_OLLAMA_PULL="Pulling mxbai-embed-large (~669 MB, one-time)..."
      MSG_MODEL_OK="Model downloaded"
      MSG_AZURE_EP="Azure OpenAI endpoint (https://<resource>.openai.azure.com)"
      MSG_AZURE_KEY="Azure OpenAI API key"
      MSG_AZURE_DEPLOY="Deployment name [text-embedding-3-large]"
      MSG_AZURE_OK="Azure OpenAI configured"
      MSG_DETERMINISTIC="Deterministic embedder — no semantic quality, only fine for trying things out."
      MSG_INVALID="Invalid choice:"
      MSG_AFTER_STEP3="Almost there. Want to start fresh or with a demo vault?"
      MSG_STEP4="Step 4 / 9 — Initial content"
      MSG_SEED_1="1) Empty vault"
      MSG_SEED_2="2) Demo seed (1500 technical notes — handy for exploring features without writing)"
      MSG_AFTER_STEP4="Last questions: which release channel would you like to follow?"
      MSG_STEP5="Step 5 / 9 — Which version to install"
      MSG_CHAN_1="1) Stable (:latest) — tested release, no surprises (RECOMMENDED for real use)"
      MSG_CHAN_2="2) Pre-release (:next) — alpha/beta/rc, newer features, may have bugs"
      MSG_LOOKUP_STABLE="Looking up the latest STABLE release..."
      MSG_FALLBACK_STABLE="Couldn't resolve a stable tag from GitHub (rate-limited or no stable yet)."
      MSG_FALLBACK_LATEST="Falling back to the rolling ':latest' tag from Docker Hub."
      MSG_LOOKUP_PRE="Looking up the latest PRE-release..."
      MSG_FALLBACK_PRE="Couldn't resolve a pre-release tag from GitHub (rate-limited or no releases)."
      MSG_FALLBACK_NEXT="Falling back to the rolling ':next' tag from Docker Hub."
      MSG_VERSION="Version to install:"
      MSG_AFTER_STEP5="Before we generate the compose, one more decision about maintenance."
      MSG_STEP_AUTOUPDATE="Step 6 / 9 — Auto-update"
      MSG_AUTOUPDATE_DESC1="Should Diluxite update itself when a new version is published?"
      MSG_AUTOUPDATE_DESC2="Watchtower checks Docker Hub every 6h and reconciles the containers. It only touches Diluxite's (label-based — won't clash with other Watchtowers on the host)."
      MSG_AUTOUPDATE_WARN="On alpha builds breaking changes can land — if you'd rather upgrade only after reading the release notes, answer N."
      MSG_AUTOUPDATE_Q="Enable auto-update? [y/N]: "
      MSG_AUTOUPDATE_ON="Auto-update enabled (Watchtower checks every 6h)."
      MSG_AUTOUPDATE_OFF="Auto-update disabled. The yellow banner in the UI will tell you when a new version is out."
      MSG_AU_NOTPROD="⚠️  NOT recommended in production. Auto-updating can pull a breaking change before you review it. The risk is yours."
      MSG_AU_SOCKET="⚠️  Watchtower mounts the Docker socket → it has FULL access to your Docker (= host root). Image: nickfedor/watchtower (maintained open-source fork)."
      MSG_AU_ACCEPT="Do you accept those risks and enable auto-update?"
      MSG_AU_DECLINED="Got it — staying on manual updates (safest). Update via the 'Update' menu option."
      MSG_AFTER_STEP_AUTOUPDATE="Last decision: personal install or multi-user?"
      MSG_STEP6_MODE="Step 7 / 9 — Installation mode"
      MSG_MODE_1="1) Local — passwordless, single-user (RECOMMENDED for your personal PC)"
      MSG_MODE_2="2) Server — login required with email + password (for teams, company, internet)"
      MSG_ADMIN_EMAIL="First admin email"
      MSG_ADMIN_PASSWORD="Admin password (min 8 chars)"
      MSG_ADMIN_PASSWORD_CONFIRM="Repeat password"
      MSG_PASSWORD_MISMATCH="Passwords don't match — start over."
      MSG_PASSWORD_SHORT="Password must be at least 8 characters."
      MSG_MODE_LOCAL_OK="Mode: local (passwordless single-user)"
      MSG_MODE_SERVER_OK="Mode: server, admin:"
      MSG_AFTER_STEP6_MODE="All set. Generating your configuration."
      MSG_STEP7="Step 8 / 9 — Generating your configuration"
      MSG_COMPOSE_READY="docker-compose.yml ready"
      MSG_AFTER_STEP7="Time to bring Diluxite online — this may take a couple of minutes the first time."
      MSG_STEP8="Step 9 / 9 — Starting Diluxite"
      MSG_PULLING="Pulling images from Docker Hub..."
      MSG_STARTING="Starting containers..."
      MSG_CONTAINERS_UP="Containers up"
      MSG_WAITING="Waiting for Diluxite to be healthy..."
      MSG_HEALTHY="Diluxite is healthy"
      MSG_HEALTH_TIMEOUT="Diluxite didn't respond within 2 minutes."
      MSG_LOGS="Logs:"
      MSG_SEED_LOADING="Loading demo seed (1500 notes)... this takes a few minutes."
      MSG_SEED_FAIL="Seed failed — you can run it later with:"
      MSG_DONE_TITLE="🎉  Diluxite is up and running!  🎉"
      MSG_OPEN_NOW="Open it now:"
      MSG_FIRST_LOAD1="On first load you'll see the welcome panel. The MCP endpoint"
      MSG_FIRST_LOAD2="for connecting Claude / Copilot is at /mcp on the same port."
      MSG_WHATS_INSTALLED="─── What's installed ───"
      MSG_VERSION_LABEL="Version:"
      MSG_EMBEDDER_LABEL="Embedder:"
      MSG_DATA_LABEL="Data folder:"
      MSG_INSTALL_LABEL="Install dir:"
      MSG_SEED_LOADED="Seed loaded:"
      MSG_SEED_LOADED_DESC="1500 demo notes (try the search bar with Ctrl/Cmd+K)"
      MSG_EMB_OLLAMA="Ollama"
      MSG_EMB_AZURE="Azure OpenAI"
      MSG_EMB_DET="Deterministic local"
      MSG_USEFUL_CMDS="─── Useful commands ───"
      MSG_USEFUL_FROM="(run from"
      MSG_CMD_LOGS="tail the logs"
      MSG_CMD_DOWN="stop everything (your data stays)"
      MSG_CMD_UPDATE="update to a newer image"
      MSG_CMD_AUTOUPDATE="enable Watchtower auto-update"
      MSG_CMD_FORCE_UPDATE="force an update now (don't wait for Watchtower)"
      MSG_AUTOUPDATE_LABEL="Auto-update:"
      MSG_AUTOUPDATE_LABEL_ON="ON (Watchtower checks every 6 h)"
      MSG_AUTOUPDATE_LABEL_OFF="OFF (manual — yellow banner will notify)"
      MSG_BACKUP="─── Backup ───"
      MSG_BACKUP_DESC="Just copy"
      MSG_BACKUP_DESC2="— that's your whole vault + DB."
      MSG_THANKS="Thanks for trying Diluxite!"
      MSG_QUESTIONS="Questions, issues, ideas:"
      MSG_BUILT_BY="Built by:"
      MSG_HINT_PATH="Tip: press Enter to use the path shown in brackets, or type your own."
      MSG_HINT_OPTION="Tip: press Enter for the default option [1] (the recommended one), or type the number you prefer."
      MSG_HINT_YN_Y="Tip: Enter = Yes. Type N to say No."
      MSG_HINT_TEXT="Tip: Enter uses the value shown in brackets, or type your own."
      MSG_HINT_LANG="Tip: Enter uses English. Type 2 or 3 for the other languages."
      ;;
  esac
}

# ============================================================================
# Compose rendering — usado por la instalación Y por "Reconfigurar". Toma
# todas las variables de configuración globales (VERSION, DATA_PATH, EMB_OPT,
# HTTPS_DOMAIN, OIDC_*, etc.) y (re)genera docker-compose.yml + Caddyfile.
# ============================================================================
render_compose() {
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

  # When HTTPS via Caddy is enabled, the diluxite container does NOT publish
  # :5173 to the host — Caddy proxies it through the internal docker network.
  # Otherwise we keep the legacy ports block so plain HTTP install just works.
  DILUXITE_PORTS_BLOCK='    ports:\
      - "'"${WEB_PORT}"':5173"'
  if [ -n "${HTTPS_DOMAIN}" ]; then
    DILUXITE_PORTS_BLOCK='    expose:\
      - "5173"'
  fi

  # Use a delimiter unlikely to appear in sed-substituted values. Passwords may
  # contain `|`, `/`, `&`. We pick char 1 (SOH) which is forbidden in env vars.
  DLM=$'\001'
  sed -e "s${DLM}__DILUXITE_VERSION__${DLM}${VERSION}${DLM}g" \
      -e "s${DLM}__DATA_PATH__${DLM}${DATA_PATH}${DLM}g" \
      -e "s${DLM}__AUTH_MODE__${DLM}${AUTH_MODE}${DLM}g" \
      -e "s${DLM}__ADMIN_EMAIL__${DLM}${ADMIN_EMAIL}${DLM}g" \
      -e "s${DLM}__ADMIN_PASSWORD__${DLM}${ADMIN_PASSWORD}${DLM}g" \
      -e "s${DLM}__OLLAMA_MODEL__${DLM}${OLLAMA_MODEL}${DLM}g" \
      -e "s${DLM}__OLLAMA_DIMS__${DLM}${OLLAMA_DIMS}${DLM}g" \
      -e "s${DLM}__OLLAMA_ENDPOINT__${DLM}${OLLAMA_ENDPOINT}${DLM}g" \
      -e "s${DLM}__AZURE_ENDPOINT__${DLM}${AZURE_ENDPOINT}${DLM}g" \
      -e "s${DLM}__AZURE_KEY__${DLM}${AZURE_KEY}${DLM}g" \
      -e "s${DLM}__AZURE_DEPLOYMENT__${DLM}${AZURE_DEPLOYMENT}${DLM}g" \
      -e "s${DLM}__CF_TEAM__${DLM}${CF_TEAM:-}${DLM}g" \
      -e "s${DLM}__CF_AUD__${DLM}${CF_AUD:-}${DLM}g" \
      -e "s${DLM}__EXTRA_HOSTS__${DLM}${EXTRA_HOSTS_LINE}${DLM}" \
      -e "s${DLM}__DILUXITE_PORTS__${DLM}${DILUXITE_PORTS_BLOCK}${DLM}" \
      -e "s${DLM}__WATCHTOWER_PROFILES__${DLM}${WATCHTOWER_PROFILES_LINE}${DLM}" \
      "${template_path}" > "${compose_path}"

  # Inyectar las env vars opcionales (OIDC + trusted-header) directamente al
  # bloque environment: del servicio diluxite. Lo hacemos con awk DESPUES del
  # sed para evitar pelearnos con secrets que contengan `&` o `/`.
  if [ -n "${OIDC_ISSUER}${TRUSTED_HEADER}" ]; then
    EXTRA_ENV_BLOCK=""
    if [ -n "${OIDC_ISSUER}" ]; then
      EXTRA_ENV_BLOCK="      DILUXITE_OIDC_ISSUER: \"${OIDC_ISSUER}\"
      DILUXITE_OIDC_CLIENT_ID: \"${OIDC_CLIENT_ID}\"
      DILUXITE_OIDC_CLIENT_SECRET: \"${OIDC_CLIENT_SECRET}\"
      DILUXITE_OIDC_REDIRECT_URI: \"${OIDC_REDIRECT_URI}\""
    fi
    if [ -n "${TRUSTED_HEADER}" ]; then
      if [ -n "${EXTRA_ENV_BLOCK}" ]; then
        EXTRA_ENV_BLOCK="${EXTRA_ENV_BLOCK}
      DILUXITE_TRUSTED_IDENTITY_HEADER: \"${TRUSTED_HEADER}\""
      else
        EXTRA_ENV_BLOCK="      DILUXITE_TRUSTED_IDENTITY_HEADER: \"${TRUSTED_HEADER}\""
      fi
    fi
    tmpfile="$(mktemp)"
    awk -v extra="${EXTRA_ENV_BLOCK}" '
      /AZURE_OPENAI_DEPLOYMENT:/ { print; print extra; next }
      { print }
    ' "${compose_path}" > "${tmpfile}"
    mv "${tmpfile}" "${compose_path}"
  fi

  # Generar Caddyfile si tenemos domain.
  if [ -n "${HTTPS_DOMAIN}" ]; then
    caddyfile_path="${INSTALL_DIR}/Caddyfile"
    cat > "${caddyfile_path}" <<EOF
# Generated by Diluxite installer. Edit and run \`docker compose restart caddy\`
# to apply changes. ACME (Lets Encrypt) is handled automatically.
{
    email ${HTTPS_ACME_EMAIL}
}

${HTTPS_DOMAIN} {
    encode zstd gzip

    # /collab es WebSocket — necesita upgrade handling.
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }

    reverse_proxy diluxite:5173 {
        flush_interval -1
    }
}
EOF
    ok "Caddyfile generado para ${HTTPS_DOMAIN}"
  fi

  ok "${MSG_COMPOSE_READY}"
}

# ============================================================================
# Management mode — estado, helpers de config persistida, y las acciones del
# menú (update / reconfigure / status / backup / restore / uninstall).
# ============================================================================

STATE_FILE_NAME=".diluxite-install.env"

# Extrae el valor de una env var YAML (`      KEY: "valor"`) del compose.
# Lo usamos para preservar secretos (admin pwd, azure key, oidc secret) que
# NO guardamos en el state file pero sí necesitamos al re-renderizar.
compose_env_get() {
  local file="$1" key="$2"
  [ -f "${file}" ] || { echo ""; return 0; }
  sed -n "s|^[[:space:]]*${key}:[[:space:]]*\"\(.*\)\"[[:space:]]*\$|\1|p" "${file}" | head -n1
}

# Resuelve el tag de imagen disponible para un canal (1=estable, 2=pre).
mgmt_lookup_version() {
  local ch="$1" v=""
  if [ "${ch}" = "1" ]; then
    v="$(curl -fsSL "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases/latest" 2>/dev/null \
      | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('tag_name','').lstrip('v'))
except Exception: pass" 2>/dev/null || true)"
    [ -z "${v}" ] && v="latest"
  else
    v="$(curl -fsSL "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases" 2>/dev/null \
      | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); print(d[0]['tag_name'].lstrip('v') if d else '')
except Exception: pass" 2>/dev/null || true)"
    [ -z "${v}" ] && v="next"
  fi
  echo "${v}"
}

# Devuelve `--profile https` cuando hay dominio, para los `docker compose`.
compose_profiles() {
  [ -n "${HTTPS_DOMAIN:-}" ] && echo "--profile https" || echo ""
}

# Lee /api/info de la instancia corriendo (version real, authMode, embedder).
app_info() {
  curl -fsS "http://localhost:${WEB_PORT}/api/info" 2>/dev/null || true
}

# La URL para abrir Diluxite (https con dominio, o localhost:puerto).
diluxite_url() {
  [ -n "${HTTPS_DOMAIN:-}" ] && echo "https://${HTTPS_DOMAIN}" || echo "http://localhost:${WEB_PORT}"
}

# Línea de cierre coherente "abrilo ahora → URL". La usan update / reconfigure /
# seed / status para que toda acción termine clara y con la URL a mano.
show_open_line() {
  echo ""
  echo -e "  ${BOLD}${MSG_OPEN_NOW}${NC}  ${GREEN}${BOLD}→  $(diluxite_url)  ←${NC}"
}

# Extrae un campo de un JSON (via python3). null→"", true/false→"true"/"false".
json_field() {
  printf '%s' "$1" | python3 -c "import json,sys
try:
  v=json.load(sys.stdin).get('$2','')
  if v is None: v=''
  elif v is True: v='true'
  elif v is False: v='false'
  print(v)
except Exception: pass" 2>/dev/null || true
}

# Persiste la config (sin secretos) en INSTALL_DIR/.diluxite-install.env.
write_state() {
  local f="${INSTALL_DIR}/${STATE_FILE_NAME}"
  {
    echo "# Diluxite install state — generado por install.sh. NO contiene secretos."
    echo "# (admin password, azure key y oidc secret viven solo en docker-compose.yml)"
    echo "DLX_LANG=\"${LANG_CHOICE:-1}\""
    echo "DLX_CHANNEL=\"${CHANNEL:-2}\""
    echo "DLX_AUTOUPDATE=\"${AUTOUPDATE_ON:-1}\""
    echo "DLX_VERSION=\"${VERSION:-next}\""
    echo "DLX_DATA_PATH=\"${DATA_PATH}\""
    echo "DLX_INSTALL_DIR=\"${INSTALL_DIR}\""
    echo "DLX_WEB_PORT=\"${WEB_PORT:-5173}\""
    echo "DLX_EMB_OPT=\"${EMB_OPT:-3}\""
    echo "DLX_OLLAMA_MODEL=\"${OLLAMA_MODEL:-}\""
    echo "DLX_OLLAMA_DIMS=\"${OLLAMA_DIMS:-}\""
    echo "DLX_OLLAMA_ENDPOINT=\"${OLLAMA_ENDPOINT:-}\""
    echo "DLX_AZURE_ENDPOINT=\"${AZURE_ENDPOINT:-}\""
    echo "DLX_AZURE_DEPLOYMENT=\"${AZURE_DEPLOYMENT:-}\""
    echo "DLX_AUTH_MODE=\"${AUTH_MODE:-local}\""
    echo "DLX_ADMIN_EMAIL=\"${ADMIN_EMAIL:-}\""
    echo "DLX_HTTPS_DOMAIN=\"${HTTPS_DOMAIN:-}\""
    echo "DLX_HTTPS_ACME_EMAIL=\"${HTTPS_ACME_EMAIL:-}\""
    echo "DLX_OIDC_ISSUER=\"${OIDC_ISSUER:-}\""
    echo "DLX_OIDC_CLIENT_ID=\"${OIDC_CLIENT_ID:-}\""
    echo "DLX_OIDC_REDIRECT_URI=\"${OIDC_REDIRECT_URI:-}\""
    echo "DLX_TRUSTED_HEADER=\"${TRUSTED_HEADER:-}\""
    echo "DLX_CF_TEAM=\"${CF_TEAM:-}\""
    echo "DLX_CF_AUD=\"${CF_AUD:-}\""
    echo "DLX_UPDATED_AT=\"$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)\""
  } > "${f}"
  chmod 600 "${f}" 2>/dev/null || true
}

# Carga la config de una instalación existente. Prefiere el state file; si no
# existe (instalación previa a esta feature) infiere lo posible del compose.
load_state() {
  local dir="$1"
  local f="${dir}/${STATE_FILE_NAME}"
  # shellcheck disable=SC1090
  [ -f "${f}" ] && . "${f}"

  INSTALL_DIR="${DLX_INSTALL_DIR:-${dir}}"
  local cf="${INSTALL_DIR}/docker-compose.yml"

  DATA_PATH="${DLX_DATA_PATH:-${dir}/data}"
  CHANNEL="${DLX_CHANNEL:-2}"
  # Auto-update: del state file, o inferido del compose (watchtower detrás del
  # profile `autoupdate` = OFF). NUNCA asumir ON por default — eso levantaría
  # Watchtower en instalaciones que usan cron/manual y lo tienen apagado.
  AUTOUPDATE_ON="${DLX_AUTOUPDATE:-}"
  if [ -z "${AUTOUPDATE_ON}" ]; then
    if grep -q 'profiles: \["autoupdate"\]' "${cf}" 2>/dev/null; then AUTOUPDATE_ON=0; else AUTOUPDATE_ON=1; fi
  fi
  WEB_PORT="${DLX_WEB_PORT:-5173}"

  # Inferencia desde el compose cuando el state file no tiene el dato.
  VERSION="${DLX_VERSION:-}"
  [ -z "${VERSION}" ] && VERSION="$(sed -n 's|^[[:space:]]*image:[[:space:]]*soydiloreto/diluxite:\(.*\)$|\1|p' "${cf}" 2>/dev/null | head -n1)"
  [ -z "${VERSION}" ] && VERSION="next"

  AUTH_MODE="${DLX_AUTH_MODE:-$(compose_env_get "${cf}" DILUXITE_AUTH_MODE)}"
  [ -z "${AUTH_MODE}" ] && AUTH_MODE="local"
  ADMIN_EMAIL="${DLX_ADMIN_EMAIL:-$(compose_env_get "${cf}" DILUXITE_ADMIN_EMAIL)}"

  OLLAMA_MODEL="${DLX_OLLAMA_MODEL:-$(compose_env_get "${cf}" OLLAMA_EMBEDDING_MODEL)}"
  OLLAMA_DIMS="${DLX_OLLAMA_DIMS:-$(compose_env_get "${cf}" OLLAMA_EMBEDDING_DIMENSIONS)}"
  OLLAMA_ENDPOINT="${DLX_OLLAMA_ENDPOINT:-$(compose_env_get "${cf}" OLLAMA_ENDPOINT)}"
  AZURE_ENDPOINT="${DLX_AZURE_ENDPOINT:-$(compose_env_get "${cf}" AZURE_OPENAI_ENDPOINT)}"
  AZURE_DEPLOYMENT="${DLX_AZURE_DEPLOYMENT:-$(compose_env_get "${cf}" AZURE_OPENAI_DEPLOYMENT)}"

  HTTPS_DOMAIN="${DLX_HTTPS_DOMAIN:-}"
  if [ -z "${HTTPS_DOMAIN}" ] && [ -f "${INSTALL_DIR}/Caddyfile" ]; then
    HTTPS_DOMAIN="$(sed -n 's|^\([A-Za-z0-9.-]\+\) {[[:space:]]*$|\1|p' "${INSTALL_DIR}/Caddyfile" 2>/dev/null | head -n1)"
  fi
  HTTPS_ACME_EMAIL="${DLX_HTTPS_ACME_EMAIL:-${ADMIN_EMAIL}}"

  OIDC_ISSUER="${DLX_OIDC_ISSUER:-$(compose_env_get "${cf}" DILUXITE_OIDC_ISSUER)}"
  OIDC_CLIENT_ID="${DLX_OIDC_CLIENT_ID:-$(compose_env_get "${cf}" DILUXITE_OIDC_CLIENT_ID)}"
  OIDC_REDIRECT_URI="${DLX_OIDC_REDIRECT_URI:-$(compose_env_get "${cf}" DILUXITE_OIDC_REDIRECT_URI)}"
  TRUSTED_HEADER="${DLX_TRUSTED_HEADER:-$(compose_env_get "${cf}" DILUXITE_TRUSTED_IDENTITY_HEADER)}"
  CF_TEAM="${DLX_CF_TEAM:-$(compose_env_get "${cf}" DILUXITE_CF_ACCESS_TEAM_DOMAIN)}"
  CF_AUD="${DLX_CF_AUD:-$(compose_env_get "${cf}" DILUXITE_CF_ACCESS_AUD)}"

  # Embedder option (1 ollama / 2 azure / 3 deterministic) si el state no lo dice.
  EMB_OPT="${DLX_EMB_OPT:-}"
  if [ -z "${EMB_OPT}" ]; then
    if [ -n "${OLLAMA_MODEL}" ]; then EMB_OPT=1
    elif [ -n "${AZURE_ENDPOINT}" ]; then EMB_OPT=2
    else EMB_OPT=3; fi
  fi

  # Secretos: SIEMPRE desde el compose (no se guardan en el state file).
  ADMIN_PASSWORD="$(compose_env_get "${cf}" DILUXITE_ADMIN_PASSWORD)"
  AZURE_KEY="$(compose_env_get "${cf}" AZURE_OPENAI_API_KEY)"
  OIDC_CLIENT_SECRET="$(compose_env_get "${cf}" DILUXITE_OIDC_CLIENT_SECRET)"

  # Línea de profile de Watchtower coherente con el auto-update guardado.
  if [ "${AUTOUPDATE_ON}" = "1" ]; then WATCHTOWER_PROFILES_LINE=""
  else WATCHTOWER_PROFILES_LINE='    profiles: ["autoupdate"]'; fi
}

# Mensajes i18n del modo gestión (es/pt/en) — set tras conocer LANGCHOICE.
set_mgmt_messages() {
  case "${LANGCHOICE}" in
    es)
      M_DETECTED="Diluxite ya está instalado"
      M_MENU_TITLE="¿Qué querés hacer?"
      M_M1="Actualizar          (pull + up, misma config)"
      M_M2="Reconfigurar        (canal, HTTPS, SSO, trusted-header, embedder)"
      M_M3="Estado / logs       (solo lectura)"
      M_M4="Backup              (pg_dump + config + manifest)"
      M_M5="Restore             (desde un backup)"
      M_M6="Desinstalar         (bajar stack, opción de borrar datos)"
      M_M7="Seed de datos de prueba (cargar notas demo)"
      M_M0="Salir"
      M_SEED_TITLE="Seed de datos de prueba"
      M_SEED_NOSPACE="No hay ningún workspace en la base."
      M_SEED_PICK="¿En qué workspace querés cargar las notas demo?"
      M_SEED_ONE="Único workspace:"
      M_SEED_COUNT="¿Cuántas notas demo?"
      M_SEED_CONFIRM="¿Cargar las notas demo en ese workspace?"
      M_SEED_RUNNING="Cargando notas demo (tarda unos minutos)…"
      M_SEED_DONE="Seed completado."
      M_PROMPT="Opción"
      M_CONTINUE="Enter para volver al menú… "
      M_NO_INSTALL="No encontré una instalación de Diluxite en"
      M_APPLIED="Cambios aplicados."
      M_UPDATED="Diluxite actualizado."
      M_BYE="Listo, sin cambios."
      M_PULLING="Bajando imágenes…"
      M_RESTARTING="Reiniciando el stack…"
      M_ST_VERSION="Versión instalada"
      M_ST_AVAIL="Versión disponible"
      M_ST_CHANNEL="Canal"
      M_ST_AUTOUPDATE="Auto-update"
      M_ST_EMBEDDER="Embedder"
      M_ST_AUTH="Modo / auth"
      M_ST_HTTPS="HTTPS / dominio"
      M_ST_DATA="Datos"
      M_ST_WEB="Web"
      M_ST_NOTES="Notas en la base"
      M_ST_DISK="Espacio libre"
      M_ST_OS="Sistema"
      M_ST_MCP="MCP (para Claude/Copilot)"
      M_ST_SPACES="Workspaces"
      M_ST_BADCONTAINERS="Containers con problemas (revisá los logs):"
      M_ST_CONTAINERS="Containers"
      M_ST_HEALTH="Salud"
      M_ST_HEALTHY="OK (responde)"
      M_ST_UNHEALTHY="no responde"
      M_ST_UPDATE_AVAIL="¡Hay una versión nueva disponible! Corré --update."
      M_ST_UPTODATE="Estás en la última versión del canal."
      M_RC_TITLE="Reconfigurar"
      M_RC_1="Canal de updates (estable :latest / pre :next)"
      M_RC_2="Auto-update (on/off)"
      M_RC_3="HTTPS / dominio (Caddy + Lets Encrypt)"
      M_RC_4="OIDC SSO (Entra / Google / Okta / Authentik)"
      M_RC_5="Trusted-header proxy (Cloudflare Access / Authelia)"
      M_RC_6="Embedder / motor de búsqueda"
      M_RC_7="Email del admin"
      M_RC_0="Volver"
      M_RC_CHAN_Q="Canal [1=estable :latest, 2=pre :next]"
      M_RC_AU_Q="¿Auto-update activado? [y/N]"
      M_RC_DOMAIN_Q="Dominio (enter vacío = desactivar HTTPS)"
      M_RC_ACME_Q="Email para Lets Encrypt"
      M_RC_HTTPS_OFF="HTTPS desactivado — vuelve a HTTP plano en el puerto web."
      M_RC_EMB_WARN="OJO: cambiar de embedder puede requerir REINDEXAR. Si cambia la dimensión, la búsqueda semántica queda rota hasta reindexar (el reindex automático aún no está)."
      M_RC_DIM_CHANGE="La dimensión cambia de"
      M_RC_EMAIL_WARN="El email del admin solo se usa al bootstrap inicial; cambiarlo no renombra al usuario ya creado."
      M_BK_TITLE="Backup"
      M_BK_DUMP="Volcando la base (pg_dump)…"
      M_BK_DONE="Backup creado:"
      M_BK_FAIL="No pude crear el backup."
      M_BK_CADDY="Guardando el certificado TLS de Caddy…"
      M_BK_CADDY_FAIL="No pude guardar el certificado Caddy (se re-emitirá al restaurar)."
      M_RS_CADDY="Restaurando el certificado TLS de Caddy…"
      M_RS_CADDY_FAIL="No pude restaurar el certificado Caddy (Caddy lo re-emitirá vía ACME)."
      M_RS_TITLE="Restore"
      M_RS_PATH="Ruta del archivo de backup (.tar.gz)"
      M_RS_NOFILE="No existe el archivo:"
      M_RS_BAD="El backup no contiene db.sql — archivo inválido."
      M_RS_DIM_WARN="El backup fue hecho con otra dimensión de embedder. La búsqueda quedará rota hasta reindexar."
      M_RS_CONFIRM="Esto SOBREESCRIBE la base actual. ¿Continuar?"
      M_RS_LOAD="Restaurando la base…"
      M_RS_DONE="Restore completado."
      M_RS_MODE="Restaurando como modo:"
      M_RS_WAIT="Esperando a que la base acepte conexiones…"
      M_RS_OLLAMA_WARN="Este backup usa Ollama como embedder: asegurate de tener Ollama corriendo en este equipo (host:11434), o la búsqueda semántica no va a indexar."
      M_UN_TITLE="Desinstalar"
      M_UN_CONFIRM="¿Seguro que querés DESINSTALAR Diluxite (bajar el stack)?"
      M_UN_DOWN="Bajando el stack…"
      M_UN_CANCEL="Desinstalación cancelada."
      M_UN_DATA_Q="¿Borrar TAMBIÉN los datos (notas + base) en"
      M_UN_BACKUP_Q="¿Hacer un backup antes?"
      M_UN_DONE="Diluxite desinstalado."
      M_UN_DATA_KEPT="Los datos siguen en"
      M_RC_8="Cambiar modo (local ↔ server)"
      M_RC_9="Reset del super admin (acceso perdido)"
      M_MS_TO_SERVER="Vas a pasar a modo SERVER (multiusuario con login). Tu instalacion local se promueve al super admin (conservas todas las notas)."
      M_MS_EMAIL="Email del super admin"
      M_MS_SUB="Como se autentica el super admin?"
      M_MS_SUB_CF="Cloudflare Access (JWT firmado, verificado) — sin password, seguro sin tunel"
      M_MS_SUB_PWD="Email + password"
      M_MS_SUB_TH="Trusted-header plano (Authelia/Pomerium) — inseguro salvo aislamiento de red"
      M_MS_PROMOTED="Usuario local promovido a super admin:"
      M_MS_PWD="Password del admin (minimo 8)"
      M_MS_PWD2="Repeti el password"
      M_MS_PWD_OPT="Configurar tambien un password como fallback?"
      M_MS_WAITHASH="Aplicando el password (la app lo hashea y lo borramos del compose)..."
      M_MS_PWDOK="Password seteado y scrubbeado (NO queda texto plano en el compose)."
      M_MS_PWDWAIT="No pude confirmar el hash; revisa docker compose logs."
      M_MS_TH_WARN="OJO: el header plano es spoofeable si alguien llega al puerto sin pasar por el proxy. Forza TODO el trafico por el proxy."
      M_MS_SERVER_DONE="Modo server activado. Super admin:"
      M_MS_TO_LOCAL_WARN="server -> local colapsa a un unico usuario sin login (local@diluxite). Los usuarios y notas de server NO se borran, pero no se ven desde el modo local."
      M_MS_TO_LOCAL_CONFIRM="Seguro que queres volver a modo local?"
      M_MS_LOCAL_DONE="Modo local restaurado."
      M_RA_TITLE="Reset del super admin"
      M_RA_NOTSERVER="El reset de admin solo aplica en modo server."
      M_RA_DONE="Super admin reseteado:"
      ;;
    pt)
      M_DETECTED="Diluxite já está instalado"
      M_MENU_TITLE="O que você quer fazer?"
      M_M1="Atualizar           (pull + up, mesma config)"
      M_M2="Reconfigurar        (canal, HTTPS, SSO, trusted-header, embedder)"
      M_M3="Status / logs       (somente leitura)"
      M_M4="Backup              (pg_dump + config + manifest)"
      M_M5="Restore             (de um backup)"
      M_M6="Desinstalar         (derrubar stack, opção de apagar dados)"
      M_M7="Seed de dados de teste (carregar notas demo)"
      M_M0="Sair"
      M_SEED_TITLE="Seed de dados de teste"
      M_SEED_NOSPACE="Não há nenhum workspace no banco."
      M_SEED_PICK="Em qual workspace você quer carregar as notas demo?"
      M_SEED_ONE="Único workspace:"
      M_SEED_COUNT="Quantas notas demo?"
      M_SEED_CONFIRM="Carregar as notas demo nesse workspace?"
      M_SEED_RUNNING="Carregando notas demo (leva alguns minutos)…"
      M_SEED_DONE="Seed concluído."
      M_PROMPT="Opção"
      M_CONTINUE="Enter para voltar ao menu… "
      M_NO_INSTALL="Não encontrei uma instalação do Diluxite em"
      M_APPLIED="Alterações aplicadas."
      M_UPDATED="Diluxite atualizado."
      M_BYE="Pronto, sem alterações."
      M_PULLING="Baixando imagens…"
      M_RESTARTING="Reiniciando o stack…"
      M_ST_VERSION="Versão instalada"
      M_ST_AVAIL="Versão disponível"
      M_ST_CHANNEL="Canal"
      M_ST_AUTOUPDATE="Auto-update"
      M_ST_EMBEDDER="Embedder"
      M_ST_AUTH="Modo / auth"
      M_ST_HTTPS="HTTPS / domínio"
      M_ST_DATA="Dados"
      M_ST_WEB="Web"
      M_ST_NOTES="Notas no banco"
      M_ST_DISK="Espaço livre"
      M_ST_OS="Sistema"
      M_ST_MCP="MCP (para Claude/Copilot)"
      M_ST_SPACES="Workspaces"
      M_ST_BADCONTAINERS="Containers com problemas (veja os logs):"
      M_ST_CONTAINERS="Containers"
      M_ST_HEALTH="Saúde"
      M_ST_HEALTHY="OK (responde)"
      M_ST_UNHEALTHY="não responde"
      M_ST_UPDATE_AVAIL="Há uma versão nova disponível! Rode --update."
      M_ST_UPTODATE="Você está na última versão do canal."
      M_RC_TITLE="Reconfigurar"
      M_RC_1="Canal de updates (estável :latest / pre :next)"
      M_RC_2="Auto-update (on/off)"
      M_RC_3="HTTPS / domínio (Caddy + Lets Encrypt)"
      M_RC_4="OIDC SSO (Entra / Google / Okta / Authentik)"
      M_RC_5="Trusted-header proxy (Cloudflare Access / Authelia)"
      M_RC_6="Embedder / motor de busca"
      M_RC_7="Email do admin"
      M_RC_0="Voltar"
      M_RC_CHAN_Q="Canal [1=estável :latest, 2=pre :next]"
      M_RC_AU_Q="Auto-update ativado? [y/N]"
      M_RC_DOMAIN_Q="Domínio (enter vazio = desativar HTTPS)"
      M_RC_ACME_Q="Email para Lets Encrypt"
      M_RC_HTTPS_OFF="HTTPS desativado — volta para HTTP puro na porta web."
      M_RC_EMB_WARN="ATENÇÃO: trocar o embedder pode exigir REINDEXAR. Se a dimensão mudar, a busca semântica fica quebrada até reindexar (reindex automático ainda não existe)."
      M_RC_DIM_CHANGE="A dimensão muda de"
      M_RC_EMAIL_WARN="O email do admin só é usado no bootstrap inicial; trocá-lo não renomeia o usuário já criado."
      M_BK_TITLE="Backup"
      M_BK_DUMP="Exportando o banco (pg_dump)…"
      M_BK_DONE="Backup criado:"
      M_BK_FAIL="Não consegui criar o backup."
      M_BK_CADDY="Salvando o certificado TLS do Caddy…"
      M_BK_CADDY_FAIL="Não consegui salvar o certificado Caddy (será reemitido no restore)."
      M_RS_CADDY="Restaurando o certificado TLS do Caddy…"
      M_RS_CADDY_FAIL="Não consegui restaurar o certificado Caddy (o Caddy vai reemitir via ACME)."
      M_RS_TITLE="Restore"
      M_RS_PATH="Caminho do arquivo de backup (.tar.gz)"
      M_RS_NOFILE="Arquivo não existe:"
      M_RS_BAD="O backup não contém db.sql — arquivo inválido."
      M_RS_DIM_WARN="O backup foi feito com outra dimensão de embedder. A busca ficará quebrada até reindexar."
      M_RS_CONFIRM="Isto SOBRESCREVE o banco atual. Continuar?"
      M_RS_LOAD="Restaurando o banco…"
      M_RS_DONE="Restore concluído."
      M_RS_MODE="Restaurando no modo:"
      M_RS_WAIT="Aguardando o banco aceitar conexões…"
      M_RS_OLLAMA_WARN="Este backup usa Ollama como embedder: garanta que o Ollama esteja rodando nesta máquina (host:11434), senão a busca semântica não vai indexar."
      M_UN_TITLE="Desinstalar"
      M_UN_CONFIRM="Tem certeza que quer DESINSTALAR o Diluxite (derrubar o stack)?"
      M_UN_DOWN="Derrubando o stack…"
      M_UN_CANCEL="Desinstalação cancelada."
      M_UN_DATA_Q="Apagar TAMBÉM os dados (notas + banco) em"
      M_UN_BACKUP_Q="Fazer um backup antes?"
      M_UN_DONE="Diluxite desinstalado."
      M_UN_DATA_KEPT="Os dados continuam em"
      M_RC_8="Mudar modo (local ↔ server)"
      M_RC_9="Reset do super admin (acesso perdido)"
      M_MS_TO_SERVER="Vai mudar para modo SERVER (multiusuario com login). Sua instalacao local vira o super admin (mantem todas as notas)."
      M_MS_EMAIL="Email do super admin"
      M_MS_SUB="Como o super admin se autentica?"
      M_MS_SUB_CF="Cloudflare Access (JWT assinado, verificado) — sem senha, seguro sem tunel"
      M_MS_SUB_PWD="Email + senha"
      M_MS_SUB_TH="Trusted-header puro (Authelia/Pomerium) — inseguro sem isolamento de rede"
      M_MS_PROMOTED="Usuario local promovido a super admin:"
      M_MS_PWD="Senha do admin (minimo 8)"
      M_MS_PWD2="Repita a senha"
      M_MS_PWD_OPT="Configurar tambem uma senha como fallback?"
      M_MS_WAITHASH="Aplicando a senha (o app faz o hash e a removemos do compose)..."
      M_MS_PWDOK="Senha definida e removida (NAO fica texto puro no compose)."
      M_MS_PWDWAIT="Nao consegui confirmar o hash; veja docker compose logs."
      M_MS_TH_WARN="ATENCAO: o header puro e falsificavel se alguem chegar na porta sem passar pelo proxy. Force TODO o trafego pelo proxy."
      M_MS_SERVER_DONE="Modo server ativado. Super admin:"
      M_MS_TO_LOCAL_WARN="server -> local colapsa para um unico usuario sem login (local@diluxite). Usuarios e notas do server NAO sao apagados, mas nao aparecem no modo local."
      M_MS_TO_LOCAL_CONFIRM="Tem certeza que quer voltar ao modo local?"
      M_MS_LOCAL_DONE="Modo local restaurado."
      M_RA_TITLE="Reset do super admin"
      M_RA_NOTSERVER="O reset de admin so vale no modo server."
      M_RA_DONE="Super admin resetado:"
      ;;
    *)
      M_DETECTED="Diluxite is already installed"
      M_MENU_TITLE="What do you want to do?"
      M_M1="Update              (pull + up, same config)"
      M_M2="Reconfigure         (channel, HTTPS, SSO, trusted-header, embedder)"
      M_M3="Status / logs       (read-only)"
      M_M4="Backup              (pg_dump + config + manifest)"
      M_M5="Restore             (from a backup)"
      M_M6="Uninstall           (bring stack down, option to wipe data)"
      M_M7="Seed test data      (load demo notes)"
      M_M0="Quit"
      M_SEED_TITLE="Seed test data"
      M_SEED_NOSPACE="There is no workspace in the database."
      M_SEED_PICK="Which workspace should the demo notes go into?"
      M_SEED_ONE="Only workspace:"
      M_SEED_COUNT="How many demo notes?"
      M_SEED_CONFIRM="Load the demo notes into that workspace?"
      M_SEED_RUNNING="Loading demo notes (takes a few minutes)…"
      M_SEED_DONE="Seed complete."
      M_PROMPT="Choice"
      M_CONTINUE="Press Enter to return to the menu… "
      M_NO_INSTALL="No Diluxite installation found at"
      M_APPLIED="Changes applied."
      M_UPDATED="Diluxite updated."
      M_BYE="Done, no changes."
      M_PULLING="Pulling images…"
      M_RESTARTING="Restarting the stack…"
      M_ST_VERSION="Installed version"
      M_ST_AVAIL="Available version"
      M_ST_CHANNEL="Channel"
      M_ST_AUTOUPDATE="Auto-update"
      M_ST_EMBEDDER="Embedder"
      M_ST_AUTH="Mode / auth"
      M_ST_HTTPS="HTTPS / domain"
      M_ST_DATA="Data"
      M_ST_WEB="Web"
      M_ST_NOTES="Notes in DB"
      M_ST_DISK="Free disk"
      M_ST_OS="System"
      M_ST_MCP="MCP (for Claude/Copilot)"
      M_ST_SPACES="Workspaces"
      M_ST_BADCONTAINERS="Containers with problems (check the logs):"
      M_ST_CONTAINERS="Containers"
      M_ST_HEALTH="Health"
      M_ST_HEALTHY="OK (responding)"
      M_ST_UNHEALTHY="not responding"
      M_ST_UPDATE_AVAIL="A new version is available! Run --update."
      M_ST_UPTODATE="You're on the latest version of the channel."
      M_RC_TITLE="Reconfigure"
      M_RC_1="Update channel (stable :latest / pre :next)"
      M_RC_2="Auto-update (on/off)"
      M_RC_3="HTTPS / domain (Caddy + Lets Encrypt)"
      M_RC_4="OIDC SSO (Entra / Google / Okta / Authentik)"
      M_RC_5="Trusted-header proxy (Cloudflare Access / Authelia)"
      M_RC_6="Embedder / search engine"
      M_RC_7="Admin email"
      M_RC_0="Back"
      M_RC_CHAN_Q="Channel [1=stable :latest, 2=pre :next]"
      M_RC_AU_Q="Auto-update on? [y/N]"
      M_RC_DOMAIN_Q="Domain (empty enter = disable HTTPS)"
      M_RC_ACME_Q="Email for Lets Encrypt"
      M_RC_HTTPS_OFF="HTTPS disabled — back to plain HTTP on the web port."
      M_RC_EMB_WARN="NOTE: changing the embedder may require a REINDEX. If the dimension changes, semantic search is broken until you reindex (automatic reindex isn't built yet)."
      M_RC_DIM_CHANGE="Dimension changes from"
      M_RC_EMAIL_WARN="The admin email is only used at first bootstrap; changing it won't rename the existing user."
      M_BK_TITLE="Backup"
      M_BK_DUMP="Dumping the database (pg_dump)…"
      M_BK_DONE="Backup created:"
      M_BK_FAIL="Could not create the backup."
      M_BK_CADDY="Saving Caddy's TLS certificate…"
      M_BK_CADDY_FAIL="Could not save the Caddy cert (it will be re-issued on restore)."
      M_RS_CADDY="Restoring Caddy's TLS certificate…"
      M_RS_CADDY_FAIL="Could not restore the Caddy cert (Caddy will re-issue it via ACME)."
      M_RS_TITLE="Restore"
      M_RS_PATH="Backup file path (.tar.gz)"
      M_RS_NOFILE="File does not exist:"
      M_RS_BAD="Backup has no db.sql — invalid file."
      M_RS_DIM_WARN="The backup was made with a different embedder dimension. Search will be broken until you reindex."
      M_RS_CONFIRM="This OVERWRITES the current database. Continue?"
      M_RS_LOAD="Restoring the database…"
      M_RS_DONE="Restore complete."
      M_RS_MODE="Restoring as mode:"
      M_RS_WAIT="Waiting for the database to accept connections…"
      M_RS_OLLAMA_WARN="This backup uses Ollama as the embedder: make sure Ollama is running on this machine (host:11434), or semantic search won't index."
      M_UN_TITLE="Uninstall"
      M_UN_CONFIRM="Are you sure you want to UNINSTALL Diluxite (bring the stack down)?"
      M_UN_DOWN="Bringing the stack down…"
      M_UN_CANCEL="Uninstall cancelled."
      M_UN_DATA_Q="ALSO delete the data (notes + database) at"
      M_UN_BACKUP_Q="Make a backup first?"
      M_UN_DONE="Diluxite uninstalled."
      M_UN_DATA_KEPT="Your data is still at"
      M_RC_8="Switch mode (local ↔ server)"
      M_RC_9="Reset the super admin (lost access)"
      M_MS_TO_SERVER="Switching to SERVER mode (multi-user with login). Your local install is promoted to the super admin (keeps all notes)."
      M_MS_EMAIL="Super admin email"
      M_MS_SUB="How does the super admin authenticate?"
      M_MS_SUB_CF="Cloudflare Access (signed JWT, verified) — no password, secure without a tunnel"
      M_MS_SUB_PWD="Email + password"
      M_MS_SUB_TH="Plain trusted-header (Authelia/Pomerium) — insecure unless network-isolated"
      M_MS_PROMOTED="Local user promoted to super admin:"
      M_MS_PWD="Admin password (min 8)"
      M_MS_PWD2="Repeat the password"
      M_MS_PWD_OPT="Also set a password as fallback?"
      M_MS_WAITHASH="Applying the password (the app hashes it, then we scrub it from compose)..."
      M_MS_PWDOK="Password set and scrubbed (NO plaintext left in compose)."
      M_MS_PWDWAIT="Could not confirm the hash; check docker compose logs."
      M_MS_TH_WARN="WARNING: a plain header is spoofable if someone reaches the port without going through the proxy. Force ALL traffic through the proxy."
      M_MS_SERVER_DONE="Server mode enabled. Super admin:"
      M_MS_TO_LOCAL_WARN="server -> local collapses to a single login-less user (local@diluxite). Server users and notes are NOT deleted, but won't show in local mode."
      M_MS_TO_LOCAL_CONFIRM="Are you sure you want to go back to local mode?"
      M_MS_LOCAL_DONE="Local mode restored."
      M_RA_TITLE="Reset super admin"
      M_RA_NOTSERVER="Admin reset only applies in server mode."
      M_RA_DONE="Super admin reset:"
      ;;
  esac
}

# Confirmación y/n que respeta --yes.
mgmt_confirm() {
  [ -n "${ASSUME_YES}" ] && return 0
  local a=""
  read -rp "  $1 [y/N]: " a <"$TTY" || true
  [[ "${a:-}" =~ ^[yYsS]$ ]]
}

# Doble advertencia (no producción + socket=root) + confirmación explícita antes
# de activar auto-update con Watchtower. Devuelve 0 si acepta, 1 si no.
confirm_autoupdate_risk() {
  echo ""
  warn "${MSG_AU_NOTPROD}"
  warn "${MSG_AU_SOCKET}"
  echo ""
  mgmt_confirm "${MSG_AU_ACCEPT}"
}

# Re-renderiza el compose y reinicia el stack (usado por reconfigure).
reconfig_apply() {
  # Un cambio de config usa la MISMA imagen → no hace falta `pull`. Solo
  # canal/auto-update cambian el tag y pasan "pull" como primer argumento.
  render_compose
  local pf; pf="$(compose_profiles)"
  if [ "${1:-}" = "pull" ]; then
    info "${M_PULLING}"
    ( cd "${INSTALL_DIR}" && docker compose ${pf} pull )
  fi
  info "${M_RESTARTING}"
  ( cd "${INSTALL_DIR}" && docker compose ${pf} up -d --remove-orphans )
  # Si se desactivó HTTPS, bajamos el sidecar caddy que pudiera haber quedado.
  if [ -z "${HTTPS_DOMAIN}" ]; then
    ( cd "${INSTALL_DIR}" && docker compose rm -sf caddy >/dev/null 2>&1 || true )
  fi
  write_state
  ok "${M_APPLIED}"
  show_open_line
}

# Recalcula VERSION + watchtower profile según canal + auto-update actuales.
reconf_set_version() {
  if [ "${AUTOUPDATE_ON}" = "1" ]; then
    WATCHTOWER_PROFILES_LINE=""
    if [ "${CHANNEL}" = "1" ]; then VERSION="latest"; else VERSION="next"; fi
  else
    WATCHTOWER_PROFILES_LINE='    profiles: ["autoupdate"]'
    VERSION="$(mgmt_lookup_version "${CHANNEL}")"
  fi
}

mgmt_update() {
  header "${M_M1%% *}"
  local pf; pf="$(compose_profiles)"
  info "${M_PULLING}"
  ( cd "${INSTALL_DIR}" && docker compose ${pf} pull )
  info "${M_RESTARTING}"
  ( cd "${INSTALL_DIR}" && docker compose ${pf} up -d --remove-orphans )
  # Esperar a que vuelva sano y reportar la versión real ya corriendo.
  wait_healthy "http://localhost:${WEB_PORT}/api/info" || true
  local rv; rv="$(json_field "$(app_info)" version)"
  ok "${M_UPDATED}${rv:+ → v${rv}}"
  show_open_line
}

mgmt_status() {
  header "Diluxite — ${M_M3%% *}"

  # Version + authMode reales de la instancia corriendo (autoritativo); si la
  # app no responde, caemos al tag/estado guardado.
  local info_json; info_json="$(app_info)"
  local rv; rv="$(json_field "${info_json}" version)"; [ -z "${rv}" ] && rv="${VERSION}"
  local rmode; rmode="$(json_field "${info_json}" authMode)"; [ -z "${rmode}" ] && rmode="${AUTH_MODE}"

  local emb="deterministic"
  [ "${EMB_OPT}" = "1" ] && emb="Ollama (${OLLAMA_MODEL}, dim ${OLLAMA_DIMS})"
  [ "${EMB_OPT}" = "2" ] && emb="Azure OpenAI (${AZURE_DEPLOYMENT})"
  local au="OFF"; [ "${AUTOUPDATE_ON}" = "1" ] && au="ON"
  local chan=":next (pre)"; [ "${CHANNEL}" = "1" ] && chan=":latest (stable)"

  echo -e "  ${BOLD}${M_ST_VERSION}:${NC}   ${GREEN}${rv}${NC}  ${DIM}(tag ${VERSION} · canal ${chan})${NC}"
  echo -e "  ${BOLD}${M_ST_AUTOUPDATE}:${NC}    ${au}"
  echo -e "  ${BOLD}${M_ST_EMBEDDER}:${NC}      ${emb}"
  echo -e "  ${BOLD}${M_ST_AUTH}:${NC}     ${rmode}$( [ -n "${ADMIN_EMAIL}" ] && echo " (${ADMIN_EMAIL})" )"
  echo -e "  ${BOLD}${M_ST_HTTPS}:${NC}  $( [ -n "${HTTPS_DOMAIN}" ] && echo "${HTTPS_DOMAIN}" || echo "—" )"
  echo -e "  ${BOLD}${M_ST_WEB}:${NC}          http://localhost:${WEB_PORT}"
  echo -e "  ${BOLD}${M_ST_MCP}:${NC}  http://localhost:${WEB_PORT}/mcp"
  echo -e "  ${BOLD}${M_ST_DATA}:${NC}         ${DATA_PATH}"

  local notes; notes="$(db_psql 'select count(*) from notes' | tr -d '[:space:]' || true)"
  echo -e "  ${BOLD}${M_ST_NOTES}:${NC} ${notes:-n/a}"
  local spaces; spaces="$(db_psql 'select count(*) from spaces' | tr -d '[:space:]' || true)"
  echo -e "  ${BOLD}${M_ST_SPACES}:${NC}   ${spaces:-n/a}"
  local disk; disk="$(df -h "${DATA_PATH}" 2>/dev/null | tail -1 | awk '{print $4}' || true)"
  echo -e "  ${BOLD}${M_ST_DISK}:${NC}  ${disk:-n/a}"
  echo -e "  ${BOLD}${M_ST_OS}:${NC}        $(platform_name) · Docker $(docker --version 2>/dev/null | sed 's/Docker version //; s/,.*//')"

  echo ""
  echo -e "  ${BOLD}${M_ST_CONTAINERS}:${NC}"
  # Solo las columnas útiles: NAME · IMAGE · SERVICE · STATUS · PORTS.
  ( cd "${INSTALL_DIR}" && docker compose ps --format json 2>/dev/null ) | python3 -c '
import json,sys
data=sys.stdin.read().strip()
objs=[]
if data:
    try:
        x=json.loads(data); objs=x if isinstance(x,list) else [x]
    except Exception:
        for ln in data.splitlines():
            ln=ln.strip()
            if ln:
                try: objs.append(json.loads(ln))
                except Exception: pass
def ports(o):
    p=o.get("Ports") or ""
    if p: return p
    out=[]
    for pub in (o.get("Publishers") or []):
        u=pub.get("URL") or ""; pp=pub.get("PublishedPort"); tp=pub.get("TargetPort"); pr=pub.get("Protocol","")
        if pp: out.append((u+":" if u else "")+str(pp)+"->"+str(tp)+"/"+pr)
    return ", ".join(out)
rows=[(o.get("Name",""),o.get("Image",""),o.get("Service",""),o.get("Status",""),ports(o)) for o in objs]
hdr=("NAME","IMAGE","SERVICE","STATUS","PORTS")
allr=[hdr]+rows
w=[max(len(str(r[i])) for r in allr) for i in range(len(hdr))]
for r in allr:
    print("    "+"  ".join(str(r[i]).ljust(w[i]) for i in range(len(hdr))))
' 2>/dev/null || ( cd "${INSTALL_DIR}" && docker compose ps 2>/dev/null ) || true

  # Aviso si algún container quedó reiniciando / unhealthy / exited.
  local badc; badc="$( ( cd "${INSTALL_DIR}" && docker compose ps 2>/dev/null ) | grep -iE 'restarting|unhealthy|exited' | awk '{print $1}' | tr '\n' ' ' || true )"
  [ -n "${badc}" ] && warn "${M_ST_BADCONTAINERS} ${badc}"

  echo ""
  if [ -n "${info_json}" ]; then
    echo -e "  ${BOLD}${M_ST_HEALTH}:${NC} ${GREEN}${M_ST_HEALTHY}${NC}"
  else
    echo -e "  ${BOLD}${M_ST_HEALTH}:${NC} ${YELLOW}${M_ST_UNHEALTHY}${NC}"
  fi

  # Versión disponible — preferimos /api/update/check de la app (misma fuente,
  # pero ya resuelta) y si no, el lookup directo a GitHub.
  local upd; upd="$(curl -fsS "http://localhost:${WEB_PORT}/api/update/check" 2>/dev/null || true)"
  local latest; latest="$(json_field "${upd}" latest)"
  local hasupd; hasupd="$(json_field "${upd}" hasUpdate)"
  [ -z "${latest}" ] && latest="$(mgmt_lookup_version "${CHANNEL}")"
  if [ -n "${latest}" ]; then
    echo -e "  ${BOLD}${M_ST_AVAIL}:${NC}   ${latest}"
    if [ "${hasupd}" = "true" ]; then warn "${M_ST_UPDATE_AVAIL}"; else info "${M_ST_UPTODATE}"; fi
  fi
  show_open_line
}

mgmt_backup() {
  header "${M_BK_TITLE}"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S 2>/dev/null || echo backup)"
  local outdir="${INSTALL_DIR}/backups"
  mkdir -p "${outdir}"
  local out="${ARG_BACKUP_OUT:-${outdir}/diluxite-${stamp}.tar.gz}"
  local tmp; tmp="$(mktemp -d)"

  info "${M_BK_DUMP}"
  if ! docker exec -i diluxite-db pg_dump -U diluxite -d diluxite --clean --if-exists --no-owner > "${tmp}/db.sql" 2>/dev/null; then
    err "${M_BK_FAIL}"
    rm -rf "${tmp}"; return 1
  fi

  local notes; notes="$(docker exec diluxite-db psql -U diluxite -d diluxite -tAc 'select count(*) from notes' 2>/dev/null | tr -d '[:space:]' || echo '')"
  local emb_dims="${OLLAMA_DIMS}"
  [ "${EMB_OPT}" = "2" ] && emb_dims="azure"
  [ "${EMB_OPT}" = "3" ] && emb_dims="1536"
  cat > "${tmp}/manifest.json" <<EOF
{
  "schema": 1,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)",
  "version": "${VERSION}",
  "channel": "${CHANNEL}",
  "embedder_opt": "${EMB_OPT}",
  "embedder_dims": "${emb_dims}",
  "notes": "${notes:-unknown}"
}
EOF
  cp "${INSTALL_DIR}/docker-compose.yml" "${tmp}/" 2>/dev/null || true
  [ -f "${INSTALL_DIR}/Caddyfile" ] && cp "${INSTALL_DIR}/Caddyfile" "${tmp}/"
  [ -f "${INSTALL_DIR}/${STATE_FILE_NAME}" ] && cp "${INSTALL_DIR}/${STATE_FILE_NAME}" "${tmp}/"

  # Certificados Caddy: el volumen caddy_data lo escribe root dentro del
  # container, así que lo tareamos con un container efímero (evita problemas
  # de permisos). Así el cert TLS también viaja y no hay que re-emitirlo
  # (Let's Encrypt igual lo renueva solo cuando venza).
  if [ -d "${DATA_PATH}/caddy_data" ]; then
    info "${M_BK_CADDY}"
    docker run --rm -v "${DATA_PATH}/caddy_data:/cd:ro" -v "${tmp}:/out" alpine \
      tar -czf /out/caddy_data.tgz -C /cd . >/dev/null 2>&1 || warn "${M_BK_CADDY_FAIL}"
  fi

  tar -czf "${out}" -C "${tmp}" . 2>/dev/null
  rm -rf "${tmp}"
  ok "${M_BK_DONE} ${BOLD}${out}${NC}"
}

# ── Embedder Ollama: instalar (si falta) + levantar daemon + pull del modelo.
#    Definido acá (no en el wizard) para que el RESTORE también pueda usarlo.
ensure_ollama() {
  if command -v ollama &>/dev/null; then
    ok "${MSG_OLLAMA_OK} $(ollama --version 2>&1 | head -1)"
    return 0
  fi
  warn "${MSG_OLLAMA_MISSING}"
  case "${PLATFORM}" in
    linux|wsl|macos)
      echo -e "  ${DIM}${MSG_HINT_YN_Y}${NC}"
      echo ""
      read -rp "${MSG_OLLAMA_INSTALL_Q}" GO <"$TTY"
      GO=${GO:-Y}
      if [[ "${GO}" =~ ^[YySs]$ ]]; then
        info "${MSG_OLLAMA_INSTALLING}"
        if [[ "${PLATFORM}" == "macos" ]]; then
          curl -fsSL https://ollama.com/install.sh | sh || true
        else
          curl -fsSL https://ollama.com/install.sh | sh
        fi
        if ! command -v ollama &>/dev/null; then
          err "${MSG_OLLAMA_INSTALL_FAIL} https://ollama.com/download"
          exit 1
        fi
        ok "${MSG_OLLAMA_INSTALLED} $(ollama --version 2>&1 | head -1)"
      else
        info "${MSG_OLLAMA_REQUIRED}"; exit 1
      fi
      ;;
    gitbash)
      info "${MSG_OLLAMA_WIN} https://ollama.com/download/windows"
      open_url "https://ollama.com/download/windows"
      info "${MSG_OLLAMA_WIN_AFTER}"
      exit 1
      ;;
    *)
      info "${MSG_OLLAMA_OTHER}"
      exit 1
      ;;
  esac
}

ensure_ollama_running() {
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${PLATFORM}" == "macos" ]]; then
    for _ in $(seq 1 15); do
      open -a Ollama 2>/dev/null && break
      sleep 2
    done
  fi
  for _ in $(seq 1 60); do
    curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && return 0
    sleep 2
  done
  err "Ollama daemon did not respond on http://localhost:11434 after 2 min. Start it manually and re-run this script."
  exit 1
}

# Deja Ollama 100% listo para el modelo dado (usado por install Y restore).
ensure_ollama_ready() {
  local model="${1:-mxbai-embed-large:335m}"
  ensure_ollama
  ensure_ollama_running
  info "${MSG_OLLAMA_PULL}"
  ollama pull "${model}"
  ok "${MSG_MODEL_OK}"
}

# Espera a que la web responda healthy. Devuelve 1 si no llegó (no hace exit;
# el caller decide). Reusado por el bring-up del install y por el restore.
wait_healthy() {
  local url="$1" i
  info "${MSG_WAITING}"
  for i in $(seq 1 60); do
    if curl -fsS "${url}" >/dev/null 2>&1; then ok "${MSG_HEALTHY}"; return 0; fi
    sleep 2
  done
  err "${MSG_HEALTH_TIMEOUT}"
  err "${MSG_LOGS} cd ${INSTALL_DIR} && docker compose logs"
  return 1
}

# Resumen final "todo listo". Idéntico para install y restore. Usa los globales
# de config (VERSION, OLLAMA/AZURE, HTTPS_DOMAIN, AUTH_MODE, etc.).
print_summary() {
  local EMBEDDER_LABEL
  if [ -n "${OLLAMA_MODEL:-}" ]; then
    EMBEDDER_LABEL="${MSG_EMB_OLLAMA} (${OLLAMA_MODEL})"
  elif [ -n "${AZURE_ENDPOINT:-}" ]; then
    EMBEDDER_LABEL="${MSG_EMB_AZURE}"
  else
    EMBEDDER_LABEL="${MSG_EMB_DET}"
  fi

  echo ""
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}    ${MSG_DONE_TITLE}${NC}"
  echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
  echo ""
  if [ -n "${HTTPS_DOMAIN:-}" ]; then
    echo -e "  ${BOLD}${MSG_OPEN_NOW}${NC}  ${GREEN}${BOLD}→  https://${HTTPS_DOMAIN}  ←${NC}"
    echo -e "  ${DIM}(Caddy estará terminando TLS; el primer hit puede tardar 10-30s mientras Lets Encrypt emite el cert)${NC}"
  else
    echo -e "  ${BOLD}${MSG_OPEN_NOW}${NC}  ${GREEN}${BOLD}→  http://localhost:${WEB_PORT}  ←${NC}"
  fi
  echo ""
  echo -e "  ${DIM}${MSG_FIRST_LOAD1}${NC}"
  echo -e "  ${DIM}${MSG_FIRST_LOAD2}${NC}"
  echo ""
  echo -e "${CYAN}${BOLD}${MSG_WHATS_INSTALLED}${NC}"
  echo -e "  ${BOLD}${MSG_VERSION_LABEL}${NC}      ${VERSION}"
  echo -e "  ${BOLD}${MSG_EMBEDDER_LABEL}${NC}     ${EMBEDDER_LABEL}"
  echo -e "  ${BOLD}${MSG_DATA_LABEL}${NC}  ${DATA_PATH}"
  echo -e "  ${BOLD}${MSG_INSTALL_LABEL}${NC}  ${INSTALL_DIR}"
  if [ "${AUTOUPDATE_ON:-0}" = "1" ]; then
    echo -e "  ${BOLD}${MSG_AUTOUPDATE_LABEL}${NC}  ${MSG_AUTOUPDATE_LABEL_ON}"
  else
    echo -e "  ${BOLD}${MSG_AUTOUPDATE_LABEL}${NC}  ${MSG_AUTOUPDATE_LABEL_OFF}"
  fi
  if [ "${SEED_OPT:-1}" = "2" ]; then
    echo -e "  ${BOLD}${MSG_SEED_LOADED}${NC}  ${MSG_SEED_LOADED_DESC}"
  fi
  echo ""
  echo -e "${CYAN}${BOLD}${MSG_USEFUL_CMDS}${NC} ${DIM}${MSG_USEFUL_FROM} ${INSTALL_DIR})${NC}"
  echo -e "  ${YELLOW}docker compose logs -f${NC}                          ${DIM}# ${MSG_CMD_LOGS}${NC}"
  echo -e "  ${YELLOW}docker compose down${NC}                             ${DIM}# ${MSG_CMD_DOWN}${NC}"
  if [ "${AUTOUPDATE_ON:-0}" = "1" ]; then
    echo -e "  ${YELLOW}docker compose pull && docker compose up -d${NC}     ${DIM}# ${MSG_CMD_FORCE_UPDATE}${NC}"
  else
    echo -e "  ${YELLOW}docker compose pull && docker compose up -d${NC}     ${DIM}# ${MSG_CMD_UPDATE}${NC}"
    echo -e "  ${YELLOW}docker compose --profile autoupdate up -d${NC}       ${DIM}# ${MSG_CMD_AUTOUPDATE}${NC}"
  fi
  echo ""
  echo -e "${CYAN}${BOLD}${MSG_BACKUP}${NC}"
  echo -e "  ${MSG_BACKUP_DESC} ${BOLD}${DATA_PATH}${NC} ${DIM}${MSG_BACKUP_DESC2}${NC}"
  echo ""

  if [ "${AUTH_MODE:-local}" = "server" ]; then
    echo -e "${CYAN}${BOLD}Authentication backends${NC}"
    echo -e "  ${BOLD}1. Email + password${NC}  ✅  Admin: ${ADMIN_EMAIL}"
    echo -e "     Bulk-import via Admin Console → Users → \"Import CSV\"."
    echo ""
    if [ -n "${OIDC_ISSUER:-}" ]; then
      echo -e "  ${BOLD}2. OIDC SSO${NC}          ✅  Configured against ${OIDC_ISSUER}"
      echo -e "     Redirect URI: ${OIDC_REDIRECT_URI}"
    else
      echo -e "  ${BOLD}2. OIDC SSO${NC}          ${DIM}not configured${NC}"
    fi
    echo ""
    if [ -n "${CF_TEAM:-}" ]; then
      echo -e "  ${BOLD}3. Cloudflare Access${NC}  ✅  team=${CF_TEAM} (JWT verificado)"
    elif [ -n "${TRUSTED_HEADER:-}" ]; then
      echo -e "  ${BOLD}3. Identity-Aware Proxy${NC} ✅  Header: ${TRUSTED_HEADER}"
      echo -e "     ${RED}${BOLD}REMINDER:${NC} TODO el trafico debe llegar SOLO via tu proxy."
    else
      echo -e "  ${BOLD}3. Identity-Aware Proxy${NC} ${DIM}not configured${NC}"
    fi
    echo ""
  fi

  echo -e "${MAGENTA}${BOLD}${MSG_THANKS}${NC}"
  echo -e "  ${DIM}${MSG_QUESTIONS}${NC} ${BLUE}github.com/soydiloreto/diluxite-core-alpha${NC}"
  echo -e "  ${DIM}${MSG_BUILT_BY}${NC} ${BOLD}Pablo Ariel Di Loreto${NC} ${DIM}·${NC} ${BLUE}@soydiloreto${NC}"
  echo ""
}

mgmt_restore() {
  header "${M_RS_TITLE}"
  local in="${ARG_RESTORE_IN:-}"
  if [ -z "${in}" ]; then read -rp "  ${M_RS_PATH}: " in <"$TTY" || true; fi
  if [ -z "${in}" ] || [ ! -f "${in}" ]; then err "${M_RS_NOFILE} ${in}"; return 1; fi

  local tmp; tmp="$(mktemp -d)"
  tar -xzf "${in}" -C "${tmp}" 2>/dev/null || { err "${M_RS_BAD}"; rm -rf "${tmp}"; return 1; }
  if [ ! -f "${tmp}/db.sql" ]; then err "${M_RS_BAD}"; rm -rf "${tmp}"; return 1; fi

  # El modo (local/server), el embedder, el dominio y los secretos VIAJAN con el
  # backup — nunca se preguntan acá. Así la config siempre queda coherente con
  # los datos restaurados. Reconstruimos todo desde el backup y solo ajustamos
  # los paths a esta máquina (sirve igual en un equipo nuevo sin instalación).
  local dir="${ARG_INSTALL_DIR:-$HOME/diluxite}"
  local fresh=0
  [ -f "${dir}/docker-compose.yml" ] || fresh=1

  if [ -f "${tmp}/.diluxite-install.env" ]; then
    # shellcheck disable=SC1090
    . "${tmp}/.diluxite-install.env"
  fi
  INSTALL_DIR="${dir}"; mkdir -p "${INSTALL_DIR}"
  DATA_PATH="${dir}/data"; mkdir -p "${DATA_PATH}/postgres"
  CHANNEL="${DLX_CHANNEL:-2}"; AUTOUPDATE_ON="${DLX_AUTOUPDATE:-1}"
  VERSION="${DLX_VERSION:-next}"; WEB_PORT="${DLX_WEB_PORT:-5173}"
  EMB_OPT="${DLX_EMB_OPT:-3}"
  OLLAMA_MODEL="${DLX_OLLAMA_MODEL:-}"; OLLAMA_DIMS="${DLX_OLLAMA_DIMS:-}"; OLLAMA_ENDPOINT="${DLX_OLLAMA_ENDPOINT:-}"
  AZURE_ENDPOINT="${DLX_AZURE_ENDPOINT:-}"; AZURE_DEPLOYMENT="${DLX_AZURE_DEPLOYMENT:-}"
  AUTH_MODE="${DLX_AUTH_MODE:-local}"; ADMIN_EMAIL="${DLX_ADMIN_EMAIL:-}"
  HTTPS_DOMAIN="${DLX_HTTPS_DOMAIN:-}"; HTTPS_ACME_EMAIL="${DLX_HTTPS_ACME_EMAIL:-${ADMIN_EMAIL}}"
  OIDC_ISSUER="${DLX_OIDC_ISSUER:-}"; OIDC_CLIENT_ID="${DLX_OIDC_CLIENT_ID:-}"; OIDC_REDIRECT_URI="${DLX_OIDC_REDIRECT_URI:-}"
  TRUSTED_HEADER="${DLX_TRUSTED_HEADER:-}"
  CF_TEAM="${DLX_CF_TEAM:-}"; CF_AUD="${DLX_CF_AUD:-}"
  # Secretos: del compose incluido en el backup (no se guardan en el state file).
  ADMIN_PASSWORD="$(compose_env_get "${tmp}/docker-compose.yml" DILUXITE_ADMIN_PASSWORD)"
  AZURE_KEY="$(compose_env_get "${tmp}/docker-compose.yml" AZURE_OPENAI_API_KEY)"
  OIDC_CLIENT_SECRET="$(compose_env_get "${tmp}/docker-compose.yml" DILUXITE_OIDC_CLIENT_SECRET)"
  if [ "${AUTOUPDATE_ON}" = "1" ]; then WATCHTOWER_PROFILES_LINE=""; else WATCHTOWER_PROFILES_LINE='    profiles: ["autoupdate"]'; fi

  local mode_label="local"; [ "${AUTH_MODE}" = "server" ] && mode_label="server (${ADMIN_EMAIL})"
  info "${M_RS_MODE} ${BOLD}${mode_label}${NC}"

  if [ "${fresh}" = "0" ] && ! mgmt_confirm "${M_RS_CONFIRM}"; then
    rm -rf "${tmp}"; info "${M_BYE}"; return 0
  fi

  # Si el backup usa Ollama, dejamos el embedder 100% LISTO (instala si falta +
  # levanta el daemon + pull del modelo) ANTES de levantar el stack — el
  # instalador se encarga, no es solo un aviso.
  if [ "${EMB_OPT}" = "1" ]; then
    ensure_ollama_ready "${OLLAMA_MODEL:-mxbai-embed-large:335m}"
  fi

  # Restaurar el certificado Caddy (si el backup lo trae) ANTES de levantar,
  # con un container efímero para respetar los permisos de root del volumen.
  if [ -f "${tmp}/caddy_data.tgz" ]; then
    info "${M_RS_CADDY}"
    mkdir -p "${DATA_PATH}/caddy_data"
    docker run --rm -v "${DATA_PATH}/caddy_data:/cd" -v "${tmp}:/in:ro" alpine \
      sh -c "tar -xzf /in/caddy_data.tgz -C /cd" >/dev/null 2>&1 || warn "${M_RS_CADDY_FAIL}"
  fi

  # Reconstruir compose/Caddyfile con la config del backup + paths locales.
  render_compose
  local pf; pf="$(compose_profiles)"
  info "${M_PULLING}"; ( cd "${INSTALL_DIR}" && docker compose ${pf} pull )
  info "${M_RESTARTING}"; ( cd "${INSTALL_DIR}" && docker compose ${pf} up -d --remove-orphans )

  # Esperar a que Postgres acepte conexiones antes de cargar el dump.
  info "${M_RS_WAIT}"
  local i
  for i in $(seq 1 60); do
    docker exec diluxite-db pg_isready -U diluxite -d diluxite >/dev/null 2>&1 && break
    sleep 2
  done

  info "${M_RS_LOAD}"
  docker exec -i diluxite-db psql -U diluxite -d diluxite < "${tmp}/db.sql" >/dev/null
  write_state
  rm -rf "${tmp}"
  ok "${M_RS_DONE}"

  # Misma validación de salud + resumen final que una instalación normal.
  local health="http://localhost:${WEB_PORT}/api/update/check"
  [ -n "${HTTPS_DOMAIN}" ] && health="http://localhost:80"
  wait_healthy "${health}" || warn "${MSG_HEALTH_TIMEOUT}"
  print_summary
}

mgmt_uninstall() {
  header "${M_UN_TITLE}"
  # 1. Confirmación principal PRIMERO (acción destructiva; default = No).
  if ! mgmt_confirm "${M_UN_CONFIRM}"; then info "${M_UN_CANCEL}"; return 0; fi
  # 2. Backup opcional antes de bajar.
  if mgmt_confirm "${M_UN_BACKUP_Q}"; then mgmt_backup || true; fi
  # 3. Bajar el stack.
  info "${M_UN_DOWN}"
  ( cd "${INSTALL_DIR}" && docker compose --profile https --profile autoupdate down 2>/dev/null || docker compose down 2>/dev/null || true )
  # 4. ¿Borrar también los datos? (solo controla el dir de datos)
  if mgmt_confirm "${M_UN_DATA_Q} ${DATA_PATH}?"; then
    info "${MSG_DATA_WIPING}"
    # Los archivos de Postgres son de root (uid 999); un `rm` del usuario falla
    # y con set -e abortaría el uninstall. Plain rm primero, y si queda algo
    # (root), container efímero. Nunca aborta.
    rm -rf "${DATA_PATH}" 2>/dev/null || true
    if [ -d "${DATA_PATH}" ]; then
      docker run --rm -v "$(dirname "${DATA_PATH}"):/p" alpine \
        sh -c "rm -rf '/p/$(basename "${DATA_PATH}")'" >/dev/null 2>&1 || true
    fi
  else
    info "${M_UN_DATA_KEPT} ${DATA_PATH}"
  fi
  # 5. SIEMPRE remover los artefactos de instalación generados por el installer
  #    (compose/template/Caddyfile/state) para que un re-run dé el wizard limpio
  #    en vez de detectar una instalación "fantasma". NO tocamos backups/ ni
  #    archivos ajenos (update.sh/cron del usuario, etc.).
  rm -f "${INSTALL_DIR}/docker-compose.yml" \
        "${INSTALL_DIR}/docker-compose.template.yml" \
        "${INSTALL_DIR}/Caddyfile" \
        "${INSTALL_DIR}/${STATE_FILE_NAME}"
  ok "${M_UN_DONE}"
  exit 0  # tras desinstalar no tiene sentido volver al menú
}

# Ejecuta SQL no-interactivo contra la base y devuelve el resultado (tAc).
db_psql() {
  docker exec -i diluxite-db psql -U diluxite -d diluxite -tAc "$1" 2>/dev/null
}

# Render + up SIN pull ni write_state (para los ciclos internos de scrub).
compose_render_up() {
  render_compose
  local pf; pf="$(compose_profiles)"
  ( cd "${INSTALL_DIR}" && docker compose ${pf} up -d --remove-orphans )
}

# Promueve local@diluxite al email del admin: conserva notas/org/space (el
# usuario local YA es super_admin de su org). Solo un email, sin secretos.
# Renombra unicamente si el local existe y el email destino no esta tomado.
promote_local_to_admin() {
  local email="$1"
  db_psql "UPDATE users SET email='${email}' WHERE email='local@diluxite' AND NOT EXISTS (SELECT 1 FROM users WHERE email='${email}');" >/dev/null || true
}

# Setea el password del admin SIN dejar texto plano en reposo:
# escribe el env transitorio -> restart -> espera el hash en la base -> scrub.
# La app (bootstrapServerAdmin) hashea con PBKDF2 y solo aplica si el hash es null.
bootstrap_admin_password() {
  local email="$1" pwd="$2"
  ADMIN_PASSWORD="${pwd}"
  compose_render_up
  info "${M_MS_WAITHASH}"
  local i ok_hash=""
  for i in $(seq 1 30); do
    [ "$(db_psql "SELECT (password_hash IS NOT NULL) FROM users WHERE email='${email}';")" = "t" ] && { ok_hash=1; break; }
    sleep 2
  done
  ADMIN_PASSWORD=""        # scrub: el hash ya vive en la base
  compose_render_up
  write_state
  [ -n "${ok_hash}" ] && ok "${M_MS_PWDOK}" || warn "${M_MS_PWDWAIT}"
}

# Pide un password (min 8) con confirmacion. Deja el valor en REPLY_PWD.
prompt_password() {
  local p1 p2
  while :; do
    read -rsp "  ${M_MS_PWD}: " p1 <"$TTY" || true; echo
    if [ "${#p1}" -lt 8 ]; then warn "min 8"; continue; fi
    read -rsp "  ${M_MS_PWD2}: " p2 <"$TTY" || true; echo
    [ "${p1}" = "${p2}" ] && break || warn "!="
  done
  REPLY_PWD="${p1}"
}

# Cambio de modo local <-> server (con onboarding del super admin).
mgmt_switch_mode() {
  if [ "${AUTH_MODE}" = "local" ]; then
    warn "${M_MS_TO_SERVER}"
    local email=""
    while :; do
      read -rp "  ${M_MS_EMAIL}: " email <"$TTY" || true
      [[ "${email}" =~ ^[^@]+@[^@]+\.[^@]+$ ]] && break
      warn "email?"
    done
    echo ""
    echo "  ${M_MS_SUB}"
    echo "    1) ${M_MS_SUB_CF}"
    echo "    2) ${M_MS_SUB_PWD}"
    echo "    3) ${M_MS_SUB_TH}"
    local sm=""; read -rp "  ${M_PROMPT} [1]: " sm <"$TTY" || true; sm="${sm:-1}"

    AUTH_MODE="server"; ADMIN_EMAIL="${email}"
    promote_local_to_admin "${email}"
    info "${M_MS_PROMOTED} ${email}"

    case "${sm}" in
      1)
        read -rp "  Team domain (ej. miteam.cloudflareaccess.com): " CF_TEAM <"$TTY" || true
        read -rp "  AUD tag: " CF_AUD <"$TTY" || true
        if mgmt_confirm "${M_MS_PWD_OPT}"; then
          prompt_password
          bootstrap_admin_password "${email}" "${REPLY_PWD}"
        else
          reconfig_apply
        fi ;;
      2)
        prompt_password
        bootstrap_admin_password "${email}" "${REPLY_PWD}" ;;
      3)
        warn "${M_MS_TH_WARN}"
        read -rp "  Header [Cf-Access-Authenticated-User-Email]: " TRUSTED_HEADER <"$TTY" || true
        TRUSTED_HEADER="${TRUSTED_HEADER:-Cf-Access-Authenticated-User-Email}"
        reconfig_apply ;;
      *) return ;;
    esac
    ok "${M_MS_SERVER_DONE} ${BOLD}${email}${NC}"
  else
    warn "${M_MS_TO_LOCAL_WARN}"
    if ! mgmt_confirm "${M_MS_TO_LOCAL_CONFIRM}"; then info "${M_BYE}"; return; fi
    AUTH_MODE="local"; CF_TEAM=""; CF_AUD=""; TRUSTED_HEADER=""
    OIDC_ISSUER=""; OIDC_CLIENT_ID=""; OIDC_CLIENT_SECRET=""; OIDC_REDIRECT_URI=""
    reconfig_apply
    ok "${M_MS_LOCAL_DONE}"
  fi
}

# Reset del super admin (break-glass por acceso perdido). Limpia el hash y lo
# re-aplica via bootstrap-then-scrub. Si el user no existe, la app lo crea.
mgmt_reset_admin() {
  header "${M_RA_TITLE}"
  if [ "${AUTH_MODE}" != "server" ]; then err "${M_RA_NOTSERVER}"; return 1; fi
  local email="${ADMIN_EMAIL}"
  if [ -z "${email}" ]; then read -rp "  ${M_MS_EMAIL}: " email <"$TTY" || true; fi
  prompt_password
  db_psql "UPDATE users SET password_hash=NULL WHERE email='${email}';" >/dev/null || true
  ADMIN_EMAIL="${email}"
  bootstrap_admin_password "${email}" "${REPLY_PWD}"
  ok "${M_RA_DONE} ${BOLD}${email}${NC}"
}

mgmt_reconfigure() {
  # Atajos no interactivos (--channel / --autoupdate).
  if [ -n "${ARG_CHANNEL}" ]; then
    case "${ARG_CHANNEL}" in
      latest|stable|1) CHANNEL=1 ;;
      next|pre|prerelease|2) CHANNEL=2 ;;
      *) err "Invalid --channel: ${ARG_CHANNEL} (latest|next)"; exit 1 ;;
    esac
    reconf_set_version; reconfig_apply pull; return
  fi
  if [ -n "${ARG_AUTOUPDATE}" ]; then
    case "${ARG_AUTOUPDATE}" in
      on|1|yes|y) AUTOUPDATE_ON=1 ;;
      off|0|no|n) AUTOUPDATE_ON=0 ;;
      *) err "Invalid --autoupdate: ${ARG_AUTOUPDATE} (on|off)"; exit 1 ;;
    esac
    reconf_set_version; reconfig_apply pull; return
  fi

  # Submenú interactivo.
  while :; do
    header "${M_RC_TITLE} ${DIM}(${AUTH_MODE})${NC}"
    echo "  1) ${M_RC_1}"
    echo "  2) ${M_RC_2}"
    echo "  3) ${M_RC_3}"
    if [ "${AUTH_MODE}" = "server" ]; then
      echo "  4) ${M_RC_4}"
      echo "  5) ${M_RC_5}"
    fi
    echo "  6) ${M_RC_6}"
    [ "${AUTH_MODE}" = "server" ] && echo "  7) ${M_RC_7}"
    echo "  8) ${M_RC_8}"
    [ "${AUTH_MODE}" = "server" ] && echo "  9) ${M_RC_9}"
    echo "  0) ${M_RC_0}"
    echo ""
    local c=""; read -rp "  ${M_PROMPT} [0]: " c <"$TTY" || true
    case "${c}" in
      1)
        local nc=""; read -rp "  ${M_RC_CHAN_Q}: " nc <"$TTY" || true
        case "${nc}" in 1) CHANNEL=1 ;; 2) CHANNEL=2 ;; *) continue ;; esac
        reconf_set_version; reconfig_apply pull ;;
      2)
        local au=""; read -rp "  ${M_RC_AU_Q}: " au <"$TTY" || true
        if [[ "${au:-N}" =~ ^[YySs]$ ]] && confirm_autoupdate_risk; then
          AUTOUPDATE_ON=1
        else
          AUTOUPDATE_ON=0
          [[ "${au:-N}" =~ ^[YySs]$ ]] && info "${MSG_AU_DECLINED}"
        fi
        reconf_set_version; reconfig_apply pull ;;
      3)
        local d=""; read -rp "  ${M_RC_DOMAIN_Q}: " d <"$TTY" || true
        HTTPS_DOMAIN="${d}"
        if [ -n "${HTTPS_DOMAIN}" ]; then
          local ae=""; read -rp "  ${M_RC_ACME_Q} [${ADMIN_EMAIL}]: " ae <"$TTY" || true
          HTTPS_ACME_EMAIL="${ae:-${ADMIN_EMAIL}}"
        else
          warn "${M_RC_HTTPS_OFF}"
        fi
        reconfig_apply ;;
      4)
        [ "${AUTH_MODE}" = "server" ] || continue
        read -rp "  Issuer URL: " OIDC_ISSUER <"$TTY" || true
        read -rp "  Client ID: " OIDC_CLIENT_ID <"$TTY" || true
        read -rsp "  Client Secret: " OIDC_CLIENT_SECRET <"$TTY" || true; echo
        local dr="http://localhost:${WEB_PORT}/api/auth/oidc/callback"
        [ -n "${HTTPS_DOMAIN}" ] && dr="https://${HTTPS_DOMAIN}/api/auth/oidc/callback"
        read -rp "  Redirect URI [${dr}]: " OIDC_REDIRECT_URI <"$TTY" || true
        OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI:-${dr}}"
        reconfig_apply ;;
      5)
        [ "${AUTH_MODE}" = "server" ] || continue
        read -rp "  Header [Cf-Access-Authenticated-User-Email]: " TRUSTED_HEADER <"$TTY" || true
        TRUSTED_HEADER="${TRUSTED_HEADER:-Cf-Access-Authenticated-User-Email}"
        reconfig_apply ;;
      6)
        warn "${M_RC_EMB_WARN}"
        echo "  1) Ollama (mxbai-embed-large, dim 1024)"
        echo "  2) Azure OpenAI"
        echo "  3) ${MSG_EMB_3:-Deterministic local}"
        local e=""; read -rp "  ${M_PROMPT}: " e <"$TTY" || true
        local olddim="${OLLAMA_DIMS:-}"; [ "${EMB_OPT}" = "3" ] && olddim="1536"; [ "${EMB_OPT}" = "2" ] && olddim="azure"
        case "${e}" in
          1) EMB_OPT=1; OLLAMA_MODEL="mxbai-embed-large:335m"; OLLAMA_DIMS="1024"; OLLAMA_ENDPOINT="http://host.docker.internal:11434"; AZURE_ENDPOINT=""; AZURE_KEY=""; AZURE_DEPLOYMENT=""
             [ -n "${olddim}" ] && [ "${olddim}" != "1024" ] && warn "${M_RC_DIM_CHANGE} ${olddim} → 1024."
             ensure_ollama_ready "${OLLAMA_MODEL}" ;;
          2) EMB_OPT=2; OLLAMA_MODEL=""; OLLAMA_DIMS=""; OLLAMA_ENDPOINT=""
             read -rp "  Azure endpoint: " AZURE_ENDPOINT <"$TTY" || true
             read -rsp "  Azure API key: " AZURE_KEY <"$TTY" || true; echo
             read -rp "  Deployment [text-embedding-3-large]: " AZURE_DEPLOYMENT <"$TTY" || true
             AZURE_DEPLOYMENT="${AZURE_DEPLOYMENT:-text-embedding-3-large}"
             [ -n "${olddim}" ] && [ "${olddim}" != "azure" ] && warn "${M_RC_DIM_CHANGE} ${olddim} → azure." ;;
          3) EMB_OPT=3; OLLAMA_MODEL=""; OLLAMA_DIMS=""; OLLAMA_ENDPOINT=""; AZURE_ENDPOINT=""; AZURE_KEY=""; AZURE_DEPLOYMENT=""
             [ -n "${olddim}" ] && [ "${olddim}" != "1536" ] && warn "${M_RC_DIM_CHANGE} ${olddim} → 1536." ;;
          *) continue ;;
        esac
        reconfig_apply ;;
      7)
        [ "${AUTH_MODE}" = "server" ] || continue
        warn "${M_RC_EMAIL_WARN}"
        read -rp "  ${M_RC_7} [${ADMIN_EMAIL}]: " ADMIN_EMAIL <"$TTY" || true
        reconfig_apply ;;
      8) mgmt_switch_mode ;;
      9) [ "${AUTH_MODE}" = "server" ] || continue; mgmt_reset_admin ;;
      0|"") return ;;
      *) ;;
    esac
  done
}

# Imprime el menú de gestión y deja la elección en MENU_ACTION.
mgmt_menu() {
  local chan=":next"; [ "${CHANNEL}" = "1" ] && chan=":latest"
  nice "${M_DETECTED} (${VERSION}, ${chan})."
  echo "  1) ${M_M1}"
  echo "  2) ${M_M2}"
  echo "  3) ${M_M3}"
  echo "  4) ${M_M4}"
  echo "  5) ${M_M5}"
  echo "  6) ${M_M6}"
  echo "  7) ${M_M7}"
  echo "  0) ${M_M0}"
  echo ""
  local c=""; read -rp "  ${M_PROMPT} [0]: " c <"$TTY" || true
  case "${c}" in
    1) MENU_ACTION=update ;;
    2) MENU_ACTION=reconfigure ;;
    3) MENU_ACTION=status ;;
    4) MENU_ACTION=backup ;;
    5) MENU_ACTION=restore ;;
    6) MENU_ACTION=uninstall ;;
    7) MENU_ACTION=seed ;;
    *) MENU_ACTION=quit ;;
  esac
}

# Seed de datos de prueba — lista orgs/spaces y deja elegir DÓNDE cargar las
# notas demo (resuelve el problema de "primer space" del seed en DBs multi-space).
mgmt_seed() {
  header "${M_SEED_TITLE}"
  # El seed corre dentro del container → asegurar el stack arriba.
  ( cd "${INSTALL_DIR}" && docker compose $(compose_profiles) up -d >/dev/null 2>&1 || true )

  local rows
  rows="$(db_psql "SELECT s.id || '|' || coalesce(o.name,'-') || '|' || coalesce(u.email,'-') || '|' || s.name || '|' || count(n.id) FROM spaces s LEFT JOIN organizations o ON o.id=s.org_id LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN notes n ON n.space_id=s.id GROUP BY s.id,o.name,u.email,s.name ORDER BY o.name,s.name;")"

  local SP_IDS=() SP_DESC=()
  local id org owner space notes
  while IFS='|' read -r id org owner space notes; do
    [ -z "${id}" ] && continue
    SP_IDS+=("${id}")
    SP_DESC+=("org=${org} · ${owner} · space=${space} · ${notes} notas")
  done <<EOF
${rows}
EOF

  local n=${#SP_IDS[@]}
  if [ "${n}" -eq 0 ]; then err "${M_SEED_NOSPACE}"; return 1; fi

  local target=""
  if [ "${n}" -eq 1 ]; then
    target="${SP_IDS[0]}"
    info "${M_SEED_ONE} ${SP_DESC[0]}"
  else
    echo ""
    echo "  ${M_SEED_PICK}"
    local k=0
    while [ "${k}" -lt "${n}" ]; do echo "    $((k + 1))) ${SP_DESC[${k}]}"; k=$((k + 1)); done
    echo ""
    local c=""; read -rp "  ${M_PROMPT}: " c <"$TTY" || true
    case "${c}" in ''|*[!0-9]*) info "${M_BYE}"; return 0 ;; esac
    if [ "${c}" -lt 1 ] || [ "${c}" -gt "${n}" ]; then info "${M_BYE}"; return 0; fi
    target="${SP_IDS[$((c - 1))]}"
  fi

  local cnt=""; read -rp "  ${M_SEED_COUNT} [1500]: " cnt <"$TTY" || true
  case "${cnt}" in ''|*[!0-9]*) cnt=1500 ;; esac

  if ! mgmt_confirm "${M_SEED_CONFIRM}"; then info "${M_BYE}"; return 0; fi
  info "${M_SEED_RUNNING}"
  ( cd "${INSTALL_DIR}" && docker compose exec -T -e DILUXITE_SEED_SPACE_ID="${target}" -e COUNT="${cnt}" -w /app diluxite pnpm seed )
  ok "${M_SEED_DONE}"
  show_open_line
}

mgmt_dispatch() {
  case "$1" in
    update)      mgmt_update ;;
    seed)        mgmt_seed ;;
    reconfigure) mgmt_reconfigure ;;
    reset-admin) mgmt_reset_admin ;;
    status)      mgmt_status ;;
    backup)      mgmt_backup ;;
    restore)     mgmt_restore ;;
    uninstall)   mgmt_uninstall ;;
    *)           err "Unknown action: $1"; return 1 ;;
  esac
}

# Punto de entrada del modo gestión.
#   - Con flag (no interactivo): corre la acción una vez y termina con su código.
#   - Sin flag (interactivo): loop del menú — las acciones VUELVEN al menú; solo
#     "0 / Salir" en el menú principal termina el script.
run_management() {
  set_mgmt_messages
  local dir="${ARG_INSTALL_DIR:-$HOME/diluxite}"
  if [ ! -f "${dir}/docker-compose.yml" ]; then
    # Restore puede bootstrappear desde cero (equipo nuevo): no requiere
    # instalación previa, reconstruye todo desde el backup.
    if [ "${ACTION}" = "restore" ]; then mgmt_restore; exit 0; fi
    if [ -n "${ACTION}" ]; then err "${M_NO_INSTALL} ${dir}"; exit 1; fi
    return 0  # sin instalación y sin acción → caer al wizard
  fi
  load_state "${dir}"

  if [ -n "${ACTION}" ]; then
    mgmt_dispatch "${ACTION}"
    exit $?
  fi

  while :; do
    mgmt_menu
    local act="${MENU_ACTION:-quit}"
    if [ "${act}" = "quit" ]; then info "${M_BYE}"; exit 0; fi
    mgmt_dispatch "${act}" || true
    echo ""
    read -rp "  ${M_CONTINUE}" _dummy <"$TTY" || true
  done
}

set_messages

# ─── Banner (after language is set) ────────────────────────────────────────
echo ""
echo -e "  ${BOLD}${MSG_TAGLINE}${NC}"
echo -e "  ${DIM}${MSG_SUBTITLE}${NC}"
echo ""
echo -e "  ${DIM}${MSG_BY} Pablo Ariel Di Loreto · @soydiloreto${NC}"
echo -e "  ${DIM}github.com/soydiloreto/diluxite-core-alpha${NC}"
echo ""

if [ "$(id -u 2>/dev/null || echo 1000)" -eq 0 ]; then
  err "${MSG_NOT_ROOT}"
  exit 1
fi

if [ -z "${ACTION}" ] && [ ! -f "${ARG_INSTALL_DIR:-$HOME/diluxite}/docker-compose.yml" ]; then
  nice "${MSG_GREETING_PRE} $(platform_name). ${MSG_GREETING_POST}"
fi

if [ "${PLATFORM}" = "unknown" ]; then
  warn "${MSG_OS_NOT_RECOGNIZED}"
  read -rp "${MSG_CONTINUE_ANYWAY}" FORCE <"$TTY"
  [[ "${FORCE}" =~ ^[YySs]$ ]] || exit 1
fi

# ─── Step 1 ─────────────────────────────────────────────────────────────────
header "${MSG_STEP1}"

if ! command -v docker &>/dev/null; then
  err "${MSG_DOCKER_MISSING}"
  case "${PLATFORM}" in
    macos|gitbash|wsl) url="https://www.docker.com/products/docker-desktop/" ;;
    *)                 url="https://docs.docker.com/engine/install/" ;;
  esac
  info "${MSG_DOCKER_OPEN} ${url}"
  open_url "${url}"
  info "${MSG_DOCKER_THEN}"
  exit 1
fi
ok "${MSG_DOCKER_PRESENT} $(docker --version)"

if ! docker info >/dev/null 2>&1; then
  err "${MSG_DOCKER_DOWN}"
  case "${PLATFORM}" in
    linux) info "${MSG_DOCKER_START_LINUX}" ;;
    *)     info "${MSG_DOCKER_START_OTHER}" ;;
  esac
  exit 1
fi
ok "${MSG_DOCKER_UP}"

if ! docker compose version >/dev/null 2>&1; then
  err "${MSG_COMPOSE_MISSING}"
  exit 1
fi
ok "${MSG_COMPOSE_OK}"

# ─── Management mode ────────────────────────────────────────────────────────
# Si pidieron una acción por flag, o si ya hay una instalación en el directorio
# destino, entramos al modo gestión (menú o acción directa) y terminamos.
# Si no, seguimos con el wizard de instalación de abajo.
if [ -n "${ACTION}" ] || [ -f "${ARG_INSTALL_DIR:-$HOME/diluxite}/docker-compose.yml" ]; then
  run_management
fi

# Port auto-detect — solo :5173 (web) se publica al host. API (3030) y
# Postgres (5432) viven dentro del network del compose, así que NO chocan
# con otros stacks. Si :5173 está ocupado, probamos hasta +50 buscando libre.
port_is_free() {
  local p="$1"
  if command -v ss &>/dev/null; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\b" && return 1
  fi
  if command -v lsof &>/dev/null; then
    lsof -iTCP:"${p}" -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN && return 1
  fi
  return 0
}
WEB_PORT=5173
for offset in $(seq 0 50); do
  candidate=$(( 5173 + offset ))
  if port_is_free "${candidate}"; then
    WEB_PORT="${candidate}"
    break
  fi
  if [ "${offset}" -eq 50 ]; then
    err "No hay puerto libre en 5173..5223 para el web. Liberá uno y reintentá."
    exit 1
  fi
done
if [ "${WEB_PORT}" -ne 5173 ]; then
  warn "Puerto :5173 ocupado → uso :${WEB_PORT}"
fi
ok "Puerto web elegido: :${WEB_PORT}"

free_mb=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}' || echo 999999)
if [ "${free_mb}" -lt 3000 ]; then
  err "${MSG_DISK_LOW} (${free_mb} MB). ${MSG_DISK_NEEDED}"
  exit 1
fi
ok "${MSG_DISK_FREE} ${free_mb} MB"

# ─── Instalar / Restaurar / Salir ───────────────────────────────────────────
# Equipo sin instalación previa: tras las comprobaciones preguntamos si querés
# instalar de cero o restaurar desde un backup (que reconstruye todo —
# modo/embedder/dominio/secretos/cert— sin más preguntas). Solo interactivo.
if [ -z "${ACTION}" ]; then
  nice "${MSG_START_Q}"
  echo "  1) ${MSG_START_INSTALL}"
  echo "  2) ${MSG_START_RESTORE}"
  echo "  3) ${MSG_START_EXIT}"
  echo ""
  echo -e "  ${DIM}${MSG_HINT_OPTION}${NC}"
  echo ""
  read -rp "  ${MSG_CHOICE} [1]: " START_OPT <"$TTY"
  START_OPT="${START_OPT:-1}"
  case "${START_OPT}" in
    2)
      set_mgmt_messages
      read -rp "  ${MSG_START_BACKUP_PATH}: " RESTORE_PATH <"$TTY" || true
      ARG_RESTORE_IN="${RESTORE_PATH}"
      mgmt_restore
      exit $?
      ;;
    3) info "${MSG_START_BYE}"; exit 0 ;;
    *) : ;;  # 1 → seguimos con el wizard de instalación
  esac
fi

# ─── Step 2 ─────────────────────────────────────────────────────────────────
nice "${MSG_AFTER_STEP1}"
header "${MSG_STEP2}"

echo -e "  ${DIM}${MSG_STEP2_HELP1}${NC}"
echo -e "  ${DIM}${MSG_STEP2_HELP2}${NC}"
echo ""

default_data="${HOME}/diluxite/data"
echo -e "  ${DIM}${MSG_HINT_PATH}${NC}"
echo ""
read -rp "${MSG_STEP2_PATH} [${default_data}]: " DATA_PATH <"$TTY"
DATA_PATH="${DATA_PATH:-${default_data}}"

# Una "instalación nueva" sobre una ruta que YA tiene una base de Postgres la
# reusaría en silencio (el seed iría a un workspace viejo, la app mostraría
# datos previos). Detectarlo y preguntar: reusar o empezar de cero.
if [ -f "${DATA_PATH}/postgres/PG_VERSION" ] || [ -n "$(ls -A "${DATA_PATH}/postgres" 2>/dev/null || true)" ]; then
  echo ""
  warn "${MSG_DATA_EXISTS}"
  echo "  1) ${MSG_DATA_REUSE}"
  echo "  2) ${MSG_DATA_WIPE}"
  echo ""
  read -rp "  ${MSG_CHOICE} [1]: " DATA_CHOICE <"$TTY"
  DATA_CHOICE="${DATA_CHOICE:-1}"
  if [ "${DATA_CHOICE}" = "2" ]; then
    info "${MSG_DATA_WIPING}"
    # Plain rm primero (sirve para datos del usuario); si quedan archivos de
    # root (el postgres del container corre como uid 999), container efímero.
    rm -rf "${DATA_PATH}/postgres" "${DATA_PATH}/caddy_data" "${DATA_PATH}/caddy_config" 2>/dev/null || true
    if [ -d "${DATA_PATH}/postgres" ]; then
      docker run --rm -v "${DATA_PATH}:/d" alpine \
        sh -c 'rm -rf /d/postgres /d/caddy_data /d/caddy_config' >/dev/null 2>&1 || true
    fi
    ok "${MSG_DATA_WIPED}"
  else
    info "${MSG_DATA_REUSING}"
  fi
fi

mkdir -p "${DATA_PATH}/postgres"
ok "${MSG_DATA_AT} ${DATA_PATH}"

default_install="${HOME}/diluxite"
echo ""
echo -e "  ${DIM}${MSG_HINT_PATH}${NC}"
echo ""
read -rp "${MSG_STEP2_INSTALL} [${default_install}]: " INSTALL_DIR <"$TTY"
INSTALL_DIR="${INSTALL_DIR:-${default_install}}"
mkdir -p "${INSTALL_DIR}"
ok "${MSG_INSTALL_AT} ${INSTALL_DIR}"

# ─── Step 3 ─────────────────────────────────────────────────────────────────
nice "${MSG_AFTER_STEP2}"
header "${MSG_STEP3}"

echo "  ${MSG_EMB_1}"
echo "     ${MSG_EMB_1_DESC}"
echo "  ${MSG_EMB_2}"
echo "  ${MSG_EMB_3}"
echo ""
echo -e "  ${DIM}${MSG_HINT_OPTION}${NC}"
echo ""
read -rp "${MSG_CHOICE} [1]: " EMB_OPT <"$TTY"
EMB_OPT=${EMB_OPT:-1}

OLLAMA_MODEL=""; OLLAMA_DIMS=""; OLLAMA_ENDPOINT=""
AZURE_ENDPOINT=""; AZURE_KEY=""; AZURE_DEPLOYMENT=""

case "${EMB_OPT}" in
  1)
    ensure_ollama_ready "mxbai-embed-large:335m"
    OLLAMA_MODEL="mxbai-embed-large:335m"
    OLLAMA_DIMS="1024"
    OLLAMA_ENDPOINT="http://host.docker.internal:11434"
    ;;
  2)
    read -rp "${MSG_AZURE_EP}: " AZURE_ENDPOINT <"$TTY"
    read -rsp "${MSG_AZURE_KEY}: " AZURE_KEY <"$TTY"; echo
    echo -e "  ${DIM}${MSG_HINT_TEXT}${NC}"
    echo ""
    read -rp "${MSG_AZURE_DEPLOY}: " AZURE_DEPLOYMENT <"$TTY"
    AZURE_DEPLOYMENT=${AZURE_DEPLOYMENT:-text-embedding-3-large}
    ok "${MSG_AZURE_OK}"
    ;;
  3)
    warn "${MSG_DETERMINISTIC}"
    ;;
  *)
    err "${MSG_INVALID} ${EMB_OPT}"; exit 1 ;;
esac

# ─── Step 4 ─────────────────────────────────────────────────────────────────
nice "${MSG_AFTER_STEP3}"
header "${MSG_STEP4}"
echo "  ${MSG_SEED_1}"
echo "  ${MSG_SEED_2}"
echo ""
echo -e "  ${DIM}${MSG_HINT_OPTION}${NC}"
echo ""
read -rp "${MSG_CHOICE} [1]: " SEED_OPT <"$TTY"
SEED_OPT=${SEED_OPT:-1}

# ─── Step 5 ─────────────────────────────────────────────────────────────────
nice "${MSG_AFTER_STEP4}"
header "${MSG_STEP5}"

VERSION="${DILUXITE_VERSION:-}"

if [ -z "${VERSION}" ]; then
  echo "  ${MSG_CHAN_1}"
  echo "  ${MSG_CHAN_2}"
  echo ""
  echo -e "  ${DIM}${MSG_HINT_OPTION}${NC}"
  echo ""
  read -rp "${MSG_CHOICE} [1]: " CHANNEL <"$TTY"
  CHANNEL=${CHANNEL:-1}

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
      info "${MSG_LOOKUP_STABLE}"
      VERSION=$(api_get_tag \
        "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases/latest" \
        "print(d.get('tag_name','').lstrip('v'))")
      if [ -z "${VERSION}" ]; then
        warn "${MSG_FALLBACK_STABLE}"
        info "${MSG_FALLBACK_LATEST}"
        VERSION="latest"
      fi
      ;;
    2)
      info "${MSG_LOOKUP_PRE}"
      VERSION=$(api_get_tag \
        "https://api.github.com/repos/soydiloreto/diluxite-core-alpha/releases" \
        "print(d[0]['tag_name'].lstrip('v') if d else '')")
      if [ -z "${VERSION}" ]; then
        warn "${MSG_FALLBACK_PRE}"
        info "${MSG_FALLBACK_NEXT}"
        VERSION="next"
      fi
      ;;
    *)
      err "${MSG_INVALID} ${CHANNEL}"; exit 1 ;;
  esac
fi

ok "${MSG_VERSION} ${VERSION}"

# ─── Step 6 — Auto-update ──────────────────────────────────────────────────
# We pick between two compose flavours up front:
#   - Auto-update on:  image tag is the rolling channel (`:latest` or `:next`)
#                      AND Watchtower is part of the default services. The user
#                      gets new versions without having to do anything.
#   - Auto-update off: image tag is pinned to the resolved version (eg
#                      `1.0.0-alpha.9`) for reproducibility. Watchtower stays
#                      behind the `autoupdate` profile so `docker compose up`
#                      doesn't start it.
# Defaults to ON — Pablo's "always up to date" preference for self-hosted apps.
nice "${MSG_AFTER_STEP5}"
header "${MSG_STEP_AUTOUPDATE}"

echo "  ${MSG_AUTOUPDATE_DESC1}"
echo ""
echo -e "  ${DIM}${MSG_AUTOUPDATE_DESC2}${NC}"
echo -e "  ${DIM}${MSG_AUTOUPDATE_WARN}${NC}"
echo ""
echo -e "  ${DIM}${MSG_HINT_YN_Y}${NC}"
echo ""
# OPT-IN: default = No. Si pide auto-update, mostramos la doble advertencia
# (no producción + socket=root) y exigimos confirmación explícita.
read -rp "${MSG_AUTOUPDATE_Q}" AUTOUPDATE <"$TTY"
AUTOUPDATE=${AUTOUPDATE:-N}

if [[ "${AUTOUPDATE}" =~ ^[YySs]$ ]] && confirm_autoupdate_risk; then
  AUTOUPDATE_ON=1
  # Tag rolling para que Watchtower tenga algo que reconciliar (pinear sería
  # un no-op silencioso).
  case "${CHANNEL:-2}" in
    1) VERSION="latest" ;;
    2) VERSION="next" ;;
  esac
  WATCHTOWER_PROFILES_LINE=""
  ok "${MSG_AUTOUPDATE_ON}"
else
  AUTOUPDATE_ON=0
  WATCHTOWER_PROFILES_LINE='    profiles: ["autoupdate"]'
  # Distinguimos "dijo que no" de "dijo que sí pero declinó el riesgo".
  if [[ "${AUTOUPDATE}" =~ ^[YySs]$ ]]; then info "${MSG_AU_DECLINED}"; else ok "${MSG_AUTOUPDATE_OFF}"; fi
fi

# ─── Step 7 — Auth mode ─────────────────────────────────────────────────────
nice "${MSG_AFTER_STEP_AUTOUPDATE}"
header "${MSG_STEP6_MODE}"

echo "  ${MSG_MODE_1}"
echo "  ${MSG_MODE_2}"
echo ""
echo -e "  ${DIM}${MSG_HINT_OPTION}${NC}"
echo ""
read -rp "${MSG_CHOICE} [1]: " MODE_OPT <"$TTY"
MODE_OPT=${MODE_OPT:-1}

AUTH_MODE="local"
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
HTTPS_DOMAIN=""
HTTPS_ACME_EMAIL=""
OIDC_ISSUER=""
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
OIDC_REDIRECT_URI=""
TRUSTED_HEADER=""
CF_TEAM=""
CF_AUD=""

if [ "${MODE_OPT}" = "2" ]; then
  AUTH_MODE="server"
  # Loop until the admin enters matching, long-enough passwords.
  while :; do
    read -rp "${MSG_ADMIN_EMAIL}: " ADMIN_EMAIL <"$TTY"
    if [ -z "${ADMIN_EMAIL}" ] || ! [[ "${ADMIN_EMAIL}" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
      warn "Invalid email."
      continue
    fi
    read -rsp "${MSG_ADMIN_PASSWORD}: " ADMIN_PASSWORD <"$TTY"; echo
    if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
      warn "${MSG_PASSWORD_SHORT}"
      continue
    fi
    read -rsp "${MSG_ADMIN_PASSWORD_CONFIRM}: " CONFIRM <"$TTY"; echo
    if [ "${ADMIN_PASSWORD}" != "${CONFIRM}" ]; then
      warn "${MSG_PASSWORD_MISMATCH}"
      continue
    fi
    break
  done
  ok "${MSG_MODE_SERVER_OK} ${ADMIN_EMAIL}"

  # ── HTTPS via Caddy sidecar (opcional) ────────────────────────────────
  # Si el operator pasa un domain valido, generamos un Caddyfile y
  # levantamos el container `caddy` con profile `https`. ACME se encarga
  # solo del cert. Si lo skipea, el deploy queda en :5173 plain HTTP y el
  # admin se encargara de TLS upstream (Cloudflare proxied, nginx host,
  # etc.).
  echo ""
  echo -e "${CYAN}${BOLD}HTTPS (Caddy sidecar)${NC}"
  echo -e "  ${DIM}Si tenes un dominio publico que ya apunta a esta maquina,${NC}"
  echo -e "  ${DIM}podemos terminar TLS automaticamente con Lets Encrypt.${NC}"
  read -rp "  Domain (ej. diluxite.tudominio.com, enter para skip): " HTTPS_DOMAIN <"$TTY"
  if [ -n "${HTTPS_DOMAIN}" ]; then
    # Default ACME email = admin email (LE solo lo usa para alertas de
    # expiracion). El admin lo puede pisar.
    read -rp "  Email para alertas de Lets Encrypt [${ADMIN_EMAIL}]: " HTTPS_ACME_EMAIL <"$TTY"
    HTTPS_ACME_EMAIL="${HTTPS_ACME_EMAIL:-${ADMIN_EMAIL}}"
    ok "HTTPS habilitado para ${HTTPS_DOMAIN}"
  fi

  # ── OIDC SSO (opcional) ───────────────────────────────────────────────
  # Si el operator quiere SSO ya configurado, tomamos los 4 valores.
  # Si skipea, las env vars quedan vacias y la pantalla de login solo
  # muestra email+password. Se puede activar despues editando el compose.
  echo ""
  echo -e "${CYAN}${BOLD}OIDC SSO (opcional)${NC}"
  echo -e "  ${DIM}Conectar Okta/Entra/Google/Authentik ahora. Skip = lo configuras despues.${NC}"
  read -rp "  Configurar OIDC ahora? [y/N]: " OIDC_YN <"$TTY"
  if [[ "${OIDC_YN}" =~ ^[yYsS]$ ]]; then
    read -rp "  Issuer URL (ej. https://login.microsoftonline.com/<tenant>/v2.0): " OIDC_ISSUER <"$TTY"
    read -rp "  Client ID: " OIDC_CLIENT_ID <"$TTY"
    read -rsp "  Client Secret: " OIDC_CLIENT_SECRET <"$TTY"; echo
    # Inferir redirect URI a partir del HTTPS_DOMAIN si esta seteado.
    DEFAULT_REDIRECT="http://localhost:${WEB_PORT}/api/auth/oidc/callback"
    if [ -n "${HTTPS_DOMAIN}" ]; then
      DEFAULT_REDIRECT="https://${HTTPS_DOMAIN}/api/auth/oidc/callback"
    fi
    read -rp "  Redirect URI [${DEFAULT_REDIRECT}]: " OIDC_REDIRECT_URI <"$TTY"
    OIDC_REDIRECT_URI="${OIDC_REDIRECT_URI:-${DEFAULT_REDIRECT}}"
    ok "OIDC configurado contra ${OIDC_ISSUER}"
  fi

  # ── Trusted-header proxy (opcional, mutuamente NO exclusivo con OIDC) ─
  echo ""
  echo -e "${CYAN}${BOLD}Identity-Aware Proxy (opcional)${NC}"
  echo -e "  ${DIM}Si delegas la auth en Cloudflare Access / Authelia / Pomerium${NC}"
  echo -e "  ${DIM}upstream, Diluxite confia en el header con el email.${NC}"
  read -rp "  Configurar trusted-header ahora? [y/N]: " TH_YN <"$TTY"
  if [[ "${TH_YN}" =~ ^[yYsS]$ ]]; then
    read -rp "  Nombre del header [Cf-Access-Authenticated-User-Email]: " TRUSTED_HEADER <"$TTY"
    TRUSTED_HEADER="${TRUSTED_HEADER:-Cf-Access-Authenticated-User-Email}"
    warn "  CUIDADO: TODO el trafico debe llegar SOLO via tu proxy o el header se puede falsificar."
    ok "Trusted header: ${TRUSTED_HEADER}"
  fi
else
  ok "${MSG_MODE_LOCAL_OK}"
fi

# ─── Step 7 — Generate compose ─────────────────────────────────────────────
nice "${MSG_AFTER_STEP6_MODE}"
header "${MSG_STEP7}"

render_compose

# ─── Step 8 — Bring it up ──────────────────────────────────────────────────
nice "${MSG_AFTER_STEP7}"
header "${MSG_STEP8}"

cd "${INSTALL_DIR}"

# Add `--profile https` when Caddy esta activado para que el sidecar se levante
# en el mismo `docker compose up -d`.
COMPOSE_PROFILES_FLAGS=""
HEALTH_URL="http://localhost:${WEB_PORT}/api/update/check"
if [ -n "${HTTPS_DOMAIN}" ]; then
  COMPOSE_PROFILES_FLAGS="--profile https"
  # Health check va contra el host del domain; pero Lets Encrypt puede tardar
  # 10-30s en emitir el cert, asi que damos el primer hit a Caddy mismo.
  HEALTH_URL="http://localhost:80"
fi

info "${MSG_PULLING}"
docker compose ${COMPOSE_PROFILES_FLAGS} pull
info "${MSG_STARTING}"
docker compose ${COMPOSE_PROFILES_FLAGS} up -d
ok "${MSG_CONTAINERS_UP}"

wait_healthy "${HEALTH_URL}" || exit 1

if [ "${SEED_OPT}" = "2" ]; then
  info "${MSG_SEED_LOADING}"
  docker compose exec -T -w /app diluxite pnpm seed </dev/null \
    || warn "${MSG_SEED_FAIL} docker compose exec -w /app diluxite pnpm seed"
fi

# Persistir la config elegida para que re-correr el installer ofrezca el menú
# de gestión (update/reconfigure/...) en vez de repetir el wizard.
write_state

# ─── Done — closing salsa ──────────────────────────────────────────────────
print_summary
