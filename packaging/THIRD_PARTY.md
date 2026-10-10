# Embedded media components

Pixhelf embeds two separate, compressed, statically linked media executables.
They run as child processes through sealed Linux memory files. No executable,
codec package, shared library or runtime download is required on the host.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| FFmpeg | 8.1.3 | GPL-2.0-or-later in this configuration | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz |
| x264 | 31e19f92f00c7003fa115047ce50978bc98c3a0d | GPL-2.0-or-later | https://github.com/mirror/x264/tree/31e19f92f00c7003fa115047ce50978bc98c3a0d |
| dav1d | 1.5.3 | BSD-2-Clause | https://downloads.videolan.org/pub/videolan/dav1d/1.5.3/dav1d-1.5.3.tar.xz |
| zlib | 1.3.2 | Zlib | https://zlib.net/zlib-1.3.2.tar.xz |
| heic-rs | 0.1.1 | MIT OR Apache-2.0 | https://crates.io/crates/heic-rs/0.1.1 |
| UPX release compression | 5.2.1 | GPL-2.0-or-later with special exception for compressed executables | https://github.com/upx/upx/releases/tag/v5.2.1 |

`pixhelf --media-licenses` prints the embedded native component license texts.
The release's `pixhelf-media-sources.tar.xz` contains their checksum-pinned source
archives and the scripts needed to rebuild the static executables. Rust
dependencies and their checksums are recorded in `Cargo.lock`; `heic-rs` carries
its license texts in the published crate.

The build disables networking, hardware drivers, capture devices, FFplay,
documentation, unused containers, encoders and filters. It keeps software video
decoders (including dav1d for AV1), local file/pipe input, H.264/AAC output,
PNG thumbnails, and the scaling/rotation/audio filters the application uses.
Only 8-bit 4:2:0 H.264 encoding is built, matching Pixhelf's playback output.

HEIC container parsing, HEVC still-image pixel decoding, grid composition,
rotation and JPEG encoding use Rust. For files without container NCLX metadata,
the embedded FFprobe reads HEVC VUI colour from the primary tile; this compensates
for heic-rs 0.1.1's missing VUI handling. The original ICC profile is retained.

Linux x86_64/aarch64 releases use static musl. Execution requires Linux memfd
support and a mounted `/proc`, as provided by ordinary Linux hosts and Docker.
Media code is decompressed once on first use and held in sealed anonymous files;
it is never fetched at runtime or written to an executable disk cache. OpenList
and the optional Chinese-CLIP model/vocabulary remain external.

`pack-release.sh` compresses the whole release with UPX/LZMA after the media and
frontend assets are already Brotli-compressed. It keeps the unpacked Cargo output,
tests the packed artifact, and enforces a 25 MiB distribution size budget. UPX is
downloaded only during packaging; its small decompressor is part of the delivered
file. Full application checks run against the compressed file in the release job.
