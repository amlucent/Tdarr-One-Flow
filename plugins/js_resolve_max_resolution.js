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
