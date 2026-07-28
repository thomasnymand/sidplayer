// Minimal 16-bit PCM WAV writer.

/** Write ASCII into a DataView, one byte per character. */
function writeTag(view, offset, tag) {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/**
 * Encode mono float samples as a RIFF/WAVE file.
 *
 * @param {Float64Array|Float32Array} samples nominally in [-1, 1]
 * @param {number} sampleRate
 * @param {number} [gain] linear gain applied before conversion
 * @returns {Uint8Array} the complete file; write it out, or wrap it in a Blob
 */
export function encodeWav(samples, sampleRate, gain = 1) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = samples.length * blockAlign;

  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(view, 8, 'WAVE');
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true);              // PCM header size
  view.setUint16(20, 1, true);               // format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let value = Math.round(samples[i] * gain * 32767);
    if (value > 32767) value = 32767;
    else if (value < -32768) value = -32768;
    view.setInt16(offset, value, true);
    offset += 2;
  }
  return bytes;
}

/** Peak absolute value of a sample buffer. */
export function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Root-mean-square level of a sample buffer. */
export function rmsOf(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}
