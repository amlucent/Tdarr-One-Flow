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
- `js_resolve_bitdepth.js` — Detects source bit depth, resolves against `v_max_bitdepth`, sets per-encoder `-pix_fmt` and `-profile:v` arguments
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
| `v_max_resolution` | Maximum output resolution (preserves source if unset) |

## Known Limitations

- Does **not** support Dolby Vision (DV) or HDR10+ content.
- 720p `.ts` files may produce unexpected bitrates.
- Tdarr may cache old variable values after updates — clearing the library cache resolves this.
