#!/usr/bin/env bash
# ==============================================================================
# Diluxite installer — Linux / macOS / WSL2 / Git Bash on Windows.
# i18n: English / Español / Português.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main/install.sh | bash
# ==============================================================================
set -euo pipefail

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

DILUXITE_REPO_RAW="https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"

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
      MSG_CONTINUE_ANYWAY="¿Continuar de todos modos? [s/N]: "
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
      MSG_STEP2="Paso 2 / 9 — Dónde guardar tus datos"
      MSG_STEP2_HELP1="Esta es la carpeta donde van a vivir tus notas, la base de datos Postgres"
      MSG_STEP2_HELP2="y la configuración. Para hacer backup de Diluxite copiás esta carpeta."
      MSG_STEP2_PATH="Ruta para tus datos"
      MSG_STEP2_INSTALL="Ruta de instalación (donde va docker-compose.yml)"
      MSG_DATA_AT="Datos en:"
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
      MSG_OLLAMA_INSTALL_Q="¿Querés que lo instale ahora (curl ollama.com/install.sh | sh)? [S/n]: "
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
      MSG_AUTOUPDATE_Q="¿Activar auto-actualización? [S/n]: "
      MSG_AUTOUPDATE_ON="Auto-actualización activada (Watchtower revisa cada 6h)."
      MSG_AUTOUPDATE_OFF="Auto-actualización desactivada. El banner amarillo en la UI te avisa cuando hay versión nueva."
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
      MSG_CONTINUE_ANYWAY="Continuar mesmo assim? [s/N]: "
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
      MSG_STEP2="Passo 2 / 9 — Onde guardar seus dados"
      MSG_STEP2_HELP1="Esta é a pasta onde vão viver suas notas, o banco Postgres"
      MSG_STEP2_HELP2="e a configuração. Para fazer backup do Diluxite, copie essa pasta."
      MSG_STEP2_PATH="Caminho para seus dados"
      MSG_STEP2_INSTALL="Caminho de instalação (onde fica docker-compose.yml)"
      MSG_DATA_AT="Dados em:"
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
      MSG_OLLAMA_INSTALL_Q="Quer que eu instale agora (curl ollama.com/install.sh | sh)? [S/n]: "
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
      MSG_AUTOUPDATE_Q="Ativar auto-atualização? [S/n]: "
      MSG_AUTOUPDATE_ON="Auto-atualização ativada (Watchtower verifica a cada 6h)."
      MSG_AUTOUPDATE_OFF="Auto-atualização desativada. O banner amarelo na UI avisa quando há versão nova."
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
      MSG_STEP2="Step 2 / 9 — Where to keep your data"
      MSG_STEP2_HELP1="This is the folder where your notes, the Postgres database and the"
      MSG_STEP2_HELP2="configuration will live. To back up Diluxite you just copy this folder."
      MSG_STEP2_PATH="Path for your data"
      MSG_STEP2_INSTALL="Install path (where docker-compose.yml lives)"
      MSG_DATA_AT="Data path:"
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
      MSG_AUTOUPDATE_Q="Enable auto-update? [Y/n]: "
      MSG_AUTOUPDATE_ON="Auto-update enabled (Watchtower checks every 6h)."
      MSG_AUTOUPDATE_OFF="Auto-update disabled. The yellow banner in the UI will tell you when a new version is out."
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

nice "${MSG_GREETING_PRE} $(platform_name). ${MSG_GREETING_POST}"

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

for port in 3030 5173 5432; do
  if command -v ss &>/dev/null && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\b"; then
    err "${MSG_PORT_BUSY} ${port} ${MSG_PORT_BUSY_AFTER}"; exit 1
  fi
  if command -v lsof &>/dev/null && lsof -iTCP:${port} -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN; then
    err "${MSG_PORT_BUSY} ${port} ${MSG_PORT_BUSY_AFTER}"; exit 1
  fi
done
ok "${MSG_PORTS_FREE}"

free_mb=$(df -m . 2>/dev/null | tail -1 | awk '{print $4}' || echo 999999)
if [ "${free_mb}" -lt 3000 ]; then
  err "${MSG_DISK_LOW} (${free_mb} MB). ${MSG_DISK_NEEDED}"
  exit 1
fi
ok "${MSG_DISK_FREE} ${free_mb} MB"

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
        # On macOS the official Ollama installer ends with `open -a Ollama`,
        # which fails with "Unable to find application named 'Ollama'" when
        # LaunchServices has not yet indexed the app just copied to /Applications.
        # Tolerate that non-zero exit — ensure_ollama_running starts the app
        # with retries before the first `ollama pull`.
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
    # LaunchServices may need a few seconds after a fresh install. Retry up to 30s.
    for _ in $(seq 1 15); do
      open -a Ollama 2>/dev/null && break
      sleep 2
    done
  fi
  # First daemon boot can be slow — wait up to 2 min.
  for _ in $(seq 1 60); do
    curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && return 0
    sleep 2
  done
  err "Ollama daemon did not respond on http://localhost:11434 after 2 min. Start it manually and re-run this script."
  exit 1
}

case "${EMB_OPT}" in
  1)
    ensure_ollama
    ensure_ollama_running
    info "${MSG_OLLAMA_PULL}"
    ollama pull mxbai-embed-large:335m
    ok "${MSG_MODEL_OK}"
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
read -rp "${MSG_AUTOUPDATE_Q}" AUTOUPDATE <"$TTY"
AUTOUPDATE=${AUTOUPDATE:-Y}

if [[ "${AUTOUPDATE}" =~ ^[YySs]$ ]]; then
  AUTOUPDATE_ON=1
  # Swap the resolved version for the rolling channel tag so Watchtower has
  # something to reconcile against. Pinning to `1.0.0-alpha.9` would make
  # auto-update a silent no-op.
  case "${CHANNEL:-2}" in
    1) VERSION="latest" ;;
    2) VERSION="next" ;;
  esac
  # Empty placeholder = no `profiles:` line on the watchtower service, so it
  # comes up with the rest by default.
  WATCHTOWER_PROFILES_LINE=""
  ok "${MSG_AUTOUPDATE_ON}"
else
  AUTOUPDATE_ON=0
  # Keep the watchtower service hidden behind the `autoupdate` profile so it
  # only runs when explicitly opted in (legacy behaviour).
  WATCHTOWER_PROFILES_LINE='    profiles: ["autoupdate"]'
  ok "${MSG_AUTOUPDATE_OFF}"
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
else
  ok "${MSG_MODE_LOCAL_OK}"
fi

# ─── Step 7 — Generate compose ─────────────────────────────────────────────
nice "${MSG_AFTER_STEP6_MODE}"
header "${MSG_STEP7}"

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
    -e "s${DLM}__EXTRA_HOSTS__${DLM}${EXTRA_HOSTS_LINE}${DLM}" \
    -e "s${DLM}__WATCHTOWER_PROFILES__${DLM}${WATCHTOWER_PROFILES_LINE}${DLM}" \
    "${template_path}" > "${compose_path}"

ok "${MSG_COMPOSE_READY}"

# ─── Step 8 — Bring it up ──────────────────────────────────────────────────
nice "${MSG_AFTER_STEP7}"
header "${MSG_STEP8}"

cd "${INSTALL_DIR}"
info "${MSG_PULLING}"
docker compose pull
info "${MSG_STARTING}"
docker compose up -d
ok "${MSG_CONTAINERS_UP}"

info "${MSG_WAITING}"
for i in $(seq 1 60); do
  if curl -fsS http://localhost:5173/api/update/check >/dev/null 2>&1; then
    ok "${MSG_HEALTHY}"
    break
  fi
  sleep 2
  if [ "${i}" -eq 60 ]; then
    err "${MSG_HEALTH_TIMEOUT}"
    err "${MSG_LOGS} cd ${INSTALL_DIR} && docker compose logs"
    exit 1
  fi
done

if [ "${SEED_OPT}" = "2" ]; then
  info "${MSG_SEED_LOADING}"
  docker compose exec -T -w /app diluxite pnpm seed </dev/null \
    || warn "${MSG_SEED_FAIL} docker compose exec -w /app diluxite pnpm seed"
fi

# ─── Done — closing salsa ──────────────────────────────────────────────────
if [ -n "${OLLAMA_MODEL}" ]; then
  EMBEDDER_LABEL="${MSG_EMB_OLLAMA} (${OLLAMA_MODEL})"
elif [ -n "${AZURE_ENDPOINT}" ]; then
  EMBEDDER_LABEL="${MSG_EMB_AZURE}"
else
  EMBEDDER_LABEL="${MSG_EMB_DET}"
fi

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}    ${MSG_DONE_TITLE}${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}${MSG_OPEN_NOW}${NC}  ${GREEN}${BOLD}→  http://localhost:5173  ←${NC}"
echo ""
echo -e "  ${DIM}${MSG_FIRST_LOAD1}${NC}"
echo -e "  ${DIM}${MSG_FIRST_LOAD2}${NC}"
echo ""
echo -e "${CYAN}${BOLD}${MSG_WHATS_INSTALLED}${NC}"
echo -e "  ${BOLD}${MSG_VERSION_LABEL}${NC}      ${VERSION}"
echo -e "  ${BOLD}${MSG_EMBEDDER_LABEL}${NC}     ${EMBEDDER_LABEL}"
echo -e "  ${BOLD}${MSG_DATA_LABEL}${NC}  ${DATA_PATH}"
echo -e "  ${BOLD}${MSG_INSTALL_LABEL}${NC}  ${INSTALL_DIR}"
if [ "${AUTOUPDATE_ON}" = "1" ]; then
  echo -e "  ${BOLD}${MSG_AUTOUPDATE_LABEL}${NC}  ${MSG_AUTOUPDATE_LABEL_ON}"
else
  echo -e "  ${BOLD}${MSG_AUTOUPDATE_LABEL}${NC}  ${MSG_AUTOUPDATE_LABEL_OFF}"
fi
if [ "${SEED_OPT}" = "2" ]; then
  echo -e "  ${BOLD}${MSG_SEED_LOADED}${NC}  ${MSG_SEED_LOADED_DESC}"
fi
echo ""
echo -e "${CYAN}${BOLD}${MSG_USEFUL_CMDS}${NC} ${DIM}${MSG_USEFUL_FROM} ${INSTALL_DIR})${NC}"
echo -e "  ${YELLOW}docker compose logs -f${NC}                          ${DIM}# ${MSG_CMD_LOGS}${NC}"
echo -e "  ${YELLOW}docker compose down${NC}                             ${DIM}# ${MSG_CMD_DOWN}${NC}"
if [ "${AUTOUPDATE_ON}" = "1" ]; then
  echo -e "  ${YELLOW}docker compose pull && docker compose up -d${NC}     ${DIM}# ${MSG_CMD_FORCE_UPDATE}${NC}"
else
  echo -e "  ${YELLOW}docker compose pull && docker compose up -d${NC}     ${DIM}# ${MSG_CMD_UPDATE}${NC}"
  echo -e "  ${YELLOW}docker compose --profile autoupdate up -d${NC}       ${DIM}# ${MSG_CMD_AUTOUPDATE}${NC}"
fi
echo ""
echo -e "${CYAN}${BOLD}${MSG_BACKUP}${NC}"
echo -e "  ${MSG_BACKUP_DESC} ${BOLD}${DATA_PATH}${NC} ${DIM}${MSG_BACKUP_DESC2}${NC}"
echo ""
echo -e "${MAGENTA}${BOLD}${MSG_THANKS}${NC}"
echo -e "  ${DIM}${MSG_QUESTIONS}${NC} ${BLUE}github.com/soydiloreto/diluxite-core-alpha${NC}"
echo -e "  ${DIM}${MSG_BUILT_BY}${NC} ${BOLD}Pablo Ariel Di Loreto${NC} ${DIM}·${NC} ${BLUE}@soydiloreto${NC}"
echo ""
