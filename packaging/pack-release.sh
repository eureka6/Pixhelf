#!/bin/sh
# Compress a release copy, leaving Cargo's original artifact available for
# debugging. UPX is a build tool; the distributed executable needs no unpacker.
set -eu
pack_input="${1:?Usage: pack-release.sh INPUT OUTPUT}"
pack_output="${2:?Missing output path}"
pack_project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pack_cache="$pack_project/target/pack-tools"
case "$(uname -m)" in
  x86_64) pack_arch=amd64; pack_sha=402162aad30af47e60dbd767fb2e64ca394ace9727ba1f40283641f1d1b91657 ;;
  aarch64) pack_arch=arm64; pack_sha=a72d112c5970a904a31da0b9c84f919bc16b9a311787c12245508544a78c7d36 ;;
  *) echo "Unsupported release build host" >&2; exit 1 ;;
esac
mkdir -p "$pack_cache"
pack_archive="$pack_cache/upx-5.2.1-${pack_arch}_linux.tar.xz"
exec 9>"$pack_cache/lock"
flock 9
if ! printf '%s  %s\n' "$pack_sha" "$pack_archive" | sha256sum --check --status 2>/dev/null; then
  curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --silent --show-error \
    "https://github.com/upx/upx/releases/download/v5.2.1/upx-5.2.1-${pack_arch}_linux.tar.xz" \
    -o "$pack_archive.part"
  printf '%s  %s\n' "$pack_sha" "$pack_archive.part" | sha256sum --check --status
  mv "$pack_archive.part" "$pack_archive"
fi
tar --no-same-owner -xf "$pack_archive" -C "$pack_cache"
pack_upx="$pack_cache/upx-5.2.1-${pack_arch}_linux/upx"
flock -u 9
if readelf -l "$pack_input" | grep -q INTERP || readelf -d "$pack_input" 2>/dev/null | grep -q NEEDED; then
  echo "Release input must be static (use a musl target)" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$pack_output")"
pack_temporary=$(mktemp "${pack_output}.XXXXXX")
trap 'rm -f "$pack_temporary"' EXIT HUP INT TERM
install -m 0755 "$pack_input" "$pack_temporary"
"$pack_upx" --best --lzma --no-progress "$pack_temporary"
"$pack_upx" --test "$pack_temporary"
if [ "$(wc -c < "$pack_temporary")" -gt 26214400 ]; then
  echo "Compressed standalone release exceeds 25 MiB" >&2
  exit 1
fi
mv "$pack_temporary" "$pack_output"
wc -c "$pack_output"
