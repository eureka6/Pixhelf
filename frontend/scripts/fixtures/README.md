# Shared media fixtures

These small generated media files are used by Rust tests and the standalone
release check. Keep them in Git: Rust tests compile some of them with
`include_bytes!`.

- `live-photo.jpg` / `live-photo.mp4`: green poster and H.264 animation.
- `live-photo-hevc.mov`: HEVC video with silent AAC audio.
- `live-photo.heic`: generated 120×90 tiled HEIF image; contains no personal metadata.
- `heif-vui.heic`: HEIF color information fixture.
- `portrait-video.mp4`: the H.264 clip with a 90° display rotation.
- `animated.gif` / `av1.webm`: animated image and AV1 playback fixtures.

To regenerate the portrait clip with FFmpeg 7.1:

```sh
ffmpeg -display_rotation 90 -i live-photo.mp4 -c copy portrait-video.mp4
```

The HEIF image was encoded with libheif 1.19.8 from a 2×2 grid of red, green,
blue and yellow 64×64 tiles:

```sh
heif-enc -q 90 -T tile-0-0.png --tiled-image-width 120 --tiled-image-height 90 -o live-photo.heic
```

Browser checks are maintained locally in `frontend/.local-tests/`, which is
excluded from Git. Their installation, groups and commands are documented in
[the development guide](../../../docs/DEVELOPMENT.md#验证).
