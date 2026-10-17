#!/bin/sh
# Build only the local-file video features used by Pixhelf. Both executables
# are static musl ELF files; no host codecs, loader, network or devices are used.
set -eu

media_target="${1:?Usage: build-media-runtime.sh RUST_TARGET CACHE_DIR}"
media_cache="${2:?Missing cache directory}"
case "$media_target" in
  x86_64-*-linux-*) media_arch=x86_64 ;;
  aarch64-*-linux-*) media_arch=aarch64 ;;
  *) echo "Embedded media currently supports Linux x86_64 and aarch64" >&2; exit 1 ;;
esac
mkdir -p "$media_cache"
media_cache=$(cd "$media_cache" && pwd)
export ZIG_GLOBAL_CACHE_DIR="${ZIG_GLOBAL_CACHE_DIR:-$media_cache/zig-cache}"
media_root="$media_cache/$media_arch"
mkdir -p "$media_root" "$media_cache/sources"
exec 9>"$media_root/build.lock"
flock 9
media_signature=$(sha256sum "$0" | cut -d ' ' -f 1)
if [ -f "$media_root/built" ] && [ "$(cat "$media_root/built")" = "$media_signature" ]; then
  test -s "$media_root/ffmpeg" && test -s "$media_root/ffprobe" && exit 0
fi

download() {
  media_name="$1"
  media_url="$2"
  media_sha="$3"
  media_archive="$media_cache/sources/$media_name"
  if ! printf '%s  %s\n' "$media_sha" "$media_archive" | sha256sum --check --status 2>/dev/null; then
    curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --silent --show-error \
      "$media_url" -o "$media_archive.part"
    printf '%s  %s\n' "$media_sha" "$media_archive.part" | sha256sum --check --status
    mv "$media_archive.part" "$media_archive"
  fi
}

download ffmpeg-8.1.3.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz \
  7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
download x264.tar.gz \
  https://codeload.github.com/mirror/x264/tar.gz/31e19f92f00c7003fa115047ce50978bc98c3a0d \
  d053c9d86988d6bc78237ca5205865c5ddf99c98ef4cd9927eec8f6d388f6dd9
download zlib-1.3.2.tar.xz https://zlib.net/zlib-1.3.2.tar.xz \
  d7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3
download dav1d-1.5.3.tar.xz https://downloads.videolan.org/pub/videolan/dav1d/1.5.3/dav1d-1.5.3.tar.xz \
  732010aa5ef461fa93355ed2c6c5fedb48ddc4b74e697eaabe8907eaeb943011

if [ -n "${PIXHELF_MEDIA_CC:-}" ]; then
  media_cc="$PIXHELF_MEDIA_CC"
elif [ "$media_arch" = "$(uname -m)" ] && command -v musl-gcc >/dev/null 2>&1; then
  media_cc=musl-gcc
else
  media_cc="python3 -m ziglang cc -target $media_arch-linux-musl"
fi
if [ "$media_arch" = "$(uname -m)" ]; then
  media_strip="${PIXHELF_MEDIA_STRIP:-strip}"
else
  media_strip="${PIXHELF_MEDIA_STRIP:-$media_arch-linux-gnu-strip}"
fi
media_jobs="${PIXHELF_MEDIA_JOBS:-$(nproc)}"
# Leave headroom on large runners; callers can explicitly raise this limit.
if [ -z "${PIXHELF_MEDIA_JOBS:-}" ] && [ "$media_jobs" -gt 8 ]; then media_jobs=8; fi
media_work=$(mktemp -d "$media_root/build-XXXXXX")
trap 'rm -rf "$media_work"' EXIT HUP INT TERM
media_prefix="$media_work/prefix"
mkdir -p "$media_prefix"
tar --no-same-owner -xf "$media_cache/sources/ffmpeg-8.1.3.tar.xz" -C "$media_work"
mkdir -p "$media_work/x264"
tar --no-same-owner --strip-components=1 -xf "$media_cache/sources/x264.tar.gz" -C "$media_work/x264"
tar --no-same-owner -xf "$media_cache/sources/zlib-1.3.2.tar.xz" -C "$media_work"
tar --no-same-owner -xf "$media_cache/sources/dav1d-1.5.3.tar.xz" -C "$media_work"

MEDIA_CC="$media_cc" MEDIA_STRIP="$media_strip" MEDIA_ARCH="$media_arch" \
  python3 - "$media_work/cross.ini" <<'PY'
import os, shlex, sys
from pathlib import Path
arch = os.environ['MEDIA_ARCH']
Path(sys.argv[1]).write_text(
    '[binaries]\n'
    f'c = {shlex.split(os.environ["MEDIA_CC"])!r}\n'
    f'strip = {shlex.split(os.environ["MEDIA_STRIP"])!r}\n'
    "ar = 'ar'\npkg-config = 'pkg-config'\n"
    f"[host_machine]\nsystem = 'linux'\ncpu_family = '{arch}'\ncpu = '{arch}'\nendian = 'little'\n"
    '[properties]\nneeds_exe_wrapper = true\n'
)
PY
(
  meson setup "$media_work/dav1d-build" "$media_work/dav1d-1.5.3" \
    --cross-file "$media_work/cross.ini" --prefix "$media_prefix" --libdir lib \
    --buildtype minsize --default-library static -Denable_tools=false -Denable_tests=false \
    '-Dc_args=["-ffunction-sections", "-fdata-sections"]' || exit 1
  ninja -C "$media_work/dav1d-build" -j "$media_jobs" install || exit 1
) >"$media_root/dav1d.log" 2>&1 || { tail -60 "$media_root/dav1d.log"; exit 1; }

(
  cd "$media_work/zlib-1.3.2" || exit 1
  CC="$media_cc" AR=ar RANLIB=ranlib CFLAGS='-Os -fPIC' \
    ./configure --static --prefix="$media_prefix" || exit 1
  make -j "$media_jobs" || exit 1
  make install || exit 1
) >"$media_root/zlib.log" 2>&1 || { tail -60 "$media_root/zlib.log"; exit 1; }
(
  cd "$media_work/x264" || exit 1
  CC="$media_cc" AR=ar RANLIB=ranlib STRIP="$media_strip" \
    ./configure --host="$media_arch-linux-musl" --prefix="$media_prefix" \
      --enable-static --enable-pic --disable-cli --disable-opencl \
      --disable-lavf --disable-swscale --bit-depth=8 --chroma-format=420 \
      --extra-cflags='-Os -ffunction-sections -fdata-sections' || exit 1
  make -j "$media_jobs" || exit 1
  make install-lib-static || exit 1
) >"$media_root/x264.log" 2>&1 || { tail -60 "$media_root/x264.log"; exit 1; }
(
  cd "$media_work/ffmpeg-8.1.3" || exit 1
  PKG_CONFIG_LIBDIR="$media_prefix/lib/pkgconfig" ./configure \
    --arch="$media_arch" --target-os=linux --enable-cross-compile \
    --cc="$media_cc" --ar=ar --ranlib=ranlib --strip="$media_strip" \
    --extra-cflags="-I$media_prefix/include -ffunction-sections -fdata-sections" \
    --extra-ldflags="-L$media_prefix/lib -static -Wl,--gc-sections" \
    --pkg-config-flags=--static --disable-autodetect --disable-shared \
    --enable-static --enable-small --disable-debug --disable-doc \
    --disable-network --disable-avdevice --disable-hwaccels --disable-everything \
    --enable-ffmpeg --enable-ffprobe --disable-ffplay --enable-pthreads \
    --enable-gpl --enable-libx264 --enable-libdav1d --enable-zlib \
    --enable-decoders --enable-parsers --enable-bsfs \
    --disable-v4l2-m2m --disable-vaapi --disable-vdpau --disable-vulkan \
    --enable-protocol=file,pipe \
    --enable-demuxer=mov,matroska,avi,ogg,flv,asf,mpegts,mpegps,mpegvideo,m4v,hevc,h264,mjpeg,image_jpeg_pipe,mxf,rm,swf,wtv \
    --enable-muxer=mp4,image2pipe \
    --enable-encoder=libx264,aac,png \
    --enable-filter=scale,setsar,fps,format,aformat,aresample,anull,null,transpose,hflip,vflip,trim,atrim,crop || exit 1
  make -j "$media_jobs" ffmpeg ffprobe || exit 1
  for media_program in ffmpeg ffprobe; do
    if readelf -l "$media_program" | grep -q INTERP || readelf -d "$media_program" 2>/dev/null | grep -q NEEDED; then
      echo "$media_program is not fully static" >&2
      exit 1
    fi
    install -m 0755 "$media_program" "$media_root/$media_program" || exit 1
  done
) >"$media_root/ffmpeg.log" 2>&1 || { tail -80 "$media_root/ffmpeg.log"; exit 1; }

# Preserve the exact source/licensing material alongside build artifacts.
cp "$media_work/ffmpeg-8.1.3/COPYING.GPLv2" "$media_root/COPYING.GPLv2"
cp "$media_work/x264/COPYING" "$media_root/COPYING.x264"
cp "$media_work/zlib-1.3.2/LICENSE" "$media_root/LICENSE.zlib"
cp "$media_work/dav1d-1.5.3/COPYING" "$media_root/COPYING.dav1d"
printf '%s\n' "$media_signature" >"$media_root/built"
wc -c "$media_root/ffmpeg" "$media_root/ffprobe"
