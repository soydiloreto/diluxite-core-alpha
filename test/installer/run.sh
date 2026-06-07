#!/usr/bin/env bash
# End-to-end lifecycle tests for install.sh with a MOCKED docker + curl (no real
# daemon, no network). Drives the script via piped stdin (DILUXITE_TTY override).
#
#   bash test/installer/run.sh        # or: pnpm test:installer
#
# Covers exactly the class of bugs that pure-function harnesses miss: detection
# routing (installed -> menu, fresh -> wizard), the menu loop, status, pull
# coherence, and the uninstall->clean-slate lifecycle (regression for the
# "phantom install" bug).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
INSTALL="${REPO}/install.sh"

export PATH="${HERE}/bin:${PATH}"     # mock docker/curl primero
export DILUXITE_TTY=/dev/stdin        # leer input por pipe (sin tty real)
export DILUXITE_VERSION=next          # saltea el lookup de canal (sin red)
export DOCKER_MOCK_LOG=/tmp/dlx-docker-mock.log
chmod +x "${HERE}/bin/docker" "${HERE}/bin/curl" 2>/dev/null || true

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
has()    { case "$1" in *"$2"*) ok "$3";;  *) bad "$3 — no contiene: [$2]";; esac; }
hasnt()  { case "$1" in *"$2"*) bad "$3 — NO debería contener: [$2]";; *) ok "$3";; esac; }
isfile()   { [ -f "$1" ] && ok "$2" || bad "$2 — falta $1"; }
nofile()   { [ ! -f "$1" ] && ok "$2" || bad "$2 — no debería existir $1"; }

OUT=""; RC=0
run() {  # run <home> <stdin-escapes> [args...]
  local home="$1" input="$2"; shift 2
  # SEGURIDAD: jamás correr contra un HOME no aislado (estos tests hacen
  # `--uninstall -y`, que borra datos). Si `home` no es un tmp, abortar todo.
  case "${home}" in
    /tmp/*|/var/folders/*) ;;
    *) echo "FATAL: HOME no aislado (${home}) — abortando para no tocar datos reales"; exit 99 ;;
  esac
  : > "${DOCKER_MOCK_LOG}"
  # HOME va del lado DERECHO del pipe (el bash), no del printf.
  OUT="$(printf '%b' "${input}" | HOME="${home}" timeout 90 bash "${INSTALL}" "$@" 2>&1)"; RC=$?
}

echo "== install.sh e2e (docker/curl mockeados) =="
H="$(mktemp -d)"

echo "[1] Instalación fresca (wizard) sobre HOME vacío"
# lang=es · datapath default · installpath default · embedder=3 (determinista)
# · seed=no(1) · auto-update=no(n) · modo=local(1)
run "${H}" '2\n\n\n3\n1\nn\n1\n'
isfile "${H}/diluxite/docker-compose.yml"      "instala → crea docker-compose.yml"
isfile "${H}/diluxite/.diluxite-install.env"   "instala → persiste el state"
has    "${OUT}" "http://localhost"             "instala → muestra la URL final"

echo "[2] Re-correr con instalación presente → menú (no wizard)"
run "${H}" '2\n0\n'
has   "${OUT}" "ya está instalado"             "detecta install → menú"
hasnt "${OUT}" "Dónde guardar tus datos"       "detecta install → NO arranca el wizard"

echo "[3] El menú VUELVE al menú tras una acción (no sale)"
run "${H}" '2\n3\n\n0\n'    # status → enter → salir
n="$(printf '%s' "${OUT}" | grep -c 'ya está instalado')"
[ "${n}" -ge 2 ] && ok "menú reaparece tras status (x${n})" || bad "menú NO reaparece tras status (x${n})"

echo "[4] Status muestra la versión REAL (no solo el tag)"
run "${H}" '' --status
has "${OUT}" "1.0.0-alpha.48"                  "status → versión real via /api/info"

echo "[5] Coherencia de pulls: status NO baja imágenes; update SÍ"
run "${H}" '' --status
hasnt "$(cat "${DOCKER_MOCK_LOG}")" "compose pull" "status → sin pull"
run "${H}" '' --update
has   "$(cat "${DOCKER_MOCK_LOG}")" "compose pull" "update → con pull"

echo "[6] REGRESIÓN: uninstall remueve artefactos → re-run limpio (sin fantasma)"
run "${H}" '' --uninstall -y
nofile "${H}/diluxite/docker-compose.yml"      "uninstall → remueve docker-compose.yml"
nofile "${H}/diluxite/.diluxite-install.env"   "uninstall → remueve el state"
run "${H}" '' --status
[ "${RC}" -ne 0 ] && ok "tras uninstall, --status falla (no install)" || bad "tras uninstall, --status NO debería andar (RC=${RC})"

echo "[7] Re-correr tras uninstall → wizard (NO menú fantasma)"
run "${H}" '2\n\n\n3\n1\nn\n1\n'
hasnt "${OUT}" "ya está instalado"             "post-uninstall → NO detecta fantasma"
isfile "${H}/diluxite/docker-compose.yml"      "post-uninstall → reinstala limpio"

rm -rf "${H}"
echo ""
echo "== Resultado: ${PASS} PASS / ${FAIL} FAIL =="
[ "${FAIL}" -eq 0 ]
