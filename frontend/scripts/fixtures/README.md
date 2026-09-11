The generated `live-photo.jpg` / `live-photo.mp4` pair contains a green poster
and an H.264 animation. `live-photo-hevc.mov` is an HEVC fixture with silent AAC
audio, also used by the Rust response tests. No test requires FFmpeg.

## Offline browser checks

Run from `frontend` after installing Playwright Chromium or WebKit and its runtime
dependencies. All responses come from browser routes; no app or HTTP server starts.

```sh
npm run build
npm run live-photo-interaction-check
npm run live-photo-check
```

- `live-photo-interaction-check` mounts the real components and checks touch
  feedback, playback/opening order, blocked/interrupted playback, buffered stall
  recovery, decoder cleanup and unsupported-video fallback.
- `live-photo-check` (also `live-photo-app-check`) checks the built application at
  desktop and phone sizes. Screenshot pixels must show a moving picture; playback
  clocks alone cannot pass. It covers loading indicators, opening during loading
  or after playback, A → B → A interaction, viewer navigation and click/tap replay.
- `live-photo-webkit-check` runs the same application checks in WebKit.

Both suites share browser setup, sample loading and original-byte Range responses
in `../live-photo-fixture.mjs`. Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `PIXHELF_TEST_ENGINE=webkit` | Use WebKit in either suite. |
| `PIXHELF_LIVE_SAMPLE` | Extensionless JPEG/MOV pair or Samsung SEF JPEG path. |
| `PIXHELF_TEST_WIDTH=390` | Limit app checks to one viewport width. |
| `PIXHELF_TEST_NATIVE_VIDEO_BLACK=1` | Black out the native viewer video to verify canvas playback. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Override the installed Chromium executable. |

For example, set `PIXHELF_LIVE_SAMPLE` to
`/path/to/Live/Apple/2023-12-27_12-30-56` or
`/path/to/Live/motionphoto/samsung-one-ui-6`. The browser must decode the original
codec. Chromium replay checks require no new media requests for the retained
player; WebKit checks also verify orientation after replacing its decoder.

## Original bytes and caching

From the repository root:

```sh
PIXHELF_LIVE_SAMPLES="$PWD/pic/Live" cargo test --locked --offline original_live_samples_bypass_old_cache_and_match_source_bytes -- --ignored --nocapture
```

This checks full and ranged Apple/Samsung responses against original HEVC bytes,
rejects legacy preview URLs/validators, and verifies bodyless 304 revalidation.
The regular Rust tests cover pairing, XMP/SEF extraction and authentication before
cached/range responses, including logout. Browser routing disables HTTP caching,
so browser checks verify playback and player reuse; Rust checks verify response
caching. `PIXHELF_LIVE_SAMPLES` is the sample directory for the Rust audit;
`PIXHELF_LIVE_SAMPLE` selects one file for the browser checks.

`npm run album-hierarchy-check` checks folder navigation using an in-memory album
list, also without a server.
