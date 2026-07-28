// Minimal 16-bit PCM WAV writer.

export const WAV_HEADER_BYTES = 44;

// What a RIFF header carries when the length is not yet known. A stream has to
// write its header before it has produced anything, so it claims the largest
// size the field can hold and lets the reader stop at end of input.
export const WAV_LENGTH_UNKNOWN = 0xffffffff;

/** Write ASCII into a DataView, one byte per character. */
function writeTag(view, offset, tag) {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/**
 * Build the 44-byte RIFF/WAVE header for mono 16-bit PCM.
 *
 * @param {number} sampleRate
 * @param {number} dataBytes length of the sample data that will follow, or
 *   WAV_LENGTH_UNKNOWN when writing to a pipe
 * @returns {Uint8Array}
 */
export function wavHeader(sampleRate, dataBytes) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);

  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, Math.min(36 + dataBytes, WAV_LENGTH_UNKNOWN), true);
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
  return bytes;
}

/**
 * Convert float samples to little-endian 16-bit PCM.
 *
 * Both the file writer and the streaming player go through here, so audio
 * played straight out of the process is quantised identically to audio that
 * went through a .wav on the way.
 *
 * @param {Float64Array|Float32Array} samples nominally in [-1, 1]
 * @param {number} [count] how many samples to convert
 * @param {number} [gain] linear gain applied before conversion
 * @param {Uint8Array} [out] destination; allocated if not supplied
 * @param {number} [byteOffset] where in `out` to start writing
 * @returns {Uint8Array} `out`
 */
export function encodePcm16(
  samples,
  count = samples.length,
  gain = 1,
  out = new Uint8Array(count * 2),
  byteOffset = 0,
) {
  const view = new DataView(out.buffer, out.byteOffset + byteOffset, count * 2);
  for (let i = 0; i < count; i++) {
    let value = Math.round(samples[i] * gain * 32767);
    if (value > 32767) value = 32767;
    else if (value < -32768) value = -32768;
    view.setInt16(i * 2, value, true);
  }
  return out;
}

/**
 * Encode mono float samples as a complete RIFF/WAVE file.
 *
 * @param {Float64Array|Float32Array} samples nominally in [-1, 1]
 * @param {number} sampleRate
 * @param {number} [gain] linear gain applied before conversion
 * @returns {Uint8Array} the complete file; write it out, or wrap it in a Blob
 */
export function encodeWav(samples, sampleRate, gain = 1) {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  bytes.set(wavHeader(sampleRate, dataBytes), 0);
  encodePcm16(samples, samples.length, gain, bytes, WAV_HEADER_BYTES);
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
