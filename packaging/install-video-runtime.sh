#!/bin/sh
set -eu

# Run inside Alpine 3.23. --no-scripts allows building either architecture
# without executing foreign binaries. Docker and the OCI release use this alike.
case "$1" in
  amd64) video_arch=x86_64 ;;
  arm64) video_arch=aarch64 ;;
  *) echo "Unsupported video runtime architecture: $1" >&2; exit 1 ;;
esac
video_root="$2"
mkdir -p "$video_root"
apk --root "$video_root" --arch "$video_arch" --initdb --no-scripts --no-cache \
  --keys-dir /usr/share/apk/keys --repositories-file /etc/apk/repositories add ffmpeg
mkdir -p "$video_root/tmp"
chmod 1777 "$video_root/tmp"
test -x "$video_root/usr/bin/ffmpeg"
test -x "$video_root/usr/bin/ffprobe"
