# ==============================================================================
# Diluxite Installer — Windows (PowerShell)
#
# Requires Docker Desktop (which brings Docker Engine + Compose v2) running.
# For Ollama embedder: Ollama for Windows installed.
#
# Usage:
#   .\install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1
# ==============================================================================
$ErrorActionPreference = "Stop"

function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info  { param($msg) Write-Host "  [->] $msg" -ForegroundColor Cyan }
function Write-Warn  { param($msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }
function Write-Title { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor White }

$RepoRaw = "https://raw.githubusercontent.com/soydiloreto/diluxite-core-alpha/main"
$DefaultVersion = if ($env:DILUXITE_VERSION) { $env:DILUXITE_VERSION } else { "latest" }

Write-Host ""
Write-Host "  Diluxite — Instalacion (Windows)" -ForegroundColor White
Write-Host "  La memoria de tu IA. Self-host. AGPL-3.0." -ForegroundColor DarkGray
Write-Host ""

# ── 1) Docker Desktop ─────────────────────────────────────────────────────────
Write-Title "1 / 6 - Pre-requisitos"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker Desktop no esta instalado."
    Write-Info "Descargalo en: https://www.docker.com/products/docker-desktop/"
    Write-Info "Instalalo, abri Docker Desktop, y volvé a ejecutar este script."
    exit 1
}

try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -ne 0) { throw "daemon down" }
} catch {
    Write-Err "Docker Desktop no esta corriendo."
    Write-Info "Abri Docker Desktop desde el menu inicio y espera que arranque."
    exit 1
}
Write-Ok "Docker: $(docker --version)"

try {
    $null = docker compose version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "no compose v2" }
} catch {
    Write-Err "Docker Compose v2 no esta disponible. Actualiza Docker Desktop."
    exit 1
}
Write-Ok "Docker Compose v2 disponible"

# Port availability
foreach ($port in 3030, 5173, 5432) {
    $busy = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($busy) {
        Write-Err "El puerto $port esta ocupado por otro proceso."
        Write-Info "Cerralo o cambia el mapping en docker-compose.yml despues."
        exit 1
    }
}
Write-Ok "Puertos 3030 / 5173 / 5432 libres"

$driveLetter = (Get-Item $PWD.Path).PSDrive.Name
$freeGB = [math]::Round((Get-PSDrive $driveLetter).Free / 1GB, 1)
if ($freeGB -lt 3) {
    Write-Err "Espacio libre insuficiente ($freeGB GB). Diluxite necesita al menos 3 GB."
    exit 1
}
Write-Ok "Espacio libre: $freeGB GB"

# ── 2) Data dir ───────────────────────────────────────────────────────────────
Write-Title "2 / 6 - Donde guardar los datos"

$defaultData = "$env:USERPROFILE\diluxite\data"
$inputData = Read-Host "Ruta para los datos [$defaultData]"
$DataPath = if ([string]::IsNullOrWhiteSpace($inputData)) { $defaultData } else { $inputData.Trim() }
New-Item -ItemType Directory -Path "$DataPath\postgres" -Force | Out-Null
Write-Ok "Datos en: $DataPath"

$defaultInstall = "$env:USERPROFILE\diluxite"
$inputInstall = Read-Host "Ruta de instalacion [$defaultInstall]"
$InstallDir = if ([string]::IsNullOrWhiteSpace($inputInstall)) { $defaultInstall } else { $inputInstall.Trim() }
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Write-Ok "Instalacion en: $InstallDir"

# ── 3) Embedder ───────────────────────────────────────────────────────────────
Write-Title "3 / 6 - Embeddings"

Write-Host "  1) Ollama local con mxbai-embed-large (RECOMENDADO)"
Write-Host "  2) Azure OpenAI"
Write-Host "  3) Deterministico local"
$embOpt = Read-Host "Opcion [1]"
if ([string]::IsNullOrWhiteSpace($embOpt)) { $embOpt = "1" }

$OllamaModel = ""
$OllamaDims = ""
$OllamaEndpoint = ""
$AzureEndpoint = ""
$AzureKey = ""
$AzureDeployment = ""

switch ($embOpt) {
    "1" {
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
            Write-Err "Ollama no esta instalado."
            Write-Info "Descargalo en: https://ollama.com/download"
            Write-Info "Despues, volvé a correr este installer."
            exit 1
        }
        Write-Ok "Ollama presente"
        Write-Info "Bajando mxbai-embed-large (~669 MB)..."
        ollama pull mxbai-embed-large:335m
        Write-Ok "Modelo descargado"
        $OllamaModel = "mxbai-embed-large:335m"
        $OllamaDims = "1024"
        # Docker Desktop on Windows exposes the host at host.docker.internal.
        $OllamaEndpoint = "http://host.docker.internal:11434"
    }
    "2" {
        $AzureEndpoint = Read-Host "Azure OpenAI endpoint (https://<recurso>.openai.azure.com)"
        $secure = Read-Host "Azure OpenAI API key" -AsSecureString
        $AzureKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        )
        $AzureDeployment = Read-Host "Deployment name [text-embedding-3-large]"
        if ([string]::IsNullOrWhiteSpace($AzureDeployment)) { $AzureDeployment = "text-embedding-3-large" }
        Write-Ok "Azure OpenAI configurado"
    }
    "3" {
        Write-Warn "Embedder deterministico: util para probar, baja calidad semantica."
    }
    default {
        Write-Err "Opcion invalida: $embOpt"; exit 1
    }
}

# ── 4) Seed ───────────────────────────────────────────────────────────────────
Write-Title "4 / 6 - Datos iniciales"
Write-Host "  1) Vault vacio"
Write-Host "  2) Seed demo (1500 notas tecnicas)"
$seedOpt = Read-Host "Opcion [1]"
if ([string]::IsNullOrWhiteSpace($seedOpt)) { $seedOpt = "1" }

# ── 5) Compose ────────────────────────────────────────────────────────────────
Write-Title "5 / 6 - Generando configuracion"
Write-Info "Pin a version: $DefaultVersion"

$templatePath = Join-Path $InstallDir "docker-compose.template.yml"
$composePath  = Join-Path $InstallDir "docker-compose.yml"

# Pull template from repo (or local copy if we are running from a clone).
$localTemplate = Join-Path $PSScriptRoot "docker-compose.template.yml"
if (Test-Path $localTemplate) {
    Copy-Item $localTemplate $templatePath -Force
} else {
    Invoke-WebRequest -UseBasicParsing -Uri "$RepoRaw/docker-compose.template.yml" -OutFile $templatePath
}

$content = Get-Content $templatePath -Raw
$content = $content.Replace("__DILUXITE_VERSION__", $DefaultVersion)
$content = $content.Replace("__DATA_PATH__", $DataPath.Replace("\", "/"))
$content = $content.Replace("__OLLAMA_MODEL__", $OllamaModel)
$content = $content.Replace("__OLLAMA_DIMS__", $OllamaDims)
$content = $content.Replace("__OLLAMA_ENDPOINT__", $OllamaEndpoint)
$content = $content.Replace("__AZURE_ENDPOINT__", $AzureEndpoint)
$content = $content.Replace("__AZURE_KEY__", $AzureKey)
$content = $content.Replace("__AZURE_DEPLOYMENT__", $AzureDeployment)

Set-Content -Path $composePath -Value $content -Encoding UTF8
Write-Ok "docker-compose.yml generado"

# ── 6) Up ─────────────────────────────────────────────────────────────────────
Write-Title "6 / 6 - Levantando Diluxite"

Set-Location $InstallDir
Write-Info "Pulleando imagenes desde Docker Hub..."
docker compose pull
Write-Info "Arrancando..."
docker compose up -d
Write-Ok "Containers en marcha"

Write-Info "Esperando que la API este healthy..."
$ready = $false
for ($i = 1; $i -le 60; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3030/health" -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Write-Err "API no respondio en 2 minutos. Logs: docker compose logs api"
    exit 1
}
Write-Ok "API saludable en http://localhost:3030"

if ($seedOpt -eq "2") {
    Write-Info "Cargando seed demo (1500 notas)..."
    docker compose exec -T api pnpm seed
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Title "Listo"
Write-Host "  Abri http://localhost:5173 para empezar." -ForegroundColor Green
Write-Host ""
Write-Host "  Comandos utiles (desde $InstallDir):"
Write-Host "    docker compose logs -f api"
Write-Host "    docker compose down"
Write-Host "    docker compose pull; docker compose up -d            # update manual"
Write-Host "    docker compose --profile autoupdate up -d             # Watchtower"
Write-Host ""
Write-Host "  Datos: $DataPath"
