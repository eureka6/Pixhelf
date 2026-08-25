#!/usr/bin/env bash

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"

SKOPEO_BIN="${SKOPEO_BIN:-skopeo}"
UMOCI_BIN="${UMOCI_BIN:-umoci}"
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

created="$(date --utc --date="@$SOURCE_DATE_EPOCH" '+%Y-%m-%dT%H:%M:%SZ')"

build_platform() {
  local arch="$1"
  local binary="$2"
  local root="$work_dir/root-$arch"
  local layer="$work_dir/pixhelf-$arch.tar"
  local layout="$work_dir/oci-$arch"

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

  "$SKOPEO_BIN" copy \
    --override-os linux \
    --override-arch "$arch" \
    "docker://$ALPINE_IMAGE" \
    "oci:$layout:base"
  "$UMOCI_BIN" raw add-layer \
    --image "$layout:base" \
    --history.created "$created" \
    --history.created_by "pixhelf release $RELEASE_TAG" \
    "$layer"
  "$UMOCI_BIN" config \
    --image "$layout:base" \
    --created "$created" \
    --os linux \
    --architecture "$arch" \
    --config.user=65532:65532 \
    --config.entrypoint=/usr/local/bin/pixhelf \
    --config.cmd=--gallery-dir \
    --config.cmd=/gallery \
    --config.cmd=--cache-dir \
    --config.cmd=/cache \
    --config.cmd=--listen \
    --config.cmd=0.0.0.0:3002 \
    --config.workingdir=/ \
    --config.exposedports=3002/tcp \
    --config.stopsignal=SIGTERM \
    --config.label=org.opencontainers.image.title=Pixhelf \
    --config.label="org.opencontainers.image.description=Self-hosted image gallery" \
    --config.label="org.opencontainers.image.version=$version" \
    --config.label="org.opencontainers.image.revision=$REVISION" \
    --config.label="org.opencontainers.image.created=$created" \
    --config.label="org.opencontainers.image.source=$SOURCE_URL"

  echo "Built linux/$arch OCI image from $ALPINE_IMAGE"
}

build_platform amd64 "$DIST_DIR/pixhelf-amd64-linux"
build_platform arm64 "$DIST_DIR/pixhelf-arm64-linux"

combined_layout="$work_dir/oci-multi"
install -d -m 0755 "$combined_layout/blobs/sha256"
cp -a "$work_dir/oci-amd64/blobs/sha256/." "$combined_layout/blobs/sha256/"
cp -a "$work_dir/oci-arm64/blobs/sha256/." "$combined_layout/blobs/sha256/"

AMD64_LAYOUT="$work_dir/oci-amd64" \
ARM64_LAYOUT="$work_dir/oci-arm64" \
COMBINED_LAYOUT="$combined_layout" \
IMAGE_TAG="$version" \
node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function platformDescriptor(layout, architecture) {
  const index = JSON.parse(fs.readFileSync(path.join(layout, "index.json"), "utf8"));
  const descriptor = index.manifests.find(
    (candidate) => candidate.annotations?.["org.opencontainers.image.ref.name"] === "base",
  );
  if (!descriptor) throw new Error(`Cannot find image manifest in ${layout}`);
  const result = structuredClone(descriptor);
  delete result.annotations;
  result.platform = { architecture, os: "linux" };
  return result;
}

const manifests = [
  platformDescriptor(process.env.AMD64_LAYOUT, "amd64"),
  platformDescriptor(process.env.ARM64_LAYOUT, "arm64"),
];
const imageIndex = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests,
}));
const digest = crypto.createHash("sha256").update(imageIndex).digest("hex");
const combined = process.env.COMBINED_LAYOUT;
fs.writeFileSync(path.join(combined, "blobs", "sha256", digest), imageIndex);
fs.writeFileSync(path.join(combined, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
fs.writeFileSync(path.join(combined, "index.json"), JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [{
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: `sha256:${digest}`,
    size: imageIndex.length,
    annotations: { "org.opencontainers.image.ref.name": process.env.IMAGE_TAG },
  }],
}));
NODE

destination_args=()
inspect_args=()
if [ "${REGISTRY_INSECURE:-0}" = 1 ]; then
  destination_args+=(--dest-tls-verify=false)
  inspect_args+=(--tls-verify=false)
fi

publish_tag() {
  local tag="$1"
  "$SKOPEO_BIN" copy \
    --all \
    "${destination_args[@]}" \
    "oci:$combined_layout:$version" \
    "docker://$IMAGE_REPOSITORY:$tag"
  echo "Published $IMAGE_REPOSITORY:$tag"
}

canonical_ref="$IMAGE_REPOSITORY:$version"
publish_tag "$version"

if [ "$RELEASE_TAG" != "$version" ]; then
  publish_tag "$RELEASE_TAG"
fi
case "$version" in
  *-*) echo "Prerelease detected; latest tag was not updated" ;;
  *) publish_tag latest ;;
esac

"$SKOPEO_BIN" inspect "${inspect_args[@]}" --raw "docker://$canonical_ref" | node -e '
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
