# Max Bit Depth & Max Resolution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two optional library variables (`v_max_bitdepth`, `v_max_resolution`) that cap output bit depth and resolution during H.265 transcoding.

**Architecture:** Two new JavaScript plugins (`js_resolve_bitdepth.js`, `js_resolve_max_resolution.js`) inserted into Flow 4's command chain between `ffmpegCommandStart` and encoder detection. They set flow variables consumed by existing encoder branches. All 35 encoder branch plugins in `4 - Video.yml` are updated to use unified `bitrate_effective` variables and per-encoder `fl_bitdepth_args_*` strings.

**Tech Stack:** Tdarr flow JSON, JavaScript (Tdarr plugin API), FFmpeg CLI arguments

**Spec:** `docs/superpowers/specs/2026-03-11-bitdepth-and-max-resolution-design.md`

**Known limitation:** When `v_max_resolution` triggers downscaling (e.g., 4K to 1080p), a source file whose bitrate is below the *source* resolution's cutoff (`cutoff_4k`) may skip transcoding entirely — even though downscaling is desired. This is because `js_extract_video_bitrate.js` runs per-resolution-branch and checks the source's cutoff. A follow-up change could replace `cutoff_*` with `cutoff_effective` in the bitrate check plugins, or add a `forceTranscode` bypass when scaling is active. For now, this affects only low-bitrate files that happen to already be below the source resolution's encoding threshold.

---

## Chunk 1: JavaScript Plugins

### Task 1: Create `js_resolve_bitdepth.js`

**Files:**
- Create: `plugins/js_resolve_bitdepth.js`
- Reference: `plugins/js_calculate_video_bitrate.js` (for pattern)

- [ ] **Step 1: Create the plugin file**

```javascript
module.exports = async (args) => {
  let variables = args.variables || {};

  // 1. Read source bit depth from mediaInfo
  let sourceBitDepth = 8; // default
  try {
    const videoStream = (args.inputFileObj.mediaInfo || {}).streams
      ? args.inputFileObj.mediaInfo.streams.find(s => s.codecType === 'video')
      : null;
    if (videoStream && videoStream.BitDepth) {
      sourceBitDepth = parseInt(videoStream.BitDepth, 10);
    }
    if (isNaN(sourceBitDepth) || sourceBitDepth <= 0) sourceBitDepth = 8;
  } catch (e) {
    sourceBitDepth = 8;
  }

  // 2. Read v_max_bitdepth from library variables
  const rawMax = (args.userVariables && args.userVariables.library)
    ? args.userVariables.library.v_max_bitdepth
    : undefined;

  let maxBitDepth = null;
  if (rawMax !== undefined && rawMax !== null && String(rawMax).trim() !== '') {
    maxBitDepth = parseInt(String(rawMax).trim(), 10);
    if (![8, 10, 12].includes(maxBitDepth)) {
      throw new Error(
        `Invalid v_max_bitdepth value '${rawMax}'. Must be 8, 10, or 12.`
      );
    }
  }

  // 3. Resolve effective bit depth
  let effectiveDepth;
  if (maxBitDepth === null) {
    effectiveDepth = sourceBitDepth;
    args.jobLog(`Bit depth: source=${sourceBitDepth}, v_max_bitdepth unset, preserving source depth`);
  } else if (sourceBitDepth <= maxBitDepth) {
    effectiveDepth = sourceBitDepth;
    args.jobLog(`Bit depth: source=${sourceBitDepth}, max=${maxBitDepth}, preserving source (at or below cap)`);
  } else {
    effectiveDepth = maxBitDepth;
    args.jobLog(`Bit depth: source=${sourceBitDepth}, max=${maxBitDepth}, capping to ${maxBitDepth}`);
  }

  // 4. Pixel format and profile mappings per encoder
  const pixFmtMap = {
    8:  { cpu: 'yuv420p',     nvenc: 'yuv420p', qsv: 'nv12',   vaapi: '', amf: 'nv12' },
    10: { cpu: 'yuv420p10le', nvenc: 'p010le',  qsv: 'p010le', vaapi: '', amf: 'p010le' },
    12: { cpu: 'yuv420p12le', nvenc: 'p010le',  qsv: 'p012le', vaapi: '', amf: 'p010le' },
  };

  const profileMap = {
    8:  { cpu: 'main',   other: 'main' },
    10: { cpu: 'main10', other: 'main10' },
    12: { cpu: 'main12', other: 'main10' },
  };

  // Clamp to nearest supported depth for lookup
  const lookupDepth = effectiveDepth >= 12 ? 12 : (effectiveDepth >= 10 ? 10 : 8);
  const pix = pixFmtMap[lookupDepth];
  const prof = profileMap[lookupDepth];

  // 5. Log hardware limitations for 12-bit
  if (lookupDepth === 12) {
    args.jobLog('Warning: NVENC and AMF do not support 12-bit; output will be 10-bit on those encoders.');
  }

  // 6. Compose per-encoder argument strings
  // For 8-bit (the current implicit default), set to empty for backward compatibility
  if (lookupDepth === 8) {
    variables.fl_bitdepth_args_cpu = '';
    variables.fl_bitdepth_args_nvenc = '';
    variables.fl_bitdepth_args_qsv = '';
    variables.fl_bitdepth_args_vaapi = '';
    variables.fl_bitdepth_args_amf = '';
  } else {
    variables.fl_bitdepth_args_cpu = `-pix_fmt ${pix.cpu} -profile:v ${prof.cpu}`;
    variables.fl_bitdepth_args_nvenc = `-pix_fmt ${pix.nvenc} -profile:v ${prof.other}`;
    variables.fl_bitdepth_args_qsv = `-pix_fmt ${pix.qsv} -profile:v ${prof.other}`;
    variables.fl_bitdepth_args_vaapi = `-profile:v ${prof.other}`;
    variables.fl_bitdepth_args_amf = `-pix_fmt ${pix.amf} -profile:v ${prof.other}`;
  }

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 1,
    variables: variables,
  };
};
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `node -c plugins/js_resolve_bitdepth.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add plugins/js_resolve_bitdepth.js
git commit -m "feat: add js_resolve_bitdepth plugin for max bit depth control"
```

---

### Task 2: Create `js_resolve_max_resolution.js`

**Files:**
- Create: `plugins/js_resolve_max_resolution.js`
- Reference: `plugins/js_calculate_video_bitrate.js` (for variable access pattern)

- [ ] **Step 1: Create the plugin file**

```javascript
module.exports = async (args) => {
  let variables = args.variables || {};

  // Resolution label to height mapping
  const resolutionMap = {
    '480p': 480,
    '576p': 576,
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4k': 2160,
  };

  // Height to resolution label (for source detection)
  const heightToLabel = [
    { maxHeight: 480, label: '480p' },
    { maxHeight: 576, label: '576p' },
    { maxHeight: 720, label: '720p' },
    { maxHeight: 1080, label: '1080p' },
    { maxHeight: 1440, label: '1440p' },
    { maxHeight: Infinity, label: '4k' },
  ];

  // 1. Read source dimensions from mediaInfo
  let sourceHeight = 0;
  try {
    const videoStream = (args.inputFileObj.mediaInfo || {}).streams
      ? args.inputFileObj.mediaInfo.streams.find(s => s.codecType === 'video')
      : null;
    if (videoStream && videoStream.Height) {
      sourceHeight = parseInt(videoStream.Height, 10);
    }
  } catch (e) {
    sourceHeight = 0;
  }

  // 2. Detect source resolution label
  if (sourceHeight === 0) {
    args.jobLog('Warning: could not read source video height from mediaInfo, defaulting to 1080p');
  }
  let sourceLabel = '1080p'; // fallback
  for (const entry of heightToLabel) {
    if (sourceHeight <= entry.maxHeight) {
      sourceLabel = entry.label;
      break;
    }
  }

  // 3. Read v_max_resolution from library variables
  const rawMax = (args.userVariables && args.userVariables.library)
    ? args.userVariables.library.v_max_resolution
    : undefined;

  let maxHeight = null;
  let maxLabel = null;
  if (rawMax !== undefined && rawMax !== null && String(rawMax).trim() !== '') {
    const cleaned = String(rawMax).trim().toLowerCase();
    if (!resolutionMap.hasOwnProperty(cleaned)) {
      throw new Error(
        `Invalid v_max_resolution value '${rawMax}'. Must be one of: 480p, 576p, 720p, 1080p, 1440p, 4k.`
      );
    }
    maxHeight = resolutionMap[cleaned];
    maxLabel = cleaned;
  }

  // 4. Determine if scaling is needed
  let needsScaling = false;
  let effectiveLabel = sourceLabel;
  let scaleHeight = null;

  if (maxHeight !== null && sourceHeight > maxHeight) {
    needsScaling = true;
    effectiveLabel = maxLabel;
    scaleHeight = maxHeight;
    args.jobLog(`Resolution: source=${sourceHeight}p (${sourceLabel}), max=${maxLabel}, downscaling to ${maxLabel}`);
  } else if (maxHeight !== null) {
    args.jobLog(`Resolution: source=${sourceHeight}p (${sourceLabel}), max=${maxLabel}, no scaling needed (at or below cap)`);
  } else {
    args.jobLog(`Resolution: source=${sourceHeight}p (${sourceLabel}), v_max_resolution unset, preserving source resolution`);
  }

  // 5. Build combined -vf video filter chain
  const doDeinterlace = variables.user && variables.user.do_deinterlace === 'true';
  const filters = [];
  if (doDeinterlace) {
    filters.push('bwdif=1:0:1');
  }
  if (needsScaling) {
    filters.push(`scale=-2:${scaleHeight}`);
  }

  if (filters.length > 0) {
    variables.fl_video_filters = `-vf ${filters.join(',')}`;
  } else {
    variables.fl_video_filters = '';
  }

  // 6. Handle 4K HDR bitrate routing
  const isHdr = variables.is_hdr === 'true';
  let bitrateLabel = effectiveLabel;

  if (isHdr && sourceHeight >= 2160) {
    if (maxHeight === null || maxHeight >= 2160) {
      // 4K HDR source, no downscaling or max is 4k: use 4k_hdr bitrates
      bitrateLabel = '4k_hdr';
      args.jobLog(`HDR detected at 4K, using bitrate_4k_hdr`);
    } else {
      // Downscaling HDR below 4K: HDR distinction no longer relevant
      args.jobLog(`HDR detected but downscaling to ${effectiveLabel}, using bitrate_${effectiveLabel}`);
    }
  }

  // 7. Always set effective bitrate variables
  // Read from flow variables (set by js_calculate_video_bitrate), not library variables
  variables.bitrate_effective = variables[`bitrate_${bitrateLabel}`] || '';
  variables.maxrate_effective = variables[`maxrate_${bitrateLabel}`] || '';
  variables.bufsize_effective = variables[`bufsize_${bitrateLabel}`] || '';
  variables.cutoff_effective = variables[`cutoff_${bitrateLabel}`] || '';

  args.jobLog(`Effective bitrate tier: ${bitrateLabel} -> bitrate=${variables.bitrate_effective}, maxrate=${variables.maxrate_effective}`);

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 1,
    variables: variables,
  };
};
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `node -c plugins/js_resolve_max_resolution.js`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add plugins/js_resolve_max_resolution.js
git commit -m "feat: add js_resolve_max_resolution plugin for max resolution and filter chain"
```

---

## Chunk 2: Flow 4 Modifications — Plugin Insertion & Edge Rewiring

### Task 3: Add inline customFunction plugins to `4 - Video.yml`

This task adds the two new `customFunction` plugin nodes to `4 - Video.yml`'s `flowPlugins` array and rewires `flowEdges` to insert them between `ffmpegCommandStart` and encoder detection.

**Files:**
- Modify: `4 - Video.yml`

**Important context:** `4 - Video.yml` is a JSON file (despite `.yml` extension). It has two top-level arrays:
- `flowPlugins` — array of plugin node objects
- `flowEdges` — array of edge connection objects

The inline `customFunction` plugin embeds JavaScript code as a string in the `inputsDB.code` field. The standalone `.js` files in `plugins/` serve as the readable source; the inline versions in the flow are what Tdarr actually executes.

- [ ] **Step 1: Add the `js_resolve_bitdepth` customFunction plugin to `flowPlugins`**

Add the following object to the `flowPlugins` array (position after `ffmpegCommandStart`). The `code` field must be the content of `plugins/js_resolve_bitdepth.js` as a single-line JSON-escaped string.

New plugin node:
```json
{
  "name": "Video - Resolve Bit Depth 🎨",
  "sourceRepo": "Community",
  "pluginName": "customFunction",
  "version": "1.0.0",
  "inputsDB": {
    "code": "<contents of plugins/js_resolve_bitdepth.js, JSON-escaped into a single string>"
  },
  "id": "rBitDepth1",
  "position": {
    "x": 1290.0,
    "y": -2900.0
  },
  "fpEnabled": true
}
```

- [ ] **Step 2: Add the `js_resolve_max_resolution` customFunction plugin to `flowPlugins`**

New plugin node:
```json
{
  "name": "Video - Resolve Max Resolution 📐",
  "sourceRepo": "Community",
  "pluginName": "customFunction",
  "version": "1.0.0",
  "inputsDB": {
    "code": "<contents of plugins/js_resolve_max_resolution.js, JSON-escaped into a single string>"
  },
  "id": "rMaxRes1",
  "position": {
    "x": 1290.0,
    "y": -2830.0
  },
  "fpEnabled": true
}
```

- [ ] **Step 3: Rewire flowEdges**

Remove the existing edge from `ffmpegCommandStart` to encoder check:
```json
// REMOVE this edge:
{
  "source": "CRWm2FTTc",
  "sourceHandle": "1",
  "target": "2YrneglXQ",
  "targetHandle": null,
  "id": "iOzNJfG0O"
}
```

Add three new edges:
```json
// ffmpegCommandStart -> js_resolve_bitdepth
{
  "source": "CRWm2FTTc",
  "sourceHandle": "1",
  "target": "rBitDepth1",
  "targetHandle": null,
  "id": "eBitDepth1"
},
// js_resolve_bitdepth -> js_resolve_max_resolution
{
  "source": "rBitDepth1",
  "sourceHandle": "1",
  "target": "rMaxRes1",
  "targetHandle": null,
  "id": "eMaxRes1"
},
// js_resolve_max_resolution -> encoder check nvenc
{
  "source": "rMaxRes1",
  "sourceHandle": "1",
  "target": "2YrneglXQ",
  "targetHandle": null,
  "id": "eMaxRes2"
}
```

Also add error edges for the new plugins (routing to the existing error handler `ykLLIDQ7U`):
```json
{
  "source": "rBitDepth1",
  "sourceHandle": "err1",
  "target": "ykLLIDQ7U",
  "targetHandle": null,
  "id": "eBitDepthErr"
},
{
  "source": "rMaxRes1",
  "sourceHandle": "err1",
  "target": "ykLLIDQ7U",
  "targetHandle": null,
  "id": "eMaxResErr"
}
```

- [ ] **Step 4: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('4 - Video.yml', 'utf8'))"`
Expected: no errors (valid JSON)

- [ ] **Step 5: Commit**

```bash
git add "4 - Video.yml"
git commit -m "feat: insert bitdepth and max resolution plugins into Flow 4 pipeline"
```

---

## Chunk 3: Flow 4 Modifications — Replace Deinterlace & Update Video Filters

### Task 4: Replace standalone deinterlace with combined video filter plugin

**Files:**
- Modify: `4 - Video.yml`

The existing deinterlace flow is:
1. `ssynyR8HM` -> `4R6zCBQDN` (checkFlowVariable for `do_deinterlace`)
2. If true (handle 1): `4R6zCBQDN` -> `ua0Y1mByE` (deinterlace `-vf bwdif=1:0:1`)
3. If false (handle 2): `4R6zCBQDN` -> `ab-Oposf1` (skip comment)

Since `js_resolve_max_resolution` now builds the complete `-vf` filter chain in `fl_video_filters`, we replace this with:
1. `ssynyR8HM` -> new `checkFlowVariable` for `fl_video_filters` being non-empty
2. If non-empty (handle 1): -> new `ffmpegCommandCustomArguments` using `{{{args.variables.fl_video_filters}}}`
3. If empty (handle 2): -> `ab-Oposf1` (existing skip comment)

**Note:** The spec says to remove the deinterlace gate and plugin. This plan instead repurposes them in-place, achieving identical behavior with less churn.

- [ ] **Step 1: Replace the deinterlace `checkFlowVariable` plugin**

Update plugin `4R6zCBQDN` to check `fl_video_filters` instead of `do_deinterlace`:

Change `inputsDB` from:
```json
{
  "variable": "{{{args.variables.user.do_deinterlace}}}",
  "value": "true"
}
```
to:
```json
{
  "variable": "{{{args.variables.fl_video_filters}}}",
  "value": ""
}
```

**Important:** The `checkFlowVariable` plugin outputs handle 1 when the variable **matches** the value, and handle 2 when it **doesn't match**. We check if `fl_video_filters` equals empty string:
- Handle 1 (matches empty) = no filters, skip to `ab-Oposf1`
- Handle 2 (doesn't match empty) = has filters, apply them

So we also need to swap the edge targets:
- Edge `JeFmbFLzw` (currently handle 1 -> `ua0Y1mByE`): change to handle 2
- Edge `98proMD4i` (currently handle 2 -> `ab-Oposf1`): change to handle 1

Update the plugin name:
```
"name": "Video - Check fl_video_filters 🔍"
```

- [ ] **Step 2: Update the deinterlace plugin to use `fl_video_filters`**

Update plugin `ua0Y1mByE` from:
```json
{
  "outputArguments": "-vf bwdif=1:0:1"
}
```
to:
```json
{
  "outputArguments": "{{{args.variables.fl_video_filters}}}"
}
```

Update its name:
```
"name": "Video - Apply Video Filters (scale/deinterlace) 📼"
```

- [ ] **Step 3: Swap the edge sourceHandles for the checkFlowVariable**

Edge `JeFmbFLzw`: change `sourceHandle` from `"1"` to `"2"` (non-empty filters -> apply them)
Edge `98proMD4i`: change `sourceHandle` from `"2"` to `"1"` (empty filters -> skip)

- [ ] **Step 4: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('4 - Video.yml', 'utf8'))"`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add "4 - Video.yml"
git commit -m "feat: replace deinterlace plugin with combined video filter chain"
```

---

## Chunk 4: Flow 4 Modifications — Update All Encoder Branches

### Task 5: Update VBR encoder branches to use `bitrate_effective`

**Files:**
- Modify: `4 - Video.yml`

All 35 VBR encoder branch `ffmpegCommandCustomArguments` plugins need two changes:
1. Replace resolution-specific bitrate variables with `bitrate_effective`, `maxrate_effective`, `bufsize_effective`
2. Append `{{{args.variables.fl_bitdepth_args_ENCODER}}}` to the output arguments

**The 5 encoder patterns with their bitdepth arg variable:**

| Encoder | Bitdepth variable |
|---------|------------------|
| cpu (libx265) | `fl_bitdepth_args_cpu` |
| nvenc | `fl_bitdepth_args_nvenc` |
| qsv | `fl_bitdepth_args_qsv` |
| vaapi | `fl_bitdepth_args_vaapi` |
| amf | `fl_bitdepth_args_amf` |

- [ ] **Step 1: Update all CPU (libx265) encoder branches (7 plugins)**

Plugin IDs: `mCvQdZzsB` (480p), `OPks33RLb` (576p), `qQ0b9XzII` (720p), `bP8F0AKuF` (1080p), `i0rxcp9di` (1440p), `_XU-XYw50` (4k), `JKJlbvnba` (4k_hdr)

For each, replace `outputArguments`. Example for 480p (`mCvQdZzsB`):

From:
```
-b:v {{{args.variables.bitrate_480p}}} -maxrate {{{args.variables.maxrate_480p}}} -bufsize {{{args.variables.bufsize_480p}}} -x265-params {{{args.variables.user.fl_cpu_quality}}} {{{args.variables.user.fl_cpu_main}}}
```
To:
```
-b:v {{{args.variables.bitrate_effective}}} -maxrate {{{args.variables.maxrate_effective}}} -bufsize {{{args.variables.bufsize_effective}}} -x265-params {{{args.variables.user.fl_cpu_quality}}} {{{args.variables.user.fl_cpu_main}}} {{{args.variables.fl_bitdepth_args_cpu}}}
```

Apply the same pattern to all 7 CPU plugins — replace `bitrate_XXX` with `bitrate_effective`, `maxrate_XXX` with `maxrate_effective`, `bufsize_XXX` with `bufsize_effective`, and append ` {{{args.variables.fl_bitdepth_args_cpu}}}`.

- [ ] **Step 2: Update all NVENC encoder branches (7 plugins)**

Plugin IDs: `R2VJtivho` (480p), `YFPx-BNVD` (576p), `jF0eYot7m` (720p), `kxs7bHIlt` (1080p), `Nh35eGjUX` (1440p), `CyFFBF_am` (4k), `Q5gU7QKV5` (4k_hdr)

For each, replace resolution-specific bitrates with effective and append `{{{args.variables.fl_bitdepth_args_nvenc}}}`.

Example for 480p (`R2VJtivho`):

From:
```
-b:v {{{args.variables.bitrate_480p}}} -maxrate {{{args.variables.maxrate_480p}}} -bufsize {{{args.variables.bufsize_480p}}} -rc vbr -rc-lookahead 32 {{{args.variables.user.fl_nvenc_quality}}} {{{args.variables.user.fl_nvenc_b-frames}}} {{{args.variables.user.fl_nvenc_main}}}
```
To:
```
-b:v {{{args.variables.bitrate_effective}}} -maxrate {{{args.variables.maxrate_effective}}} -bufsize {{{args.variables.bufsize_effective}}} -rc vbr -rc-lookahead 32 {{{args.variables.user.fl_nvenc_quality}}} {{{args.variables.user.fl_nvenc_b-frames}}} {{{args.variables.user.fl_nvenc_main}}} {{{args.variables.fl_bitdepth_args_nvenc}}}
```

- [ ] **Step 3: Update all QSV encoder branches (7 plugins)**

Plugin IDs: `6moQeYa1y` (480p), `0sFJmc0RB` (576p), `mKkyYfkYi` (720p), `oOdv9DHua` (1080p), `JarNw2y9A` (1440p), `1pSJgPS-X` (4k), `ZUxngNSgz` (4k_hdr)

For each, replace resolution-specific bitrates with effective and append `{{{args.variables.fl_bitdepth_args_qsv}}}`.

- [ ] **Step 4: Update all VAAPI encoder branches (7 plugins)**

Plugin IDs: `FXjOUwNnm` (480p), `-aH5ghKn-` (576p), `Y7odARg5_` (720p), `wP36xGdtP` (1080p), `FbfiCa8Cs` (1440p), `hpUyi4HWm` (4k), `ZoN_EaW6o` (4k_hdr)

For each, replace resolution-specific bitrates with effective and append `{{{args.variables.fl_bitdepth_args_vaapi}}}`.

- [ ] **Step 5: Update all AMF encoder branches (7 plugins)**

Plugin IDs: `V1oGd7yMZ` (480p), `WjWg-Jrim` (576p), `Ljo5hpC1V` (720p), `L2LEwDt5X` (1080p), `3DRBvliTU` (1440p), `jxU0G0Zzi` (4k), `s27no-NeE` (4k_hdr)

For each, replace resolution-specific bitrates with effective and append `{{{args.variables.fl_bitdepth_args_amf}}}`.

- [ ] **Step 6: Update CQ encoder branches (3 plugins)**

These don't have bitrate variables but need bitdepth args appended.

Plugin `iZuCFsZ2C` (cq cpu): append ` {{{args.variables.fl_bitdepth_args_cpu}}}`
Plugin `AVl91JYPc` (cq qsv): append ` {{{args.variables.fl_bitdepth_args_qsv}}}`
Plugin `V-qrLnamM` (cq nvenc): append ` {{{args.variables.fl_bitdepth_args_nvenc}}}`

CQ CPU (`iZuCFsZ2C`) from:
```
-crf {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_cpu_quality}}} {{{args.variables.user.fl_cpu_main}}}
```
To:
```
-crf {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_cpu_quality}}} {{{args.variables.user.fl_cpu_main}}} {{{args.variables.fl_bitdepth_args_cpu}}}
```

CQ QSV (`AVl91JYPc`) from:
```
-global_quality {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_qsv_quality}}} {{{args.variables.user.fl_qsv_main}}}
```
To:
```
-global_quality {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_qsv_quality}}} {{{args.variables.user.fl_qsv_main}}} {{{args.variables.fl_bitdepth_args_qsv}}}
```

CQ NVENC (`V-qrLnamM`) from:
```
-cq {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_nvenc_quality}}} {{{args.variables.user.fl_nvenc_b-frames}}} {{{args.variables.user.fl_nvenc_main}}}
```
To:
```
-cq {{{args.userVariables.library.v_cq}}} {{{args.variables.user.fl_nvenc_quality}}} {{{args.variables.user.fl_nvenc_b-frames}}} {{{args.variables.user.fl_nvenc_main}}} {{{args.variables.fl_bitdepth_args_nvenc}}}
```

- [ ] **Step 7: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('4 - Video.yml', 'utf8'))"`
Expected: no errors

- [ ] **Step 8: Verify all encoder branches were updated**

Run: `grep -c 'bitrate_effective' '4 - Video.yml'`
Expected: 36+ (35 VBR encoder branches + references in inline `js_resolve_max_resolution` code)

Run: `grep -c 'fl_bitdepth_args' '4 - Video.yml'`
Expected: 43+ (35 VBR + 3 CQ encoder branches + 5 references in inline `js_resolve_bitdepth` code)

Run: `grep 'bitrate_480p\|bitrate_576p\|bitrate_720p\|bitrate_1080p\|bitrate_1440p\|bitrate_4k"' '4 - Video.yml' | grep -v 'bitrate_effective\|cutoff\|js_\|calculate\|customFunction'`
Expected: 0 matches (no stale resolution-specific bitrate references in encoder branches)

- [ ] **Step 9: Commit**

```bash
git add "4 - Video.yml"
git commit -m "feat: update all encoder branches to use effective bitrate and bitdepth args"
```

---

## Chunk 5: Documentation Updates

### Task 6: Update `readme.md`

**Files:**
- Modify: `readme.md`

- [ ] **Step 1: Add new variables to the Required/Optional Variables section**

Add to the optional variables section:

```markdown
### New Optional Variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `v_max_bitdepth` | `8`, `10`, `12` | unset (preserve source) | Maximum output bit depth. Sources at or below this depth keep their native depth; sources above are downconverted. |
| `v_max_resolution` | `480p`, `576p`, `720p`, `1080p`, `1440p`, `4k` | unset (preserve source) | Maximum output resolution. Sources above this are downscaled. Bitrate automatically uses the target resolution's settings. |
```

- [ ] **Step 2: Commit**

```bash
git add readme.md
git commit -m "docs: add v_max_bitdepth and v_max_resolution to readme"
```

### Task 7: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add new variables and plugins to CLAUDE.md**

Add `v_max_bitdepth` and `v_max_resolution` to the Optional Variables table.

Add the two new plugins to the JavaScript Plugins section:
- `js_resolve_bitdepth.js` — Detects source bit depth, resolves against `v_max_bitdepth`, sets per-encoder `-pix_fmt` and `-profile:v` arguments
- `js_resolve_max_resolution.js` — Detects source resolution, resolves against `v_max_resolution`, builds combined `-vf` filter chain, sets effective bitrate variables

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with new plugins and variables"
```

---

## Chunk 6: Validation

### Task 8: End-to-end validation

- [ ] **Step 1: Validate all JSON files parse correctly**

```bash
cd /Users/anthony.lucent/luc3nt/Tdarr-One-Flow
for f in "1 - Input.yml" "2 - Prep.yml" "3 - Audio.yml" "4 - Video.yml" "5 - Save.yml"; do
  echo "Checking: $f"
  node -e "JSON.parse(require('fs').readFileSync('$f', 'utf8'))" && echo "  OK" || echo "  FAIL"
done
```

- [ ] **Step 2: Validate all JS plugins have no syntax errors**

```bash
for f in plugins/*.js; do
  echo "Checking: $f"
  node -c "$f" && echo "  OK" || echo "  FAIL"
done
```

- [ ] **Step 3: Verify no stale bitrate references remain in encoder branches**

Search `4 - Video.yml` for any `ffmpegCommandCustomArguments` plugins that still reference resolution-specific bitrate variables (like `bitrate_1080p`) in their `outputArguments`. There should be zero — all should use `bitrate_effective`.

- [ ] **Step 4: Verify edge graph integrity**

Confirm in the `flowEdges` that:
- No edge references the removed edge id `iOzNJfG0O`
- Edges `eBitDepth1`, `eMaxRes1`, `eMaxRes2` exist and chain correctly
- The deinterlace check edges have swapped handles
- Error edges for new plugins exist

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: validation fixes for bitdepth and max resolution features"
```
