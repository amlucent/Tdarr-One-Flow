# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Tdarr-One-Flow** is a five-stage media transcoding workflow system for [Tdarr](https://home.tdarr.io/). It provides a single unified pipeline ("One Flow to Rule Them All") that handles diverse media using library-based variables rather than maintaining separate flows per library or quality tier.

There is no build system — the `.yml` files are Tdarr flow JSON templates imported directly into the Tdarr UI, and the `plugins/` are JavaScript plugins installed into Tdarr's plugin system.

## Architecture

### Five-Stage Pipeline

Each stage is a separate Tdarr flow imported via its `.yml` file (JSON format despite extension):

| File | Stage | Purpose |
|------|-------|---------|
| `1 - Input.yml` | Input | Entry point — defines all flow variables, tags files for special processing (deinterlace, lossless detection) |
| `2 - Prep.yml` | Prep | Standardizes container to MKV, removes problematic codecs/streams |
| `3 - Audio.yml` | Audio | Detects lossless audio, strips unwanted tracks, encodes to Opus |
| `4 - Video.yml` | Video | Main transcoding — resolution detection, bitrate/CQ calculations, encoder branching |
| `5 - Save.yml` | Save | Final validation, moves to `output_dir_done` or `output_dir_review`, cleans source if not in test_mode |

Flows chain together via `goToFlow` plugin references. Data passes between stages through Tdarr's flow variable and file metadata systems.

### JavaScript Plugins (`plugins/`)

Custom logic used within the flows:

- `js_calculate_video_bitrate.js` — Computes `maxrate` (2× target) and `bufsize` (4× target) per resolution, with a 115% cutoff
- `js_calculate_audio_bitrate.js` — Multiplies per-channel bitrate by actual channel count
- `js_calculate_audio_bitrate_cutoff.js` — Same as above but for minimum-bitrate thresholds
- `js_extract_video_bitrate.js` — Reads source video bitrate for encoding decisions
- `js_extract_audio_is_lossless.js` — Detects 40+ lossless codec types (FLAC, PCM variants, ALAC, DCA, etc.)
- `js_resolve_bitdepth.js` — Detects source bit depth, resolves against `v_force_bitdepth` / `v_min_bitdepth` / `v_max_bitdepth` (HDR never below 10-bit), sets per-encoder `-pix_fmt` and `-profile:v` arguments
- `js_resolve_max_resolution.js` — Detects source resolution, resolves against `v_max_resolution`, builds combined `-vf` filter chain (scale + deinterlace), sets effective bitrate variables

### Encoder Support

Flow 1 sets encoder-specific parameters. Supported encoders: `nvenc` (NVIDIA), `qsv` (Intel QuickSync), `cpu` (libx265), `vaapi`, `amf`. Reference docs in `ffmpeg_docs/`.

## Deployment

1. Import each of the 5 `.yml` files into Tdarr as separate flows.
2. Install the 5 plugins from `plugins/` into Tdarr.
3. Create a Tdarr library and define the required library variables (see below).

## Required Library Variables

| Variable | Description |
|----------|-------------|
| `test_mode` | `true`/`false` — if true, skips source file deletion |
| `output_dir_done` | Path for successfully transcoded files |
| `output_dir_review` | Path for files needing manual review |
| `v_cq` | CQ quality fallback (0–51) |
| `bitrate_480p/576p/720p/1080p/1440p/4k/4k_hdr` | Target bitrates per resolution |
| `do_audio_clean` | `true`/`false` — strip unwanted audio tracks |
| `do_audio_encode` | `true`/`false` — encode audio to Opus |
| `bitrate_audio` | Per-channel audio bitrate |
| `bitrate_audio_cutoff` | Minimum audio bitrate threshold |
| `audio_language` | Comma-separated language codes (e.g. `eng,und`) |

### Optional Variables

| Variable | Description |
|----------|-------------|
| `disable_vbr` | Skip VBR encoding attempt |
| `disable_cq` | Skip CQ encoding attempt |
| `disable_video` | Skip all video processing |
| `do_hevc` | Also process already-HEVC files |
| `encoder` | Override auto-detected encoder |
| `v_max_bitdepth` | Maximum output bit depth (preserves source if unset) |
| `v_min_bitdepth` | Minimum output bit depth for files the flow encodes anyway, e.g. `10` raises 8-bit sources to 10-bit; never causes an encode on its own (skipped/copied video is untouched) |
| `v_force_bitdepth` | Fixed output bit depth for encoded files, overrides min/max. HDR sources are never encoded below 10-bit |
| `v_max_resolution` | Maximum output frame size, width and height (`1080p` = fit inside 1920x1080); preserves source if unset |
| `save_mode` | `replace` — replace the library file in place instead of moving to `output_dir_done` (for libraries pointed at an existing media library) |
| `sonarr_url` | With `save_mode=replace`: Sonarr base URL, e.g. `http://sonarr.luc3nt-media.svc.cluster.local:8989` |
| `sonarr_api_key` | With `save_mode=replace`: Sonarr API key used to rescan the series and rename the replaced file |
| `radarr_url` | With `save_mode=replace`: Radarr base URL, e.g. `http://radarr:7878` (movie libraries) |
| `radarr_api_key` | With `save_mode=replace`: Radarr API key used to rescan the movie and rename the replaced file. If both apps are set, the one whose series/movie folder contains the file is used |
| `low_bitrate_skip_ratio` | With `save_mode=replace`: skip encoding when the source video bitrate is below this fraction of the resolution's target (default `0.9`) |
| `protect_hardlinks_root` | The default-track fix never edits an original in place if it lives under, or is hard-linked into, this directory (default `/media/downloads`, so seeding torrents are untouched) |
| `force_downscale` | `true` — with `v_max_resolution` (any library), the Input skip gate encodes HEVC/AV1 sources larger than the cap (sets `oversize_encode`, which lets the Video flow past its `do_hevc` and AV1 skips). Off by default so libraries whose 4K copies should be kept are never downscaled |
| `default_track_language` | Preferred language for the default-track fix: comma-separated ISO 639-1/639-2 codes (default `eng,en`; each code is expanded to its equivalents, e.g. `es` also matches `spa`). `off` disables the fix |

## Default Tracks

Both the Save flow (before saving) and the Input flow (files the replace-mode skip gate doesn't encode) set default track flags with `mkvpropedit`, header-only: the best non-commentary audio in `default_track_language` becomes the default with no default subtitle (forced flags are kept); when the default audio is explicitly in another language, the full (non-SDH) subtitle in the preferred language becomes the default. It has to run after the last ffmpeg step, because ffmpeg's mkv muxer marks forced subtitles as default on a plain `-c copy` remux. Tracks are addressed by track number (`track:@N`): 64-bit track UIDs lose precision in JavaScript's `JSON.parse`.

## Max Resolution

`js_resolve_max_resolution.js` fits sources inside the cap's 16:9 box (`scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2`), so a source is scaled when it is taller than the cap or wider than its 16:9 width (3840x1604 at a 1080p cap becomes 1920x802).

## Known Limitations

- Dolby Vision video is never re-encoded: the Input skip gate sets `dv_skip_video` and the Video flow sends the file straight to Save with the video stream-copied (audio cleanup and default tracks still run).
- Does **not** support re-encoding HDR10+ content.
- 720p `.ts` files may produce unexpected bitrates.
- Tdarr may cache old variable values after updates — clearing the library cache resolves this.
