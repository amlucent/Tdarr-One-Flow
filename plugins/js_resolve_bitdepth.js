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
  // mediaInfo is empty when the library's MediaInfo scan is off; fall back to
  // ffprobe so 10-bit (e.g. HDR10) sources aren't encoded as 8-bit.
  if (sourceBitDepth === 8) {
    const streams = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (v) {
      const raw = parseInt(v.bits_per_raw_sample, 10);
      const fromPix = /12(le|be)?$/.test(v.pix_fmt || '') ? 12 : /10(le|be)?$/.test(v.pix_fmt || '') ? 10 : 0;
      const depth = raw || fromPix;
      if ([10, 12].includes(depth)) sourceBitDepth = depth;
    }
  }

  // 2. Read v_max_bitdepth, v_min_bitdepth and v_force_bitdepth from library variables
  const lib = (args.userVariables && args.userVariables.library) || {};
  const readDepth = (name) => {
    const raw = lib[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const depth = parseInt(String(raw).trim(), 10);
    if (![8, 10, 12].includes(depth)) {
      throw new Error(`Invalid ${name} value '${raw}'. Must be 8, 10, or 12.`);
    }
    return depth;
  };
  const maxBitDepth = readDepth('v_max_bitdepth');
  const minBitDepth = readDepth('v_min_bitdepth');
  const forceBitDepth = readDepth('v_force_bitdepth');
  if (minBitDepth !== null && maxBitDepth !== null && minBitDepth > maxBitDepth) {
    throw new Error(`v_min_bitdepth (${minBitDepth}) is greater than v_max_bitdepth (${maxBitDepth}).`);
  }

  // HDR (PQ / HLG) needs at least 10 bits: 8-bit HDR bands badly and players may
  // mis-render it, so no setting may take an HDR source below 10.
  const probeStreams = (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) || [];
  const probeVideo = probeStreams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const isHdr = variables.is_hdr === 'true'
    || ['smpte2084', 'arib-std-b67'].includes(String((probeVideo && probeVideo.color_transfer) || ''));

  // 3. Resolve effective bit depth. This only shapes the encoder arguments, so it
  // never causes an encode by itself: files the flow skips or stream-copies keep
  // their video untouched. Precedence: v_force_bitdepth, then v_min_bitdepth
  // (raise), then v_max_bitdepth (cap).
  let effectiveDepth;
  if (forceBitDepth !== null) {
    effectiveDepth = forceBitDepth;
    args.jobLog(`Bit depth: source=${sourceBitDepth}, v_force_bitdepth=${forceBitDepth}, encoding at ${forceBitDepth}`);
  } else {
    effectiveDepth = sourceBitDepth;
    if (minBitDepth !== null && effectiveDepth < minBitDepth) {
      effectiveDepth = minBitDepth;
      args.jobLog(`Bit depth: source=${sourceBitDepth}, min=${minBitDepth}, raising to ${minBitDepth}`);
    }
    if (maxBitDepth !== null && effectiveDepth > maxBitDepth) {
      effectiveDepth = maxBitDepth;
      args.jobLog(`Bit depth: source=${sourceBitDepth}, max=${maxBitDepth}, capping to ${maxBitDepth}`);
    }
    if (effectiveDepth === sourceBitDepth) {
      args.jobLog(`Bit depth: source=${sourceBitDepth}, min=${minBitDepth === null ? 'unset' : minBitDepth}, max=${maxBitDepth === null ? 'unset' : maxBitDepth}, preserving source depth`);
    }
  }
  if (isHdr && effectiveDepth < 10) {
    effectiveDepth = Math.max(10, Math.min(sourceBitDepth, 12));
    args.jobLog(`Bit depth: HDR source, never encoded below 10-bit, using ${effectiveDepth}`);
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
  // 8-bit source staying 8-bit: empty, the encoders' default. An 8-bit target
  // from a deeper source needs the explicit arguments, or the encoder keeps the
  // source's 10-bit pixel format and the cap does nothing.
  if (lookupDepth === 8 && sourceBitDepth <= 8) {
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
