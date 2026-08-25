#!/usr/bin/env bash

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"

CRANE_BIN="${CRANE_BIN:-crane}"
ALPINE_IMAGE="${ALPINE_IMAGE:-docker.io/library/alpine:latest}"
DIST_DIR="${DIST_DIR:-dist}"
SOURCE_URL="${SOURCE_URL:-}"
REVISION="${REVISION:-$(git rev-parse HEAD)}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}"

version="${RELEASE_TAG#v}"
if [ -z "$version" ]; then
  echo "Release tag must contain a version" >&2
  exit 1
fi
case "$SOURCE_DATE_EPOCH" in
  *[!0-9]* | '')
    echo "SOURCE_DATE_EPOCH must be an integer" >&2
    exit 1
    ;;
esac

work_dir="$(mktemp -d /tmp/pixhelf-container.XXXXXX)"
cleanup() {
  case "$work_dir" in
    /tmp/pixhelf-container.*) rm -rf -- "$work_dir" ;;
    *) echo "Refusing to remove unexpected path: $work_dir" >&2 ;;
  esac
}
trap cleanup EXIT

crane_args=()
if [ "${CRANE_INSECURE:-0}" = 1 ]; then
  crane_args+=(--insecure)
fi
crane() {
  "$CRANE_BIN" "${crane_args[@]}" "$@"
}

created="$(date --utc --date="@$SOURCE_DATE_EPOCH" '+%Y-%m-%dT%H:%M:%SZ')"
platform_digest=''

build_platform() {
  local arch="$1"
  local binary="$2"
  local root="$work_dir/root-$arch"
  local layer="$work_dir/pixhelf-$arch.tar"
  local platform_ref="$IMAGE_REPOSITORY:$version-$arch"

  test -x "$binary"
  install -d -m 0755 "$root/usr/local/bin" "$root/gallery"
  install -d -m 0777 "$root/cache"
  install -m 0755 "$binary" "$root/usr/local/bin/pixhelf"

  tar \
    --sort=name \
    --mtime="@$SOURCE_DATE_EPOCH" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C "$root" \
    -cf "$layer" \
    cache gallery usr

  crane append \
    --platform "linux/$arch" \
    --base "$ALPINE_IMAGE" \
    --new_layer "$layer" \
    --new_tag "$platform_ref" \
    --set-base-image-annotations

  crane mutate "$platform_ref" \
    --platform "linux/$arch" \
    --set-platform "linux/$arch" \
    --entrypoint=/usr/local/bin/pixhelf \
    --cmd=--gallery-dir \
    --cmd=/gallery \
    --cmd=--cache-dir \
    --cmd=/cache \
    --cmd=--listen \
    --cmd=0.0.0.0:3002 \
    --user=65532:65532 \
    --workdir=/ \
    --exposed-ports=3002/tcp \
    --label=org.opencontainers.image.title=Pixhelf \
    --label="org.opencontainers.image.description=Self-hosted image gallery" \
    --label="org.opencontainers.image.version=$version" \
    --label="org.opencontainers.image.revision=$REVISION" \
    --label="org.opencontainers.image.created=$created" \
    --label="org.opencontainers.image.source=$SOURCE_URL" \
    --tag "$platform_ref"

  platform_digest="$(crane digest "$platform_ref")"
  echo "Published linux/$arch as $platform_ref@$platform_digest"
}

build_platform amd64 "$DIST_DIR/pixhelf-amd64-linux"
amd64_digest="$platform_digest"
build_platform arm64 "$DIST_DIR/pixhelf-arm64-linux"
arm64_digest="$platform_digest"

canonical_ref="$IMAGE_REPOSITORY:$version"
crane index append \
  --manifest "$IMAGE_REPOSITORY@$amd64_digest" \
  --manifest "$IMAGE_REPOSITORY@$arm64_digest" \
  --tag "$canonical_ref"

if [ "$RELEASE_TAG" != "$version" ]; then
  crane tag "$canonical_ref" "$RELEASE_TAG"
fi
case "$version" in
  *-*) echo "Prerelease detected; latest tag was not updated" ;;
  *) crane tag "$canonical_ref" latest ;;
esac

crane manifest "$canonical_ref" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const index = JSON.parse(input);
  const platforms = new Set((index.manifests ?? []).map(
    (manifest) => `${manifest.platform?.os}/${manifest.platform?.architecture}`,
  ));
  for (const expected of ["linux/amd64", "linux/arm64"]) {
    if (!platforms.has(expected)) {
      throw new Error(`Published image is missing ${expected}`);
    }
  }
  console.log(`Verified multi-platform image: ${[...platforms].sort().join(", ")}`);
});
'

echo "Published $canonical_ref"
