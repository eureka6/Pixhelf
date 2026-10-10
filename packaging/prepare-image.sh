#!/bin/sh
set -eu
event="${FORGEJO_EVENT_NAME:-${GITHUB_EVENT_NAME:-}}"
ref="${FORGEJO_REF:-${GITHUB_REF:-}}"
revision="${FORGEJO_SHA:-${GITHUB_SHA:-}}"
server="${FORGEJO_SERVER_URL:-${GITHUB_SERVER_URL}}"
repository="${FORGEJO_REPOSITORY:-${GITHUB_REPOSITORY}}"
registry="${server#*://}"
registry="${registry%%/*}"
image="$repository"
version=latest
release_tag=
dockerhub_image=
publish_latest=false
architectures=amd64

case "${1:?Usage: prepare-image.sh local|release}:${event}:${ref}" in
  local:workflow_dispatch:*)
    image="${repository%%/*}/pixhelf-local"
    ;;
  release:push:refs/tags/v*)
    architectures='amd64 arm64'
    release_tag="${ref#refs/tags/}"
    version="${release_tag#v}"
    test -n "$version"
    test -f compose.yml
    : "${DOCKERHUB_USERNAME:?Missing Docker Hub username}"
    : "${DOCKERHUB_TOKEN:?Missing Docker Hub write token}"
    dockerhub_image="docker.io/${DOCKERHUB_USERNAME}/pixhelf"
    case "$version" in
      *-*) ;;
      *) publish_latest=true ;;
    esac
    ;;
  *) echo 'Use local for manual runs or release for pushed version tags' >&2; exit 1 ;;
esac

if ! printf '%s\n' "$revision" | grep -Eq '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; then
  echo 'Image publishing requires the checked-out commit SHA' >&2
  exit 1
fi
for arch in $architectures; do
  test -s "dist/pixhelf-${arch}-linux"
done
: "${REGISTRY_TOKEN:?Forgejo token requires write:package access}"
username="${REGISTRY_USERNAME:-${FORGEJO_ACTOR:-${GITHUB_ACTOR:-}}}"
: "${username:?Missing Forgejo registry username}"
image="$(printf '%s/%s' "$registry" "$image" | tr '[:upper:]' '[:lower:]')"

apk add --no-cache bind-tools ca-certificates coreutils curl tar
crane_archive=/tmp/go-containerregistry.tar.gz
curl --proto '=https' --tlsv1.2 --silent --show-error --fail --location \
  https://github.com/google/go-containerregistry/releases/download/v0.21.7/go-containerregistry_Linux_x86_64.tar.gz \
  --output "$crane_archive"
printf '%s  %s\n' \
  1a57bc98207fa1c0d04bf760699099e26f8383499bfd55b99c1b919a928a7230 "$crane_archive" \
  | sha256sum --check -
tar -xzf "$crane_archive" -C /usr/local/bin crane
crane version

login() {
  printf '%s' "$3" | crane auth login "$1" --username "$2" --password-stdin
}
login "$registry" "$username" "$REGISTRY_TOKEN"
if [ -n "$dockerhub_image" ]; then
  login index.docker.io "$DOCKERHUB_USERNAME" "$DOCKERHUB_TOKEN"
fi

printf '%s\n' \
  "RELEASE_TAG=$release_tag" \
  "IMAGE_VERSION=$version" \
  "IMAGE_ARCHITECTURES=$architectures" \
  "PUBLISH_LATEST=$publish_latest" \
  "DOCKERHUB_IMAGE=$dockerhub_image" \
  "REVISION=$revision" \
  "IMAGE=$image" \
  "SOURCE_URL=${server%/}/$repository" >> "$GITHUB_ENV"
printf 'Container image: %s:%s\n' "$image" "$version"
