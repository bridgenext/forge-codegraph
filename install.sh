#!/bin/sh
#
# CodeGraph standalone installer (Bridgenext fork).
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools, no npm required — ideal for a
# fresh Linux VPS over SSH.
#
#   curl -fsSL https://raw.githubusercontent.com/bridgenext/forge-codegraph/main/install.sh | sh
#
# Upgrade:   run `codegraph upgrade` (or just re-run the same command).
# Uninstall: curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Every downloaded archive is verified against the release's SHA256SUMS before
# it is extracted; a mismatch aborts the install. Set CODEGRAPH_SKIP_CHECKSUM=1
# only for a release that predates SHA256SUMS.
#
# Environment:
#   CODEGRAPH_VERSION        release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR    bundle location   (default: ~/.codegraph)
#   CODEGRAPH_BIN_DIR        symlink location  (default: ~/.local/bin)
#   CODEGRAPH_SKIP_CHECKSUM  set to 1 to skip archive verification (discouraged)
set -eu

REPO="bridgenext/forge-codegraph"
INSTALL_DIR="${CODEGRAPH_INSTALL_DIR:-$HOME/.codegraph}"
BIN_DIR="${CODEGRAPH_BIN_DIR:-$HOME/.local/bin}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BIN_DIR/codegraph"
  rm -rf "$INSTALL_DIR"
  echo "CodeGraph uninstalled (removed $INSTALL_DIR and $BIN_DIR/codegraph)."
  exit 0
fi

# 1. Detect platform → target triple matching the release archives.
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "codegraph: unsupported OS '$os'." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "codegraph: unsupported architecture '$arch'." >&2; exit 1 ;;
esac
target="${os}-${arch}"

# 2. Resolve the version (latest release unless pinned).
#
# Resolve "latest" from the releases/latest *web* redirect, not the GitHub API:
# the unauthenticated API is rate-limited to 60 requests/hour per IP and returns
# 403 once exhausted — routine on shared/cloud hosts and CI (issue #325). The
# redirect (github.com/<repo>/releases/latest -> .../releases/tag/vX.Y.Z) has no
# such limit. Fall back to the API if the redirect can't be read.
version="${CODEGRAPH_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" \
    | sed -n 's#.*/releases/tag/##p')"
fi
if [ -z "$version" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$version" ] || { echo "codegraph: could not resolve latest version; set CODEGRAPH_VERSION (e.g. CODEGRAPH_VERSION=v0.9.4)." >&2; exit 1; }
# Release tags are vX.Y.Z; accept a bare X.Y.Z in CODEGRAPH_VERSION too.
case "$version" in v*) ;; *) version="v$version" ;; esac

# 3. Download + extract the bundle.
url="https://github.com/$REPO/releases/download/$version/codegraph-${target}.tar.gz"
echo "Installing CodeGraph $version ($target)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/cg.tar.gz" || { echo "codegraph: download failed: $url" >&2; exit 1; }

# 3b. Verify the archive against the release's SHA256SUMS before extracting it.
#
# TLS authenticates the connection to GitHub, but nothing here previously
# authenticated the BYTES: a corrupted download, a caching proxy, an artifact
# swapped on a mirror, or a compromised release asset would all be extracted
# and executed unnoticed. SHA256SUMS is published as a release asset by the
# same workflow that builds the bundles, so checking against it turns a silent
# tamper into a hard failure. The marker comments below let a unit test run
# this exact block.
# >>> CODEGRAPH_VERIFY_CHECKSUM
verify_checksum() {
  archive="$1"; asset="$2"; sums="$3"
  # Pull this asset's line out of SHA256SUMS. Entries are "<hash>  <name>",
  # with an optional leading '*' on the name for binary mode.
  expected="$(sed -n "s#^\([0-9a-fA-F]\{64\}\)[[:space:]][[:space:]]*\*\{0,1\}${asset}\$#\1#p" "$sums" | head -n1)"
  [ -n "$expected" ] || return 2   # asset not listed
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  else
    return 3                        # no hashing tool available
  fi
  # Lowercase both sides; `tr` is in every POSIX base system.
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  actual="$(printf '%s' "$actual" | tr 'A-F' 'a-f')"
  [ "$expected" = "$actual" ] || return 1
  return 0
}

if [ "${CODEGRAPH_SKIP_CHECKSUM:-}" = "1" ]; then
  echo "codegraph: WARNING — archive verification skipped (CODEGRAPH_SKIP_CHECKSUM=1)." >&2
elif curl -fsSL "https://github.com/$REPO/releases/download/$version/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
  set +e
  verify_checksum "$tmp/cg.tar.gz" "codegraph-${target}.tar.gz" "$tmp/SHA256SUMS"
  rc=$?
  set -e
  case "$rc" in
    0) echo "Verified   SHA-256 checksum" ;;
    1) echo "codegraph: CHECKSUM MISMATCH for codegraph-${target}.tar.gz — refusing to install." >&2
       echo "codegraph: the download was corrupted or tampered with. Retry; if it persists, report it." >&2
       exit 1 ;;
    2) echo "codegraph: note — codegraph-${target}.tar.gz is not listed in SHA256SUMS; skipping verification." >&2 ;;
    3) echo "codegraph: note — neither sha256sum nor shasum found; skipping verification." >&2 ;;
  esac
else
  # Releases published before SHA256SUMS existed, or a transient fetch failure.
  echo "codegraph: note — no SHA256SUMS published for $version; skipping verification." >&2
fi
# <<< CODEGRAPH_VERIFY_CHECKSUM

dest="$INSTALL_DIR/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
# Archives contain a top-level codegraph-<target>/ dir; strip it.
tar -xzf "$tmp/cg.tar.gz" -C "$dest" --strip-components=1

# 4. Symlink the launcher onto PATH and mark the current version.
mkdir -p "$BIN_DIR"
ln -sf "$dest/bin/codegraph" "$BIN_DIR/codegraph"
ln -sfn "$dest" "$INSTALL_DIR/current"

echo "Installed to $dest"
echo "Linked     $BIN_DIR/codegraph"

# 5. Prune older bundles so they don't pile up across upgrades (issue #1074).
# Each release lives in its own versions/<v> dir (~50 MB with the vendored Node
# runtime). `codegraph upgrade` re-runs this script, which drops in a new dir
# and re-points `current` + the launcher — but it never removed the old dirs, so
# they accumulated indefinitely. Keep only what we just installed ($dest) and
# delete the rest. Safe even if a daemon is still executing an older bundle: on
# POSIX the inode stays alive until that process exits, so removing the dir can't
# break a running process. (Windows installs overwrite a single dir in place and
# never reach this.) The markers below let a unit test run this exact block.
# >>> CODEGRAPH_PRUNE_OLD_VERSIONS
pruned=0
if [ -d "$INSTALL_DIR/versions" ]; then
  for d in "$INSTALL_DIR/versions"/*; do
    [ -d "$d" ] || continue
    if [ "$d" != "$dest" ]; then
      if rm -rf "$d"; then
        pruned=$((pruned + 1))
      fi
    fi
  done
fi
if [ "$pruned" -gt 0 ]; then
  echo "Removed    $pruned older version(s)"
fi
# <<< CODEGRAPH_PRUNE_OLD_VERSIONS

# 6. PATH sanity. Two ways this install can fail to be the codegraph that runs:
#   1. $BIN_DIR isn't on PATH at all.
#   2. A *different* codegraph sits earlier on PATH and shadows ours — most
#      often a stale npm-global CodeGraph (this fork's, or upstream
#      @colbymchenry/codegraph), whose launcher keeps
#      running its own version-pinned bundle, so `codegraph --version` disagrees
#      with what we just installed (issue #1071).
# Walk PATH once: note whether $BIN_DIR is present and which codegraph wins.
on_path=0
winner=""
oldifs="$IFS"; IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  if [ "$dir" = "$BIN_DIR" ]; then on_path=1; fi
  if [ -z "$winner" ] && [ -x "$dir/codegraph" ] && [ ! -d "$dir/codegraph" ]; then
    winner="$dir/codegraph"
  fi
done
IFS="$oldifs"

if [ "$on_path" -eq 0 ]; then
  echo ""
  echo "$BIN_DIR is not on your PATH. Add it:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
elif [ -n "$winner" ] && [ "$winner" != "$BIN_DIR/codegraph" ]; then
  echo ""
  echo "Warning: another codegraph is earlier on your PATH and will run instead:"
  echo "  $winner"
  echo "  (this install: $BIN_DIR/codegraph)"
  echo "If 'codegraph --version' shows an unexpected version, remove the other copy"
  echo "(e.g. 'npm rm -g @bridgenext/codegraph') or put $BIN_DIR first on PATH."
fi

echo ""
echo "Done. Run: codegraph --help"
