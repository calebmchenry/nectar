#!/bin/sh
set -eu

log() {
  printf '%s\n' "$1"
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

detect_os() {
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    darwin|linux)
      printf '%s\n' "$os"
      ;;
    *)
      fail "Unsupported operating system: $os"
      ;;
  esac
}

detect_arch() {
  arch_raw=$(uname -m)
  case "$arch_raw" in
    x86_64|amd64)
      printf '%s\n' "x64"
      ;;
    aarch64|arm64)
      printf '%s\n' "arm64"
      ;;
    *)
      fail "Unsupported architecture: $arch_raw"
      ;;
  esac
}

sha256_file() {
  file_path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi

  fail "No SHA256 tool available. Install 'sha256sum' or 'shasum'."
}

main() {
  os=$(detect_os)
  arch=$(detect_arch)

  asset_name="nectar-${os}-${arch}"
  install_dir=${NECTAR_INSTALL_DIR:-"${HOME}/.local/bin"}
  base_url=${NECTAR_RELEASE_BASE_URL:-"https://github.com/calebmchenry/nectar/releases/latest/download"}

  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM HUP

  log "🐝 Fetching nectar for ${os}/${arch}..."
  curl -fSL -o "$tmp_dir/$asset_name" "$base_url/$asset_name"
  curl -fsSL -o "$tmp_dir/SHA256SUMS" "$base_url/SHA256SUMS"

  expected_hash=$(awk -v asset="$asset_name" '$2 == asset {print $1; exit}' "$tmp_dir/SHA256SUMS")
  if [ -z "$expected_hash" ]; then
    fail "Could not find checksum entry for $asset_name in SHA256SUMS"
  fi

  actual_hash=$(sha256_file "$tmp_dir/$asset_name")
  if [ "$actual_hash" != "$expected_hash" ]; then
    fail "Checksum mismatch for $asset_name. Aborting."
  fi

  mkdir -p "$install_dir"
  mv "$tmp_dir/$asset_name" "$install_dir/nectar"
  chmod +x "$install_dir/nectar"

  version=$("$install_dir/nectar" --version 2>/dev/null || printf 'unknown')

  log "🌸 Nectar installed to $install_dir/nectar"
  log "🍯 Version: $version"

  case ":$PATH:" in
    *":$install_dir:"*)
      ;;
    *)
      log "Add this to your shell profile:"
      log "  export PATH=\"$install_dir:\$PATH\""
      ;;
  esac
}

main "$@"
