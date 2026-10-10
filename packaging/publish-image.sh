#!/bin/sh
# Shared by the version release and manual pixhelf-local workflows.
set -eu
: "${IMAGE:?Missing registry image}"
: "${IMAGE_VERSION:?Missing image tag}"
: "${REVISION:?Missing commit SHA}"
: "${SOURCE_URL:?Missing source URL}"
work="$(mktemp -d /tmp/pixhelf-oci.XXXXXX)"
local_registry=127.0.0.1:5000
model_revision=f4a64596bbcf9a2a94591b74b9dc39b2e4e77e3e
model_name=chinese-clip-vit-base-patch16-f4a64596
model_path="/opt/pixhelf/models/$model_name"
model_root="$work/model-root"
model_layer="$work/model-layer.tar"
model_base_ref="$local_registry/staging:model-base"
mkdir -p "$model_root$model_path"

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

download_model_artifact \
  model.safetensors \
  29cc0b2bcf6ff777f2e15742be92b110e4acbdb2068356e862c4637a4b15fe4f \
  753106020
download_model_artifact \
  vocab.txt \
  45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c \
  109540

chmod 0755 \
  "$model_root/opt" \
  "$model_root/opt/pixhelf" \
  "$model_root/opt/pixhelf/models" \
  "$model_root$model_path"

tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf "$model_layer" -C "$model_root" opt

crane registry serve --address "$local_registry" >"$work/registry.log" 2>&1 &
registry_pid=$!
cleanup() {
  kill "$registry_pid" >/dev/null 2>&1 || true
  wait "$registry_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
sleep 1

crane append --insecure --oci-empty-base \
  --new_layer "$model_layer" \
  --new_tag "$model_base_ref"
model_layer_digest="$(crane manifest --insecure "$model_base_ref" | node -e '
  const { layers } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  require("node:assert/strict").equal(layers?.length, 1, "model layer count");
  process.stdout.write(layers[0].digest);
')"

build_platform() {
  arch="$1"
  asset="$2"
  platform_dir="$work/$arch"
  rootfs="$platform_dir/rootfs"
  base_ref="$local_registry/staging:${arch}-base"
  configured_ref="$local_registry/staging:${arch}"

  mkdir -p "$rootfs"
  mkdir -m 1777 "$rootfs/tmp"
  install -m 0755 "$asset" "$rootfs/pixhelf"
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -cf "$platform_dir/layer.tar" -C "$rootfs" pixhelf tmp

  crane append --insecure \
    --base "$model_base_ref" \
    --new_layer "$platform_dir/layer.tar" \
    --new_tag "$base_ref"
  crane mutate --insecure "$base_ref" \
    --tag "$configured_ref" \
    --set-platform "linux/$arch" \
    --entrypoint /pixhelf \
    --workdir /data \
    --exposed-ports 3002/tcp \
    --env "PIXHELF_TEXT_SEARCH_MODEL=$model_path" \
    --label org.opencontainers.image.title=Pixhelf \
    --label 'org.opencontainers.image.description=Self-hosted photo and video gallery' \
    --label "org.opencontainers.image.version=$IMAGE_VERSION" \
    --label "org.opencontainers.image.revision=$REVISION" \
    --label "org.opencontainers.image.source=$SOURCE_URL"

  crane config --insecure "$configured_ref" \
    | ARCH="$arch" MODEL_PATH="$model_path" node -e '
        const assert = require("node:assert/strict");
        const { os, architecture, config } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        assert.equal(os, "linux");
        assert.equal(architecture, process.env.ARCH);
        assert.equal(config.Entrypoint?.[0], "/pixhelf");
        assert.equal(config.WorkingDir, "/data");
        assert.ok(config.ExposedPorts?.["3002/tcp"], "exposed port");
        assert.ok(config.Env?.includes(`PIXHELF_TEXT_SEARCH_MODEL=${process.env.MODEL_PATH}`), "bundled model");'

  app_layer_digest="$(crane manifest --insecure "$configured_ref" \
    | EXPECTED_MODEL_LAYER="$model_layer_digest" node -e '
        const assert = require("node:assert/strict");
        const { layers } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        assert.equal(layers?.length, 2, "application layer count");
        assert.equal(layers[0].digest, process.env.EXPECTED_MODEL_LAYER, "shared model layer");
        process.stdout.write(layers[1].digest);'
  )"

  expected="$(sha256sum "$asset" | cut -d ' ' -f 1)"
  actual="$(crane blob --insecure "$local_registry/staging@$app_layer_digest" \
    | gzip -dc \
    | tar -xOf - pixhelf \
    | sha256sum \
    | cut -d ' ' -f 1)"
  test "$actual" = "$expected"
}

if [ -n "${DOCKERHUB_IMAGE:-}" ]; then
  pin_ipv4 auth.docker.io
  pin_ipv4 index.docker.io
  pin_ipv4 registry-1.docker.io
fi

build_platform amd64 dist/pixhelf-amd64-linux
amd64_manifest="$configured_ref"
build_platform arm64 dist/pixhelf-arm64-linux
arm64_manifest="$configured_ref"

verify_index() {
  index="$(retry_remote crane index list "$1")"
  printf '%s\n' "$index"
  printf '%s\n' "$index" | grep -q 'linux/amd64'
  printf '%s\n' "$index" | grep -q 'linux/arm64'
}

# Assemble and check both architectures before publishing any remote tag.
index_path="$work/index"
crane index append --insecure "$index_path" \
  --manifest "$amd64_manifest" \
  --manifest "$arm64_manifest"
verify_index "$index_path"
index_digest="sha256:$(sha256sum "$index_path/index.json" | cut -d ' ' -f 1)"

set -- "$IMAGE"
if [ -n "${DOCKERHUB_IMAGE:-}" ]; then
  set -- "$@" "$DOCKERHUB_IMAGE"
fi
for destination in "$@"; do
  retry_remote crane push --index "$index_path" "${destination}@${index_digest}"
  verify_index "${destination}@${index_digest}"
done

# Only move tags after the complete index has been verified at each registry.
for destination in "$@"; do
  retry_remote crane tag "${destination}@${index_digest}" "$IMAGE_VERSION"
  if [ "${PUBLISH_LATEST:-false}" = true ] && [ "$IMAGE_VERSION" != latest ]; then
    retry_remote crane tag "${destination}@${index_digest}" latest
  fi
done
