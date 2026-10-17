#!/bin/sh
# Shared by the version release and manual pixhelf-local workflows.
set -eu
: "${IMAGE:?Missing registry image}"
: "${IMAGE_VERSION:?Missing image tag}"
: "${REVISION:?Missing commit SHA}"
: "${SOURCE_URL:?Missing source URL}"
: "${IMAGE_ARCHITECTURES:?Missing image architectures}"
case "$IMAGE_ARCHITECTURES" in
  amd64|'amd64 arm64') ;;
  *) echo "Unsupported image architectures: $IMAGE_ARCHITECTURES" >&2; exit 1 ;;
esac
work="$(mktemp -d /tmp/pixhelf-oci.XXXXXX)"
trap 'rm -rf "$work"' EXIT
model_revision=f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e
model_checksum=29cc0b2bcf6ff777f2e15742be92b110e4acbdb2068356e862c4637a4b15fe4f
vocab_checksum=45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c
model_name=chinese-clip-vit-base-patch16-f4a64596
model_path="/opt/pixhelf/models/$model_name"
model_root="$work/model-root"
model_layer="$work/model-layer.tar"
model_cache_tag="model-${model_revision}-v1"
model_cache_ref="$IMAGE:$model_cache_tag"

log_elapsed() {
  printf '[timing] %s: %ss\n' "$1" "$(($(date +%s) - $2))"
}

retry_remote() {
  attempt=1
  while ! "$@"; do
    if [ "$attempt" -ge 5 ]; then
      echo "Remote operation failed after ${attempt} attempts: $*" >&2
      return 1
    fi
    retry_seconds=$((attempt * 5))
    echo "Remote operation failed; retrying in ${retry_seconds}s: $*" >&2
    sleep "$retry_seconds"
    attempt=$((attempt + 1))
  done
}

pin_ipv4() {
  host="$1"
  address="$(dig +short A "$host" | awk '/^[0-9]+\./ { print; exit }')"
  if [ -z "$address" ]; then
    echo "Cannot resolve an IPv4 address for ${host}" >&2
    return 1
  fi
  printf '%s %s\n' "$address" "$host" >> /etc/hosts
  echo "Pinned ${host} to IPv4 address ${address}"
}

# Keep this metadata in sync with src/text_search/download.rs and Dockerfile.
download_model_artifact() {
  filename="$1"
  checksum="$2"
  expected_size="$3"
  destination="$model_root$model_path/$filename"
  url="https://huggingface.co/OFA-Sys/chinese-clip-vit-base-patch16/resolve/$model_revision/$filename"

  curl --proto '=https' --tlsv1.2 --silent --show-error --fail --location \
    --retry 5 \
    --retry-all-errors \
    --continue-at - \
    "$url" \
    --output "$destination"
  printf '%s  %s\n' "$checksum" "$destination" | sha256sum --check -
  actual_size="$(wc -c < "$destination" | tr -d ' ')"
  test "$actual_size" = "$expected_size"
  chmod 0644 "$destination"
}

# A cache tag is only a lookup hint. Pin its digest and check the model identity
# and single-layer layout before reusing it; never extend an application image.
verify_model_base() {
  retry_remote crane manifest "$model_base_ref" >"$work/model-manifest.json" || return 1
  retry_remote crane config "$model_base_ref" >"$work/model-config.json" || return 1
  MODEL_REVISION="$model_revision" MODEL_CHECKSUM="$model_checksum" VOCAB_CHECKSUM="$vocab_checksum" \
    MODEL_PATH="$model_path" node - "$work/model-manifest.json" "$work/model-config.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2]));
const config = JSON.parse(fs.readFileSync(process.argv[3]));
assert.equal(manifest.layers?.length, 1, 'model base layer count');
assert.equal(config.rootfs?.diff_ids?.length, 1, 'model base rootfs');
const labels = config.config?.Labels ?? {};
assert.equal(labels['io.pixhelf.model.revision'], process.env.MODEL_REVISION);
assert.equal(labels['io.pixhelf.model.sha256'], process.env.MODEL_CHECKSUM);
assert.equal(labels['io.pixhelf.model.vocab-sha256'], process.env.VOCAB_CHECKSUM);
assert.ok(config.config.Env?.includes(`PIXHELF_TEXT_SEARCH_MODEL=${process.env.MODEL_PATH}`));
NODE
}

model_started=$(date +%s)
model_cache_hit=false
if model_digest=$(crane digest "$model_cache_ref" 2>"$work/model-cache.log"); then
  model_base_ref="$IMAGE@$model_digest"
  if verify_model_base; then model_cache_hit=true; fi
fi
if [ "$model_cache_hit" = true ]; then
  echo "[cache] Reusing model base $model_base_ref"
else
  echo '[cache] Model base unavailable or outdated; downloading and verifying pinned sources'
  mkdir -p "$model_root$model_path"
  download_model_artifact model.safetensors "$model_checksum" 753106020
  download_model_artifact vocab.txt "$vocab_checksum" 109540
  chmod 0755 "$model_root/opt" "$model_root/opt/pixhelf" "$model_root/opt/pixhelf/models" "$model_root$model_path"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -cf "$model_layer" -C "$model_root" opt

  model_base_ref=$(retry_remote crane append --oci-empty-base --new_layer "$model_layer" --new_tag "$model_cache_ref")
  model_base_ref=$(retry_remote crane mutate "$model_base_ref" \
    --env "PIXHELF_TEXT_SEARCH_MODEL=$model_path" \
    --label "io.pixhelf.model.revision=$model_revision" \
    --label "io.pixhelf.model.sha256=$model_checksum" \
    --label "io.pixhelf.model.vocab-sha256=$vocab_checksum")
  verify_model_base
  retry_remote crane tag "$model_base_ref" "$model_cache_tag"
fi
model_layer_digest=$(node -e 'process.stdout.write(require(process.argv[1]).layers[0].digest)' "$work/model-manifest.json")
log_elapsed 'model base' "$model_started"

build_platform() {
  arch="$1"
  asset="$2"
  platform_dir="$work/$arch"
  rootfs="$platform_dir/rootfs"
  platform_started=$(date +%s)

  mkdir -p "$rootfs"
  mkdir -m 1777 "$rootfs/tmp"
  install -m 0755 "$asset" "$rootfs/pixhelf"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -cf "$platform_dir/layer.tar" -C "$rootfs" pixhelf tmp

  # Appending in the same repository lets the registry retain the model blob.
  # Passing a digest makes crane publish the result by digest, without moving
  # either the model cache tag or any application tag.
  configured_ref=$(retry_remote crane mutate "$model_base_ref" \
    --append "$platform_dir/layer.tar" \
    --set-platform "linux/$arch" \
    --entrypoint /pixhelf \
    --workdir /data \
    --exposed-ports 3002/tcp \
    --env "PIXHELF_TEXT_SEARCH_MODEL=$model_path" \
    --label org.opencontainers.image.title=Pixhelf \
    --label 'org.opencontainers.image.description=Self-hosted photo and video gallery' \
    --label "org.opencontainers.image.version=$IMAGE_VERSION" \
    --label "org.opencontainers.image.revision=$REVISION" \
    --label "org.opencontainers.image.source=$SOURCE_URL")

  retry_remote crane config "$configured_ref" \
    | ARCH="$arch" MODEL_PATH="$model_path" node -e '
        const assert = require("node:assert/strict");
        const { os, architecture, config } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        assert.equal(os, "linux");
        assert.equal(architecture, process.env.ARCH);
        assert.equal(config.Entrypoint?.[0], "/pixhelf");
        assert.equal(config.WorkingDir, "/data");
        assert.ok(config.ExposedPorts?.["3002/tcp"], "exposed port");
        assert.ok(config.Env?.includes("PIXHELF_TEXT_SEARCH_MODEL=" + process.env.MODEL_PATH), "bundled model");'

  app_layer_digest="$(retry_remote crane manifest "$configured_ref" \
    | EXPECTED_MODEL_LAYER="$model_layer_digest" node -e '
        const assert = require("node:assert/strict");
        const { layers } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        assert.equal(layers?.length, 2, "application layer count");
        assert.equal(layers[0].digest, process.env.EXPECTED_MODEL_LAYER, "shared model layer");
        process.stdout.write(layers[1].digest);'
  )"

  expected="$(sha256sum "$asset" | cut -d ' ' -f 1)"
  retry_remote crane blob "$IMAGE@$app_layer_digest" >"$platform_dir/layer.tar.gz"
  actual="$(gzip -dc "$platform_dir/layer.tar.gz" \
    | tar -xOf - pixhelf \
    | sha256sum \
    | cut -d ' ' -f 1)"
  test "$actual" = "$expected"
  log_elapsed "image linux/$arch" "$platform_started"
}

case "${DOCKERHUB_IMAGE:-}" in
  docker.io/*)
    pin_ipv4 auth.docker.io
    pin_ipv4 index.docker.io
    pin_ipv4 registry-1.docker.io
    ;;
esac

set --
for arch in $IMAGE_ARCHITECTURES; do
  build_platform "$arch" "dist/pixhelf-${arch}-linux"
  set -- "$@" --manifest "$configured_ref"
done

verify_index() {
  index="$(retry_remote crane index list "$1")"
  printf '%s\n' "$index"
  for expected_arch in $IMAGE_ARCHITECTURES; do
    printf '%s\n' "$index" | grep -q "linux/$expected_arch"
  done
}

# Assemble remotely: exporting an OCI layout here would download the model
# again. The internal cache tag is reusable; subsequent operations use only
# the immutable digest returned by crane, including during concurrent runs.
index_ref=$(retry_remote crane index append --tag "$IMAGE:build-cache" "$@")
verify_index "$index_ref"
index_digest="${index_ref##*@}"

set -- "$IMAGE"
if [ -n "${DOCKERHUB_IMAGE:-}" ]; then
  set -- "$@" "$DOCKERHUB_IMAGE"
fi
for destination in "$@"; do
  destination_started=$(date +%s)
  if [ "$destination" != "$IMAGE" ]; then
    retry_remote crane copy "$index_ref" "${destination}@${index_digest}"
  fi
  verify_index "${destination}@${index_digest}"
  log_elapsed "registry $destination" "$destination_started"
done

# Only move tags after the complete index has been verified at each registry.
for destination in "$@"; do
  retry_remote crane tag "${destination}@${index_digest}" "$IMAGE_VERSION"
  if [ "${PUBLISH_LATEST:-false}" = true ] && [ "$IMAGE_VERSION" != latest ]; then
    retry_remote crane tag "${destination}@${index_digest}" latest
  fi
done
