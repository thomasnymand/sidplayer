// Minimal 16-bit PCM WAV writer.

/**
 * Encode mono float samples as a RIFF/WAVE file.
 *
 * @param {Float64Array|Float32Array} samples nominally in [-1, 1]
 * @param {number} sampleRate
 * @param {number} [gain] linear gain applied before conversion
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate, gain = 1) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = samples.length * blockAlign;

  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);              // PCM header size
  buffer.writeUInt16LE(1, 20);               // format: PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let value = Math.round(samples[i] * gain * 32767);
    if (value > 32767) value = 32767;
    else if (value < -32768) value = -32768;
    buffer.writeInt16LE(value, offset);
    offset += 2;
  }
  return buffer;
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
