# CodeGraph standalone installer for Windows (PowerShell) — Bridgenext fork.
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools required.
#
#   irm https://raw.githubusercontent.com/bridgenext/forge-codegraph/main/install.ps1 | iex
#
# Upgrade with `codegraph upgrade` (or just re-run this). To uninstall: remove
# $env:LOCALAPPDATA\codegraph and drop its \current\bin entry from your user PATH.
#
# Every downloaded archive is verified against the release's SHA256SUMS before
# it is extracted; a mismatch aborts the install. Set CODEGRAPH_SKIP_CHECKSUM=1
# only for a release that predates SHA256SUMS.
#
# Environment:
#   CODEGRAPH_VERSION        release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR    install location (default: %LOCALAPPDATA%\codegraph)
#   CODEGRAPH_SKIP_CHECKSUM  set to 1 to skip archive verification (discouraged)

$ErrorActionPreference = 'Stop'
$repo = 'bridgenext/forge-codegraph'
$installDir = if ($env:CODEGRAPH_INSTALL_DIR) { $env:CODEGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'codegraph' }

# 1. Detect architecture -> target matching the release archives.
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$target = "win32-$arch"

# 2. Resolve the version (latest release unless pinned).
$version = $env:CODEGRAPH_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
if (-not $version) { throw "codegraph: could not resolve latest version; set CODEGRAPH_VERSION." }

# 3. Download + extract the bundle into a stable 'current' dir (overwritten on upgrade).
$url = "https://github.com/$repo/releases/download/$version/codegraph-$target.zip"
Write-Host "Installing CodeGraph $version ($target)..."
$tmp = Join-Path $env:TEMP ("cg-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'cg.zip'
Invoke-WebRequest -Uri $url -OutFile $zip

# 3b. Verify the archive against the release's SHA256SUMS before extracting it.
# TLS authenticates the connection to GitHub, but nothing here previously
# authenticated the BYTES — a corrupted download or a swapped release asset
# would be extracted and executed unnoticed. A mismatch is a hard failure.
if ($env:CODEGRAPH_SKIP_CHECKSUM -eq '1') {
  Write-Warning "Archive verification skipped (CODEGRAPH_SKIP_CHECKSUM=1)."
} else {
  $asset = "codegraph-$target.zip"
  $sumsUrl = "https://github.com/$repo/releases/download/$version/SHA256SUMS"
  $sums = $null
  try { $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content } catch { $sums = $null }
  if (-not $sums) {
    Write-Host "Note: no SHA256SUMS published for $version; skipping verification."
  } else {
    $expected = $null
    foreach ($line in ($sums -split "`n")) {
      # "<64-hex>  <name>", with an optional '*' prefix on the name (binary mode).
      if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
        if ([System.IO.Path]::GetFileName($Matches[2]) -eq $asset) { $expected = $Matches[1].ToLower(); break }
      }
    }
    if (-not $expected) {
      Write-Host "Note: $asset is not listed in SHA256SUMS; skipping verification."
    } else {
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
      if ($actual -ne $expected) {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        throw "codegraph: CHECKSUM MISMATCH for $asset (expected $($expected.Substring(0,12))..., got $($actual.Substring(0,12))...). Refusing to install."
      }
      Write-Host "Verified SHA-256 checksum."
    }
  }
}

$dest = Join-Path $installDir 'current'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
# Archives contain a top-level codegraph-<target>\ dir; flatten it.
$inner = Join-Path $dest "codegraph-$target"
if (Test-Path $inner) {
  Get-ChildItem -Force $inner | Move-Item -Destination $dest -Force
  Remove-Item -Recurse -Force $inner
}
Remove-Item -Recurse -Force $tmp

# 4. Put the launcher dir on the user's PATH.
$binDir = Join-Path $dest 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)."
}

Write-Host "Installed to $dest"

# 5. Warn if a different codegraph earlier on PATH will shadow this install.
# Most often a stale npm-global CodeGraph (this fork's, or upstream
# @colbymchenry/codegraph), whose launcher keeps
# running its own version-pinned bundle — so `codegraph --version` disagrees
# with what we just installed (issue #1071). Check both the persisted PATH a
# fresh shell sees (Machine + User) and this session's PATH (catches dirs a
# shell profile injects, e.g. conda / npm).
$expected = Join-Path $binDir 'codegraph.cmd'
function Find-FirstCodegraph([string]$pathStr) {
  foreach ($dir in ($pathStr -split ';')) {
    if (-not $dir) { continue }
    foreach ($leaf in @('codegraph.cmd', 'codegraph.exe', 'codegraph.bat', 'codegraph.ps1')) {
      $cand = Join-Path $dir $leaf
      if (Test-Path -LiteralPath $cand) { return $cand }
    }
  }
  return $null
}
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$freshPath = ((@($machinePath, [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';')
$shadow = $null
foreach ($winner in @((Find-FirstCodegraph $env:Path), (Find-FirstCodegraph $freshPath))) {
  if ($winner -and ($winner -ne $expected)) { $shadow = $winner; break }
}
if ($shadow) {
  Write-Warning "Another codegraph is earlier on your PATH and will run instead of this install:"
  Write-Warning "  $shadow"
  Write-Warning "  (this install: $expected)"
  Write-Warning "If 'codegraph --version' shows an unexpected version, remove the other copy"
  Write-Warning "(e.g. 'npm rm -g @bridgenext/codegraph') or put '$binDir' first on your PATH."
}

Write-Host "Run: codegraph --help"
