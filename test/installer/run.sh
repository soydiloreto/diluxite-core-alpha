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
export OLLAMA_MOCK_LOG=/tmp/dlx-ollama-mock.log
chmod +x "${HERE}/bin/docker" "${HERE}/bin/curl" "${HERE}/bin/ollama" 2>/dev/null || true

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
  : > "${DOCKER_MOCK_LOG}"; : > "${OLLAMA_MOCK_LOG}"
  # HOME va del lado DERECHO del pipe (el bash), no del printf.
  OUT="$(printf '%b' "${input}" | HOME="${home}" timeout 90 bash "${INSTALL}" "$@" 2>&1)"; RC=$?
}

echo "== install.sh e2e (docker/curl mockeados) =="
H="$(mktemp -d)"

echo "[1] Instalación fresca (wizard) sobre HOME vacío"
# lang=es · datapath default · installpath default · embedder=3 (determinista)
# · seed=no(1) · auto-update=no(n) · modo=local(1)
run "${H}" '2\n1\n\n\n3\n1\nn\n1\n'
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
[ ! -d "${H}/diluxite/data" ] && ok "uninstall (borrar datos) → elimina la carpeta de datos" || bad "uninstall → NO borró los datos"
run "${H}" '' --status
[ "${RC}" -ne 0 ] && ok "tras uninstall, --status falla (no install)" || bad "tras uninstall, --status NO debería andar (RC=${RC})"

echo "[7] Re-correr tras uninstall → wizard (NO menú fantasma)"
run "${H}" '2\n1\n\n\n3\n1\nn\n1\n'
hasnt "${OUT}" "ya está instalado"             "post-uninstall → NO detecta fantasma"
isfile "${H}/diluxite/docker-compose.yml"      "post-uninstall → reinstala limpio"

echo "[8] Equipo nuevo: fork Instalar/Restaurar/Salir tras las comprobaciones"
H8="$(mktemp -d)"
run "${H8}" '2\n3\n'                            # lang es → opción 3 (Salir)
has   "${OUT}" "¿Qué querés hacer"             "fork aparece tras las comprobaciones"
hasnt "${OUT}" "Dónde guardar tus datos"       "opción Salir → NO entra al wizard"
nofile "${H8}/diluxite/docker-compose.yml"     "opción Salir → no instala nada"
rm -rf "${H8}"

echo "[9] Equipo nuevo: restaurar desde el fork (opción 2)"
run "${H}" '' --backup                         # H quedó instalado tras [7]
BK="$(ls -t "${H}"/diluxite/backups/*.tar.gz 2>/dev/null | head -1)"
H9="$(mktemp -d)"
run "${H9}" "2\n2\n${BK}\n"                     # lang → opción 2 (restore) → ruta
isfile "${H9}/diluxite/docker-compose.yml"     "restore via fork → reconstruye en equipo nuevo"
isfile "${H9}/diluxite/.diluxite-install.env"  "restore via fork → persiste el state"
has    "${OUT}" "Restore"                       "restore via fork → ejecuta el restore"
has    "${OUT}" "corriendo"                      "restore → resumen final + health (como install)"
rm -rf "${H9}"

rm -rf "${H}"

echo "[10] Reconfigure es mode-aware (en local NO ofrece SSO/OIDC)"
H10="$(mktemp -d)"
run "${H10}" '2\n1\n\n\n3\n1\nn\n1\n'          # install local
run "${H10}" '2\n2\n0\n\n0\n'                   # menú→2 reconfigure→0 back→enter→0 salir
has   "${OUT}" "Canal de updates"              "reconfigure (local) → muestra Canal"
hasnt "${OUT}" "OIDC SSO"                       "reconfigure (local) → NO ofrece OIDC/SSO"
rm -rf "${H10}"

echo "[11] Cambio local→server: promueve usuario + password SIN texto plano (scrub)"
H11="$(mktemp -d)"
run "${H11}" '2\n1\n\n\n3\n1\nn\n1\n'          # install local
# menú→2 reconfigure→8 cambiar modo→email→submodo 2(pwd)→pwd→pwd→0 back→enter→0 salir
run "${H11}" '2\n2\n8\nadmin@x.com\n2\nSecretpass1\nSecretpass1\n0\n\n0\n'
C11="${H11}/diluxite/docker-compose.yml"
grep -q 'DILUXITE_AUTH_MODE: "server"' "${C11}" && ok "switch → modo server en el compose" || bad "switch → modo server en el compose"
grep -q 'DILUXITE_ADMIN_PASSWORD: ""' "${C11}" && ok "switch → password SCRUBBEADO (sin plaintext en compose)" || bad "switch → password NO scrubbeado"
has "$(cat "${DOCKER_MOCK_LOG}")" "UPDATE users SET email='admin@x.com'" "switch → promueve local@diluxite → admin"
rm -rf "${H11}"

echo "[12] Backup: el tarball incluye db.sql + manifest + compose + state"
H12="$(mktemp -d)"
run "${H12}" '2\n1\n\n\n3\n1\nn\n1\n'          # install
run "${H12}" '' --backup
CONT="$(tar -tzf "$(ls -t "${H12}"/diluxite/backups/*.tar.gz | head -1)" 2>/dev/null)"
has "${CONT}" "db.sql"                          "backup → incluye db.sql"
has "${CONT}" "manifest.json"                   "backup → incluye manifest"
has "${CONT}" "docker-compose.yml"              "backup → incluye compose"
has "${CONT}" ".diluxite-install.env"           "backup → incluye state"
rm -rf "${H12}"

echo "[13] Restore de backup con Ollama: el instalador SETEA el embedder (no avisa)"
H13="$(mktemp -d)"
run "${H13}" '2\n1\n\n\n1\n1\nn\n1\n'           # install con embedder=1 (ollama)
isfile "${H13}/diluxite/docker-compose.yml"     "install (ollama) → ok"
run "${H13}" '' --backup
BK13="$(ls -t "${H13}"/diluxite/backups/*.tar.gz | head -1)"
H13B="$(mktemp -d)"
run "${H13B}" "2\n2\n${BK13}\n"                  # restore desde el fork
has   "$(cat "${OLLAMA_MOCK_LOG}")" "ollama pull" "restore (ollama) → pullea el modelo (lo prepara, no avisa)"
isfile "${H13B}/diluxite/docker-compose.yml"    "restore (ollama) → reconstruye"
rm -rf "${H13}" "${H13B}"

echo "[14] Reconfigure → cambiar canal (local)"
HL="$(mktemp -d)"
run "${HL}" '2\n1\n\n\n3\n1\nn\n1\n'           # install local (det, auto-update off)
run "${HL}" '2\n2\n1\n1\n0\n\n0\n'             # menú→2 recon→1 canal→1 estable→0 back→cont→0
has "$(cat "${HL}/diluxite/.diluxite-install.env")" 'DLX_CHANNEL="1"' "reconfigure → canal a estable (1) en state"

echo "[15] Reconfigure → toggle auto-update ON"
run "${HL}" '2\n2\n2\ny\n0\n\n0\n'
has "$(cat "${HL}/diluxite/.diluxite-install.env")" 'DLX_AUTOUPDATE="1"' "reconfigure → auto-update ON en state"
WT="$(grep -c 'profiles: \["autoupdate"\]' "${HL}/diluxite/docker-compose.yml")"
[ "${WT}" = "0" ] && ok "auto-update ON → watchtower SIN profile" || bad "auto-update ON → watchtower con profile (mal)"

echo "[16] Reconfigure → HTTPS / dominio (Caddy)"
run "${HL}" '2\n2\n3\ndiluxite.test.com\na@b.com\n0\n\n0\n'
isfile "${HL}/diluxite/Caddyfile" "reconfigure HTTPS → crea Caddyfile"
has "$(cat "${HL}/diluxite/Caddyfile")" "diluxite.test.com" "reconfigure HTTPS → dominio en Caddyfile"
has "$(cat "${HL}/diluxite/docker-compose.yml")" "expose:" "reconfigure HTTPS → compose usa expose"

echo "[17] Reconfigure → embedder a Ollama (dim warn + prepara Ollama)"
run "${HL}" '2\n2\n6\n1\n0\n\n0\n'
has "${OUT}" "1536 → 1024" "reconfigure embedder → avisa cambio de dimensión"
has "$(cat "${OLLAMA_MOCK_LOG}")" "ollama pull" "reconfigure embedder→ollama → prepara el embedder (pull)"
rm -rf "${HL}"

echo "[18] Server: install + reconfigure OIDC + trusted-header"
HS="$(mktemp -d)"
run "${HS}" '2\n1\n\n\n3\n1\nn\n2\nadmin@x.com\nSecretpass1\nSecretpass1\n\nN\nN\n'
grep -q 'DILUXITE_AUTH_MODE: "server"' "${HS}/diluxite/docker-compose.yml" && ok "install server → modo server" || bad "install server → modo server"
run "${HS}" '2\n2\n4\nhttps://idp.test/\ncid\nsec\n\n0\n\n0\n'
grep -q 'DILUXITE_OIDC_ISSUER: "https://idp.test/"' "${HS}/diluxite/docker-compose.yml" && ok "reconfigure OIDC → en compose" || bad "reconfigure OIDC"
run "${HS}" '2\n2\n5\nX-My-Email\n0\n\n0\n'
grep -q 'DILUXITE_TRUSTED_IDENTITY_HEADER: "X-My-Email"' "${HS}/diluxite/docker-compose.yml" && ok "reconfigure trusted-header → en compose" || bad "reconfigure trusted-header"

echo "[19] Server: reset-admin (break-glass)"
run "${HS}" 'Secretpass2\nSecretpass2\n' --reset-admin
has "$(cat "${DOCKER_MOCK_LOG}")" "password_hash=NULL" "reset-admin → limpia el hash para re-aplicar"

echo "[20] Server → local"
run "${HS}" '2\n2\n8\ny\n0\n\n0\n'
grep -q 'DILUXITE_AUTH_MODE: "local"' "${HS}/diluxite/docker-compose.yml" && ok "server→local → modo local en compose" || bad "server→local"
rm -rf "${HS}"

echo "[21] Cloudflare Access: switch local→server (submodo CF) setea el env"
HC="$(mktemp -d)"
run "${HC}" '2\n1\n\n\n3\n1\nn\n1\n'           # install local
run "${HC}" '2\n2\n8\nadmin@x.com\n1\nmyteam.cloudflareaccess.com\naud-xyz\nn\n0\n\n0\n'
grep -q 'DILUXITE_CF_ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com"' "${HC}/diluxite/docker-compose.yml" && ok "switch→CF → team domain en compose" || bad "CF team domain"
grep -q 'DILUXITE_CF_ACCESS_AUD: "aud-xyz"' "${HC}/diluxite/docker-compose.yml" && ok "switch→CF → AUD en compose" || bad "CF aud"
rm -rf "${HC}"

echo "[22] Install nuevo sobre data EXISTENTE → avisa (reusar / empezar de cero)"
HE="$(mktemp -d)"; mkdir -p "${HE}/diluxite/data/postgres"; echo "16" > "${HE}/diluxite/data/postgres/PG_VERSION"
# lang · fork=1(instalar) · datapath="" · DATA EXISTE→2(borrar) · installpath="" · emb3 · seed1 · autoupd n · modo1
run "${HE}" '2\n1\n\n2\n\n3\n1\nn\n1\n'
has "${OUT}" "Ya hay una base de datos"          "install sobre data existente → avisa"
nofile "${HE}/diluxite/data/postgres/PG_VERSION" "elegir 'empezar de cero' → borra la DB vieja"
isfile "${HE}/diluxite/docker-compose.yml"       "install sobre data existente → igual instala"
rm -rf "${HE}"

echo "[23] Seed de datos de prueba desde el menú (workspace + count + space id)"
HSD="$(mktemp -d)"
run "${HSD}" '2\n1\n\n\n3\n1\nn\n1\n'           # install local
# menú→7 seed · (1 space → sin pick) · count="" (1500) · confirmar y · cont · 0
run "${HSD}" '2\n7\n\ny\n\n0\n'
has "${OUT}" "Seed de datos de prueba"           "menú → entra al seed"
has "$(cat "${DOCKER_MOCK_LOG}")" "DILUXITE_SEED_SPACE_ID=sp-1" "seed → pasa el space id elegido"
has "$(cat "${DOCKER_MOCK_LOG}")" "pnpm seed"    "seed → corre el seed dentro del container"
rm -rf "${HSD}"

echo ""
echo "== Resultado: ${PASS} PASS / ${FAIL} FAIL =="
[ "${FAIL}" -eq 0 ]
