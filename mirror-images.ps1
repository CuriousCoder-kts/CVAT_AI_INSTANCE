# ============================================================
# CVAT Offline Image Mirror (Windows PowerShell 5.x, pure ASCII)
#
# Pulls all required Docker images for CVAT (custom build base +
# runtime services + Nuclio function), then saves them into
# 2 tarballs that can be `docker load`-ed on an offline server.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\mirror-images.ps1 `
#       [-OutputDir D:\cvat-develop\deploy-out] [-SkipPull]
#
#   -SkipPull: assume all images are already pulled locally; only save.
# ============================================================

param(
    [string]$OutputDir = "D:\cvat-develop\deploy-out",
    [switch]$SkipPull
)

$ErrorActionPreference = "Stop"

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CVAT Offline Image Mirror" -ForegroundColor Cyan
Write-Host " Output : $OutputDir" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ---------- Prereq: docker ----------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker CLI not found in PATH. Install Docker Desktop first."
}

# ---------- Image lists ----------
# Group 1: Build base images (used during `docker compose build cvat_server/cvat_ui`
#          and Nuclio qwen37-detector baseImage)
$BUILD_BASE_IMAGES = @(
    "ubuntu:24.04",
    "golang:1.26.5",
    "node:lts-slim",
    "nginxinc/nginx-unprivileged:1.31.2-alpine3.23-slim",
    "ubuntu:22.04"
)

# Group 2: Runtime service images (images referenced directly in compose files)
$SERVICE_IMAGES = @(
    "postgres:15-alpine",
    "redis:7.2.11-alpine",
    "apache/kvrocks:2.15.0",
    "traefik:v3.6",
    "openpolicyagent/opa:1.12.2",
    "clickhouse/clickhouse-server:23.11-alpine",
    "timberio/vector:0.26.0-alpine",
    "grafana/grafana-oss:10.1.2",
    "quay.io/nuclio/dashboard:1.16.3-amd64"
)

$ALL_IMAGES = $BUILD_BASE_IMAGES + $SERVICE_IMAGES

# ---------- Helper: LF text writer ----------
function Write-TextFileLF($Path, [string]$Content) {
    $lf = $Content.Replace("`r`n", "`n")
    if (-not $lf.EndsWith("`n")) { $lf += "`n" }
    [System.IO.File]::WriteAllText($Path, $lf, [System.Text.Encoding]::ASCII)
}

# ---------- Helper: gzip a tar using .NET (gzip.exe may not be in PATH) ----------
function Compress-GzipFile($TarPath, $GzPath) {
    if (Test-Path $GzPath) { Remove-Item $GzPath -Force -ErrorAction SilentlyContinue }
    if (Get-Command gzip -ErrorAction SilentlyContinue) {
        & gzip -f $TarPath
        if ($LASTEXITCODE -ne 0) { throw "gzip failed (exit=$LASTEXITCODE)" }
        return
    }
    Write-Host "  gzip not in PATH; using .NET GZipStream ..." -ForegroundColor Yellow
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $in  = $null; $out = $null; $gz = $null
    try {
        $in  = [System.IO.File]::OpenRead($TarPath)
        $out = [System.IO.File]::Create($GzPath)
        $gz  = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Optimal)
        $in.CopyTo($gz)
    } finally {
        if ($gz)  { $gz.Dispose()  }
        if ($out) { $out.Dispose() }
        if ($in)  { $in.Dispose()  }
    }
    $fi = Get-Item $GzPath
    if ($fi.Length -lt 1KB) {
        throw "GZipStream produced suspiciously small output ($($fi.Length) bytes)."
    }
    # magic bytes check
    $magic = New-Object byte[] 2
    $fs = [System.IO.File]::OpenRead($GzPath)
    try { [void]$fs.Read($magic, 0, 2) } finally { $fs.Dispose() }
    if ($magic[0] -ne 0x1F -or $magic[1] -ne 0x8B) {
        throw "Gzip output missing magic bytes."
    }
    Remove-Item $TarPath -Force -ErrorAction SilentlyContinue
}

# ---------- Step 1: Pull images ----------
if (-not $SkipPull) {
    Write-Host "`n[1/5] Pulling $($ALL_IMAGES.Count) images ..." -ForegroundColor Yellow
    $idx = 0
    foreach ($img in $ALL_IMAGES) {
        $idx++
        Write-Host "  [$idx/$($ALL_IMAGES.Count)] docker pull $img" -ForegroundColor Cyan
        & docker pull $img 2>&1 | Select-Object -Last 3
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "  Pull failed for $img. Will re-check before save; if image already exists locally, ignore this warning."
        }
    }
    Write-Host "  Pull step complete." -ForegroundColor Green
} else {
    Write-Host "`n[1/5] -SkipPull enabled; skipping docker pull." -ForegroundColor Yellow
}

# ---------- Step 2: Verify ALL images present locally ----------
Write-Host "`n[2/5] Verifying all $($ALL_IMAGES.Count) images exist locally ..." -ForegroundColor Yellow
$MISSING = New-Object System.Collections.Generic.List[string]
foreach ($img in $ALL_IMAGES) {
    $inspect = & docker image inspect $img 2>&1
    if ($LASTEXITCODE -ne 0) {
        [void]$MISSING.Add($img)
        Write-Host "  MISSING: $img" -ForegroundColor Red
    } else {
        Write-Host "  OK:      $img" -ForegroundColor Green
    }
}
if ($MISSING.Count -gt 0) {
    throw "The following $($MISSING.Count) images are missing locally. Re-run without -SkipPull to pull them first. Missing: $($MISSING -join ', ')"
}

# ---------- Step 3: Save tarballs ----------
Write-Host "`n[3/5] Saving tarballs (uncompressed) ..." -ForegroundColor Yellow

$TarBase = Join-Path $OutputDir "cvat-images-01-build-base-$Timestamp.tar"
$TarSvc  = Join-Path $OutputDir "cvat-images-02-services-$Timestamp.tar"
$GzBase  = "$TarBase.gz"
$GzSvc   = "$TarSvc.gz"

foreach ($old in @($TarBase,$TarSvc,$GzBase,$GzSvc)) {
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
}

# 3a) Build-base images
Write-Host "  docker save -> $(Split-Path $TarBase -Leaf) ($($BUILD_BASE_IMAGES.Count) images)" -ForegroundColor Cyan
$argsSave1 = @("save", "-o", $TarBase) + $BUILD_BASE_IMAGES
& docker @argsSave1 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "docker save (build-base) failed (exit=$LASTEXITCODE)" }
Write-Host "    Size: $([math]::Round((Get-Item $TarBase).Length / 1MB, 2)) MB" -ForegroundColor Green

# 3b) Service images
Write-Host "  docker save -> $(Split-Path $TarSvc -Leaf) ($($SERVICE_IMAGES.Count) images)" -ForegroundColor Cyan
$argsSave2 = @("save", "-o", $TarSvc) + $SERVICE_IMAGES
& docker @argsSave2 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "docker save (services) failed (exit=$LASTEXITCODE)" }
Write-Host "    Size: $([math]::Round((Get-Item $TarSvc).Length / 1MB, 2)) MB" -ForegroundColor Green

# ---------- Step 4: Gzip compress ----------
Write-Host "`n[4/5] Gzip compressing tarballs ..." -ForegroundColor Yellow
Write-Host "  $(Split-Path $TarBase -Leaf) -> $(Split-Path $GzBase -Leaf)" -ForegroundColor Cyan
Compress-GzipFile $TarBase $GzBase
Write-Host "    OK: $([math]::Round((Get-Item $GzBase).Length / 1MB, 2)) MB" -ForegroundColor Green

Write-Host "  $(Split-Path $TarSvc -Leaf) -> $(Split-Path $GzSvc -Leaf)" -ForegroundColor Cyan
Compress-GzipFile $TarSvc  $GzSvc
Write-Host "    OK: $([math]::Round((Get-Item $GzSvc).Length / 1MB, 2)) MB" -ForegroundColor Green

# ---------- Step 5: Manifest + SHA256 ----------
Write-Host "`n[5/5] Writing manifest and SHA256 ..." -ForegroundColor Yellow

$GzBaseLeaf = Split-Path $GzBase -Leaf
$GzSvcLeaf  = Split-Path $GzSvc  -Leaf

$manifest = @"
CVAT Offline Image Set
======================
Generated at  : $Timestamp
Mode          : $(if ($SkipPull) { "skip-pull (use local cache)" } else { "fresh pull" })
Total images  : $($ALL_IMAGES.Count)

=== Part 1: Build base (5 images) - load BEFORE docker compose build ===
  1. ubuntu:24.04
  2. golang:1.26.5
  3. node:lts-slim
  4. nginxinc/nginx-unprivileged:1.31.2-alpine3.23-slim
  5. ubuntu:22.04 (Nuclio qwen37-detector)
  -> File: $GzBaseLeaf

=== Part 2: Runtime services (9 images) - load BEFORE docker compose up ===
  1. postgres:15-alpine
  2. redis:7.2.11-alpine
  3. apache/kvrocks:2.15.0
  4. traefik:v3.6
  5. openpolicyagent/opa:1.12.2
  6. clickhouse/clickhouse-server:23.11-alpine
  7. timberio/vector:0.26.0-alpine
  8. grafana/grafana-oss:10.1.2
  9. quay.io/nuclio/dashboard:1.16.3-amd64
  -> File: $GzSvcLeaf

=== Server-side usage ===
  # 1) scp both .tar.gz + sha256 files to /tmp/cvat-images/ on the server
  # 2) sudo mkdir -p /tmp/cvat-images && cd /tmp/cvat-images
  # 3) sha256sum -c cvat-images-01-build-base-*.tar.gz.sha256
  #    sha256sum -c cvat-images-02-services-*.tar.gz.sha256
  # 4) for t in *.tar.gz; do echo ">> loading \$t ..."; docker load -i \$t; done
  #    (alternatively: gunzip -c \$t | docker load)
  # 5) Verify: docker image inspect ubuntu:24.04 cvat/ui:dev  (dev tags will be built locally)
  # 6) Proceed with deploy-cvat.sh or manual docker compose build/up
"@
Write-TextFileLF (Join-Path $OutputDir "cvat-images-$Timestamp.MANIFEST.txt") $manifest

function Write-ShaFile($GzPath) {
    $hash = (Get-FileHash -Path $GzPath -Algorithm SHA256).Hash.ToLower()
    $shaPath = "$GzPath.sha256"
    $content = "$hash  " + (Split-Path $GzPath -Leaf) + "`n"
    [System.IO.File]::WriteAllText($shaPath, $content, [System.Text.Encoding]::ASCII)
    Write-Host "  $(Split-Path $shaPath -Leaf): $hash" -ForegroundColor Green
    return $shaPath
}

$shaBase = Write-ShaFile $GzBase
$shaSvc  = Write-ShaFile $GzSvc

# ---------- Done ----------
# Collect final output files as plain path strings first, then Get-Item one by one.
# (PS5 doesn't support passing an array as positional arg 0 to Get-Item.)
$manifestPath = Join-Path $OutputDir "cvat-images-$Timestamp.MANIFEST.txt"
$finalItemPaths = @(
    $GzBase,
    $GzSvc,
    $shaBase,
    $shaSvc,
    $manifestPath
)
$finalItems = @()
foreach ($p in $finalItemPaths) {
    if (Test-Path -LiteralPath $p) {
        $finalItems += Get-Item -LiteralPath $p
    } else {
        Write-Warning "Expected output missing: $p"
    }
}
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Offline image set ready!" -ForegroundColor Green
foreach ($fi in $finalItems) {
    $szMB = if ($fi.Extension -ne ".txt" -and $fi.Extension -ne ".sha256") {
                " ($([math]::Round($fi.Length / 1MB, 2)) MB)" } else { "" }
    Write-Host "  $($fi.Name)$szMB"
}
Write-Host "========================================" -ForegroundColor Cyan

$scpTip = @"

=== Suggested SCP commands ===
REM Transfer to server:
scp "$($finalItems[0].FullName)" user@server:/tmp/cvat-images/
scp "$($finalItems[1].FullName)" user@server:/tmp/cvat-images/
scp "$($finalItems[2].FullName)" user@server:/tmp/cvat-images/
scp "$($finalItems[3].FullName)" user@server:/tmp/cvat-images/

REM Server side (after scp):
ssh user@server
sudo mkdir -p /tmp/cvat-images
cd /tmp/cvat-images
sha256sum -c $($finalItems[2].Name)
sha256sum -c $($finalItems[3].Name)
for t in *.tar.gz; do echo ">> loading `$t"; gunzip -c "`$t" | docker load; done
"@
Write-Host $scpTip -ForegroundColor Yellow
