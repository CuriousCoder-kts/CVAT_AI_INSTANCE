# ============================================================
# CVAT Deploy Packager (Windows PowerShell 5.x compatible, pure ASCII)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-deploy.ps1 [-OutputDir D:\] [-SkipGitExclude]
# ============================================================

param(
    [string]$OutputDir = "D:\",
    [switch]$SkipGitExclude
)

$ErrorActionPreference = "Stop"

# Get project root (directory where THIS script lives)
$ScriptPath = $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptPath
if ([string]::IsNullOrEmpty($ProjectRoot)) {
    $ProjectRoot = Get-Location
}

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$TarName = "cvat-deploy-$Timestamp.tar"
$GzName  = "$TarName.gz"
$TarPath = Join-Path $OutputDir $TarName
$GzPath  = Join-Path $OutputDir $GzName

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " CVAT Deploy Packager" -ForegroundColor Cyan
Write-Host " Project : $ProjectRoot" -ForegroundColor Cyan
Write-Host " Output  : $GzPath" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ---------- 1. Prerequisites ----------
Write-Host "`n[1/6] Checking prerequisites ..." -ForegroundColor Yellow

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    throw "tar command not found. Install Git for Windows (ships tar.exe in usr\bin\) or GNU Tar for Windows."
}

# Build required file list (simple strings, no Join-Path inside @() to avoid PS5 parser issues)
$req1 = Join-Path $ProjectRoot "docker-compose.yml"
$req2 = Join-Path $ProjectRoot ".env.example"
$req3 = Join-Path $ProjectRoot "docker-compose.override.yml.example"
$req4 = Join-Path $ProjectRoot "Dockerfile"
$req5 = Join-Path $ProjectRoot "Dockerfile.ui"
$req6 = Join-Path $ProjectRoot "serverless\qwen\bailian\qwen37-detector\nuclio\function.yaml"
$req7 = Join-Path $ProjectRoot "serverless\qwen\bailian\qwen37-detector\nuclio\main.py"
$req8 = Join-Path $ProjectRoot "cvat\apps\organizations\migrations\0003_bailiansettings.py"
$req9 = Join-Path $ProjectRoot "deploy-cvat.sh"

$RequiredPairs = @(
    @("docker-compose.yml",                          $req1),
    @(".env.example",                                 $req2),
    @("docker-compose.override.yml.example",          $req3),
    @("Dockerfile",                                   $req4),
    @("Dockerfile.ui",                                $req5),
    @("serverless/.../function.yaml",                 $req6),
    @("serverless/.../main.py",                       $req7),
    @("organizations/migrations/0003_bailiansettings.py", $req8),
    @("deploy-cvat.sh",                               $req9)
)
foreach ($pair in $RequiredPairs) {
    if (-not (Test-Path $pair[1])) {
        throw "Missing required file: $($pair[0])  (full path: $($pair[1]))"
    }
}
Write-Host "  OK - all required files present" -ForegroundColor Green

# ---------- 2. Decide collection strategy ----------
Write-Host "`n[2/6] Deciding file-collection strategy ..." -ForegroundColor Yellow

$UseGitWhitelist = $false
$GitTrackedFiles = $null
if (-not $SkipGitExclude -and (Get-Command git -ErrorAction SilentlyContinue)) {
    Push-Location $ProjectRoot
    try {
        $gitOut = git -c core.quotepath=false ls-files 2>$null
        if ($LASTEXITCODE -eq 0 -and $gitOut -and $gitOut.Count -gt 50) {
            $GitTrackedFiles = @($gitOut)
            $UseGitWhitelist = $true
            Write-Host "  Using git ls-files whitelist: $($GitTrackedFiles.Count) tracked files" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
}
if (-not $UseGitWhitelist) {
    Write-Host "  Using manual exclusion pattern list" -ForegroundColor Green
}

# ---------- 3. Collect files ----------
Write-Host "`n[3/6] Collecting files ..." -ForegroundColor Yellow

Push-Location $ProjectRoot
try {
    if ($UseGitWhitelist) {
        $AllFiles = New-Object System.Collections.Generic.List[string]

        # (A) tracked files
        foreach ($f in $GitTrackedFiles) {
            if (Test-Path -LiteralPath $f) {
                [void]$AllFiles.Add($f)
            }
        }

        # (B) untracked files under serverless/qwen/ (new custom Nuclio function)
        Get-ChildItem "serverless\qwen" -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            $rel = $_.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/')
            if (-not $AllFiles.Contains($rel)) {
                [void]$AllFiles.Add($rel)
            }
        }

        # (C) DEPLOY_CHECKLIST.md and deploy-cvat.sh (they may not be tracked yet if freshly added)
        foreach ($extra in @("DEPLOY_CHECKLIST.md", "deploy-cvat.sh", "pack-deploy.ps1")) {
            if ((Test-Path -LiteralPath $extra) -and (-not $AllFiles.Contains($extra))) {
                [void]$AllFiles.Add($extra)
            }
        }

        Write-Host "  Total collected: $($AllFiles.Count) files (git whitelist + extras)" -ForegroundColor Green
    }
    else {
        # Exclusion patterns (prefix-match, normalized to forward-slash)
        $ExcludePrefixes = @(
            ".git/",
            ".github/",
            ".vscode/",
            ".idea/",
            "node_modules/",
            ".yarn/cache/",
            ".yarn/install-state.gz",
            ".venv/",
            "venv/",
            "__pycache__/",
            ".pytest_cache/",
            ".mypy_cache/",
            ".ruff_cache/",
            ".eslintcache",
            ".stylelintcache",
            ".parcel-cache/",
            ".next/",
            ".nuxt/",
            ".serverless/",
            ".docker-data/",
            ".docker-volumes/",
            "volumes/",
            "dist/",
            "build/",
            "out/",
            "site/public/",
            "site/resources/",
            "cvat-core/dist/",
            "cvat-canvas/dist/",
            "cvat-canvas3d/dist/",
            "cvat-data/dist/",
            "cvat-ui/dist/",
            "cvat-sdk/dist/",
            "cvat-cli/dist/",
            "cvat-cli/build/",
            "cvat-sdk/build/",
            "cvat/data/",
            "data/",
            "media/",
            "django_static/",
            "tests/cypress/videos/",
            "tests/cypress/screenshots/",
            "helm-chart/tmp/",
            "secrets/"
        )
        $ExcludeNames = @(
            ".env",
            ".env.local",
            "docker-compose.override.yml",
            ".DS_Store",
            "Thumbs.db",
            "ehthumbs.db",
            "desktop.ini",
            "credentials.json",
            "service_account.json"
        )
        $ExcludeSuffixes = @(
            ".pem",
            ".key",
            ".crt",
            ".log",
            ".pyc",
            ".pyo",
            ".tar",
            ".tar.gz",
            ".zip",
            ".7z",
            ".rar"
        )

        $AllFiles = New-Object System.Collections.Generic.List[string]
        Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            $rel = $_.FullName.Substring($ProjectRoot.Length + 1).Replace('\', '/')
            $name = $_.Name

            # Skip output of previous packaging runs regardless of location
            if ($rel -match '^cvat-deploy-\d{8}-\d{6}\.tar') { return }

            # Prefix skip
            foreach ($p in $ExcludePrefixes) {
                if ($rel.StartsWith($p, [System.StringComparison]::Ordinal)) { return }
            }
            # Name skip
            if ($ExcludeNames -contains $name) { return }
            # Suffix skip
            foreach ($s in $ExcludeSuffixes) {
                if ($name.EndsWith($s, [System.StringComparison]::OrdinalIgnoreCase)) { return }
            }
            [void]$AllFiles.Add($rel)
        }
        Write-Host "  Total collected: $($AllFiles.Count) files (manual exclusion)" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

if ($AllFiles.Count -lt 200) {
    throw "Too few files collected: $($AllFiles.Count). Rerun with -SkipGitExclude to use manual exclusion list."
}

# ---------- 4. Write manifest ----------
Write-Host "`n[4/6] Writing DEPLOY_MANIFEST.txt ..." -ForegroundColor Yellow

$ManifestPath = Join-Path $ProjectRoot "DEPLOY_MANIFEST.txt"
$manifestContent = @"
CVAT Deployment Package
=======================
Packaged at      : $Timestamp
Packaged from    : $ProjectRoot
Package mode     : $(if ($UseGitWhitelist) { "git-whitelist" } else { "exclude-patterns" })
Files in package : $($AllFiles.Count)
Packager script  : pack-deploy.ps1
Deploy script    : deploy-cvat.sh
Checklist doc    : DEPLOY_CHECKLIST.md

Key customizations included:
  - BailianSettings DB model + migration (organizations/0003_bailiansettings.py)
  - lambda_manager: bailian-config auto-inject + nuclio container-DNS fallback
    (cvat/apps/lambda_manager/views.py)
  - cvat-core: BailianSettings SDK class + serverProxy organizations.bailianSettings
    (cvat-core/src/organization.ts, cvat-core/src/server-proxy.ts)
  - cvat-ui: /organization/bailian page + Organization menu entry
    (cvat-ui/src/components/organization-bailian-page/*, cvat-app.tsx, header.tsx)
  - Nuclio function: serverless/qwen/bailian/qwen37-detector/ (9 traffic classes,
    function.yaml + main.py with prompt-engineering + JSON repair + NMS)
  - Deployment templates: .env.example + docker-compose.override.yml.example

Server-side deployment (quick steps):
  1. tar -xzf cvat-deploy-*.tar.gz -C ~/cvat-develop
  2. cd ~/cvat-develop
  3. cp .env.example .env  &&  nano .env    (set CVAT_HOST + proxy/no_proxy if needed)
  4. sudo bash deploy-cvat.sh
  5. Open http://CVAT_HOST:8080  ->  Organization -> Bailian settings
     -> fill API Key / URL / Model -> Save
"@
# Write manifest with LF-only line endings (so Linux tools don't choke on ^M)
$manifestLF = $manifestContent.Replace("`r`n", "`n")
if (-not $manifestLF.EndsWith("`n")) { $manifestLF += "`n" }
[System.IO.File]::WriteAllText($ManifestPath, $manifestLF, [System.Text.Encoding]::ASCII)

# Add manifest to the list if not present
$manifestRel = "DEPLOY_MANIFEST.txt"
if (-not $AllFiles.Contains($manifestRel)) {
    [void]$AllFiles.Add($manifestRel)
}
Write-Host "  Manifest created: $manifestRel" -ForegroundColor Green

# ---------- 5. Create tarball ----------
Write-Host "`n[5/6] Creating tar.gz archive (this may take a while) ..." -ForegroundColor Yellow

# Write file list (for tar --files-from)
$ListPath = Join-Path $env:TEMP "cvat-pack-$Timestamp.txt"
# Write file list for tar with LF-only line endings, UTF-8 no-BOM
$listSb = New-Object System.Text.StringBuilder
foreach ($f in $AllFiles) {
    [void]$listSb.Append($f).Append("`n")
}
[System.IO.File]::WriteAllText($ListPath, $listSb.ToString(), (New-Object System.Text.UTF8Encoding $false))

# Clean previous outputs if any
if (Test-Path $GzPath) { Remove-Item $GzPath -Force -ErrorAction SilentlyContinue }
if (Test-Path $TarPath) { Remove-Item $TarPath -Force -ErrorAction SilentlyContinue }

Push-Location $ProjectRoot
try {
    # Phase 1: tar uncompressed
    $tarArgs = @("--create", "--file", $TarPath, "--files-from", $ListPath, "--no-recursion")
    & tar @tarArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "tar create failed (exit=$LASTEXITCODE)"
    }
    if (-not (Test-Path $TarPath)) {
        throw "tar reported success but output file missing: $TarPath"
    }
    $TarSizeMb = [math]::Round((Get-Item $TarPath).Length / 1MB, 2)
    Write-Host "  tar created: $TarSizeMb MB" -ForegroundColor Green

    # Phase 2: gzip. IMPORTANT: do NOT delete $TarPath until $GzPath is VERIFIED non-empty
    if (Test-Path $GzPath) { Remove-Item $GzPath -Force -ErrorAction SilentlyContinue }

    $hasGzip = $false
    $gzipCmd = Get-Command gzip -ErrorAction SilentlyContinue
    if ($gzipCmd) { $hasGzip = $true }

    if ($hasGzip) {
        Write-Host "  Using external gzip: $($gzipCmd.Source)" -ForegroundColor Green
        & gzip -f $TarPath
        if ($LASTEXITCODE -ne 0) { throw "gzip failed (exit=$LASTEXITCODE)" }
        if (-not (Test-Path $GzPath)) { throw "gzip exited OK but .gz file missing: $GzPath" }
    } else {
        Write-Host "  gzip not in PATH; falling back to .NET GZipStream ..." -ForegroundColor Yellow
        Add-Type -AssemblyName System.IO.Compression.FileSystem

        $inStream  = $null
        $outStream = $null
        $gzip      = $null
        try {
            $inStream  = [System.IO.File]::OpenRead($TarPath)
            $outStream = [System.IO.File]::Create($GzPath)
            $gzip      = New-Object System.IO.Compression.GZipStream($outStream, [System.IO.Compression.CompressionLevel]::Optimal)
            $inStream.CopyTo($gzip)
        } finally {
            if ($gzip)      { $gzip.Dispose()      }
            if ($outStream) { $outStream.Dispose() }
            if ($inStream)  { $inStream.Dispose()  }
        }

        if (-not (Test-Path $GzPath)) {
            throw "GZipStream produced no output file: $GzPath"
        }
    }

    # Sanity check gz file: must be > 0 and roughly valid
    $gzInfo = Get-Item $GzPath
    if ($gzInfo.Length -lt 1KB) {
        throw "Gzip output suspiciously small ($($gzInfo.Length) bytes); aborting without deleting tar."
    }
    # gzip magic bytes: 1F 8B
    $magic = New-Object byte[] 2
    $fs = [System.IO.File]::OpenRead($GzPath)
    try {
        [void]$fs.Read($magic, 0, 2)
    } finally { $fs.Dispose() }
    if ($magic[0] -ne 0x1F -or $magic[1] -ne 0x8B) {
        throw "Gzip output has invalid magic bytes; not a valid gzip."
    }

    # Now it is safe to remove the uncompressed tar
    Remove-Item $TarPath -Force -ErrorAction SilentlyContinue
}
finally {
    Pop-Location
    Remove-Item $ListPath -Force -ErrorAction SilentlyContinue
}

$GzSizeMb = [math]::Round((Get-Item $GzPath).Length / 1MB, 2)
Write-Host "  tar.gz created: $GzSizeMb MB" -ForegroundColor Green

# ---------- 6. SHA-256 checksum ----------
Write-Host "`n[6/6] Computing SHA-256 checksum ..." -ForegroundColor Yellow
$hashObj = Get-FileHash -Path $GzPath -Algorithm SHA256
$sha = $hashObj.Hash.ToLower()
$ShaPath = "$GzPath.sha256"
$shaContent = "$sha  " + (Split-Path $GzPath -Leaf) + "`n"
[System.IO.File]::WriteAllText($ShaPath, $shaContent, [System.Text.Encoding]::ASCII)
Write-Host "  SHA256: $sha" -ForegroundColor Green

# ---------- Done ----------
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Packaging complete!" -ForegroundColor Green
Write-Host " Package : $GzPath  ($GzSizeMb MB)" -ForegroundColor Green
Write-Host " Checksum: $ShaPath" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`n=== Suggested next commands (copy to your terminal) ===" -ForegroundColor Yellow
$pkgLeaf = Split-Path $GzPath -Leaf
$shaLeaf = Split-Path $ShaPath -Leaf
Write-Host "  REM --- scp to server ---"
Write-Host "  scp ""$GzPath""  user@server:/tmp/"
Write-Host "  scp ""$ShaPath"" user@server:/tmp/"
Write-Host ""
Write-Host "  # --- on server (Linux) ---"
Write-Host "  ssh user@server"
Write-Host "  cd /tmp"
Write-Host "  sha256sum -c $shaLeaf"
Write-Host "  sudo mkdir -p ~/cvat-develop && sudo tar -xzf $pkgLeaf -C ~/cvat-develop"
Write-Host "  cd ~/cvat-develop"
Write-Host "  head DEPLOY_MANIFEST.txt"
Write-Host "  sudo bash deploy-cvat.sh"
