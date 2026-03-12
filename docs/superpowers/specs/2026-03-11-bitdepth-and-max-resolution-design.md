# Design: Max Bit Depth & Max Resolution Features

## Overview

Add two new optional library variables to Tdarr-One-Flow:

1. **`v_max_bitdepth`** — Caps output H.265 bit depth (8, 10, or 12). Sources at or below the cap keep their native depth; sources above get downconverted. If unset, source bit depth is preserved.
2. **`v_max_resolution`** — Caps output resolution (480p, 576p, 720p, 1080p, 1440p, 4k). Sources at or below pass through unchanged; sources above are downscaled. Bitrate automatically switches to the target resolution's tier. If unset, source resolution is preserved.

## New Library Variables

| Variable | Type | Valid Values | Default (unset) |
|----------|------|-------------|-----------------|
| `v_max_bitdepth` | Optional | `8`, `10`, `12` | Preserve source bit depth |
| `v_max_resolution` | Optional | `480p`, `576p`, `720p`, `1080p`, `1440p`, `4k` | Preserve source resolution |

## Feature 1: Max Bit Depth

### New Plugin: `plugins/js_resolve_bitdepth.js`

**Runs:** In Flow 4, as an inline `customFunction` plugin, after `ffmpegCommandStart` and before `checkVideoResolution`.

**Logic:**

1. Read source video bit depth from `args.inputFileObj.mediaInfo` (video stream `BitDepth` field). Default to 8 if unreadable.
2. Read `v_max_bitdepth` from `args.userVariables.library.v_max_bitdepth`. If unset/empty, effective depth = source depth.
3. If source depth <= max depth: effective depth = source depth.
4. If source depth > max depth: effective depth = max depth.
5. Set encoder-specific flow variables based on effective depth:

| Effective Depth | `fl_pix_fmt_cpu` | `fl_pix_fmt_nvenc` | `fl_pix_fmt_qsv` | `fl_pix_fmt_vaapi` | `fl_pix_fmt_amf` | `fl_profile` |
|---|---|---|---|---|---|---|
| 8 | `yuv420p` | `yuv420p` | `nv12` | *(empty)* | `nv12` | `main` |
| 10 | `yuv420p10le` | `p010le` | `p010le` | *(empty)* | `p010le` | `main10` |
| 12 | `yuv420p12le` | `p010le` | `p012le` | *(empty)* | `p010le` | `main10` |

Note: NVENC and AMF cap at 10-bit hardware support. VAAPI auto-selects pixel format internally; only profile is set.

6. Compose per-encoder argument strings:

- `fl_bitdepth_args_cpu` = `-pix_fmt {pix_fmt} -profile:v {profile}`
- `fl_bitdepth_args_nvenc` = `-pix_fmt {pix_fmt} -profile:v {profile}`
- `fl_bitdepth_args_qsv` = `-pix_fmt {pix_fmt} -profile:v {profile}`
- `fl_bitdepth_args_vaapi` = `-profile:v {profile}` (no pix_fmt for VAAPI)
- `fl_bitdepth_args_amf` = `-pix_fmt {pix_fmt} -profile:v {profile}`

If effective depth is 8 (the implicit default for all current encoding), these strings are set to empty to maintain backward compatibility.

### Flow 4 Changes for Bit Depth

Each encoder branch's `ffmpegCommandCustomArguments` plugin appends the corresponding `fl_bitdepth_args_ENCODER` variable. For example, the NVENC 1080p branch changes from:

```
-b:v {{{args.variables.bitrate_1080p}}} -maxrate ... -rc vbr -rc-lookahead 32 {{{args.variables.user.fl_nvenc_quality}}} ...
```

to:

```
-b:v {{{args.variables.bitrate_effective}}} -maxrate ... -rc vbr -rc-lookahead 32 {{{args.variables.user.fl_nvenc_quality}}} ... {{{args.variables.fl_bitdepth_args_nvenc}}}
```

## Feature 2: Max Resolution

### New Plugin: `plugins/js_resolve_max_resolution.js`

**Runs:** In Flow 4, as an inline `customFunction` plugin, after `js_resolve_bitdepth` and before `checkVideoResolution`.

**Logic:**

1. Read source video dimensions from `args.inputFileObj.mediaInfo` (video stream `Width` and `Height`).
2. Read `v_max_resolution` from `args.userVariables.library.v_max_resolution`. If unset/empty, no scaling.
3. Map resolution labels to heights:

| Label | Max Height |
|-------|-----------|
| `480p` | 480 |
| `576p` | 576 |
| `720p` | 720 |
| `1080p` | 1080 |
| `1440p` | 1440 |
| `4k` | 2160 |

4. Compare source height to max height:
   - If unset or source height <= max height: no scaling needed
   - If source height > max height: scaling required

5. Determine effective resolution label for bitrate routing:
   - No scaling: use source resolution (as detected by `checkVideoResolution`)
   - Scaling: use the resolution label matching the max (e.g., `1080p`)

6. Build the combined `-vf` video filter chain:

| `do_deinterlace` | Scaling | `fl_video_filters` |
|---|---|---|
| false/unset | No | *(empty string)* |
| true | No | `-vf bwdif=1:0:1` |
| false/unset | Yes | `-vf scale=-2:{max_height}` |
| true | Yes | `-vf bwdif=1:0:1,scale=-2:{max_height}` |

7. Set "effective" bitrate variables by copying from the target resolution:
   - `bitrate_effective` = `bitrate_{effective_resolution}` (e.g., `bitrate_1080p`)
   - `maxrate_effective` = `maxrate_{effective_resolution}`
   - `bufsize_effective` = `bufsize_{effective_resolution}`
   - `cutoff_effective` = `cutoff_{effective_resolution}`

   When no scaling occurs, these are set per resolution branch as the flow routes through `checkVideoResolution` normally. The plugin sets a flag `fl_is_downscaling` (`true`/`false`) so the flow can determine whether to use effective variables.

### Flow 4 Changes for Max Resolution

1. **Replace the deinterlace plugin** (id: `ua0Y1mByE`, currently `-vf bwdif=1:0:1`) with a new `ffmpegCommandCustomArguments` that uses `{{{args.variables.fl_video_filters}}}`. This is only injected when the variable is non-empty (checked via `checkFlowVariable`).

2. **Update all encoder branch `ffmpegCommandCustomArguments`** to use `bitrate_effective`, `maxrate_effective`, `bufsize_effective` instead of resolution-specific variables like `bitrate_1080p`. This works for both scaled and non-scaled cases because `js_resolve_max_resolution` always populates the effective variables.

3. **Add flowEdges** to wire the new plugins into the existing graph between `ffmpegCommandStart` (id: `CRWm2FTTc`) and the existing `checkVideoResolution`/bitrate calculation step.

## Files Changed

### New Files

| File | Description |
|------|-------------|
| `plugins/js_resolve_bitdepth.js` | Bit depth detection, max cap logic, per-encoder pix_fmt/profile args |
| `plugins/js_resolve_max_resolution.js` | Resolution detection, max cap logic, scale filter chain, effective bitrate routing |

### Modified Files

| File | Changes |
|------|---------|
| `4 - Video.yml` | Add 2 customFunction plugins + checkFlowVariable gates; replace deinterlace plugin with combined filter plugin; update all encoder branches to use `bitrate_effective` and `fl_bitdepth_args_ENCODER`; add flowEdges |
| `readme.md` | Document `v_max_bitdepth` and `v_max_resolution` library variables |
| `CLAUDE.md` | Update with new variables and plugin descriptions |

### Unchanged Files

| File | Reason |
|------|--------|
| `1 - Input.yml` | Library variables are set by user in Tdarr UI, not in the flow |
| `2 - Prep.yml` | No changes needed |
| `3 - Audio.yml` | No changes needed |
| `5 - Save.yml` | No changes needed |
| `plugins/js_calculate_video_bitrate.js` | Still computes all resolution bitrates; new plugin picks the right one |
| `plugins/js_extract_video_bitrate.js` | Unchanged |
| `plugins/js_calculate_audio_bitrate.js` | Unchanged |
| `plugins/js_calculate_audio_bitrate_cutoff.js` | Unchanged |
| `plugins/js_extract_audio_is_lossless.js` | Unchanged |

## Backward Compatibility

Both features are fully backward-compatible:

- If `v_max_bitdepth` is unset: bit depth behavior is identical to current (implicit 8-bit pass-through, no `-pix_fmt` or `-profile:v` injected)
- If `v_max_resolution` is unset: no scaling, resolution routing and bitrate selection identical to current
- Existing library variable configurations continue to work without any changes

## Example: User's Target Configuration

```
v_max_resolution = 1080p
v_max_bitdepth = (unset)
```

- 4K 10-bit source -> downscaled to 1080p, 10-bit preserved, uses `bitrate_1080p`
- 1080p 8-bit source -> no changes, uses `bitrate_1080p`
- 720p 10-bit source -> no scaling (below cap), 10-bit preserved, uses `bitrate_720p`
- 4K 8-bit source -> downscaled to 1080p, 8-bit preserved, uses `bitrate_1080p`
