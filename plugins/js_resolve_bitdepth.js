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
