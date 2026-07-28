// SID waveform generator (one per voice).
//
// A 24-bit phase accumulator is advanced by the 16-bit frequency once per chip
// clock. The four waveforms are all derived from that accumulator, except noise
// which is driven by a 23-bit LFSR clocked from accumulator bit 19.

export const MODEL_6581 = 1;
export const MODEL_8580 = 2;

export class WaveformGenerator {
  constructor(model = MODEL_6581) {
    this.model = model;
    this.syncSource = this; // patched by the chip to the previous voice
    this.syncDest = this;
    this.reset();
  }

  reset() {
    this.accumulator = 0;
    this.previousAccumulator = 0;
    this.shiftRegister = 0x7ffff8;
    this.freq = 0;
    this.pw = 0;
    this.waveform = 0;
    this.test = false;
    this.ringMod = false;
    this.sync = false;
    this.msbRising = false;
  }

  writeFreqLo(v) { this.freq = (this.freq & 0xff00) | (v & 0xff); }

  writeFreqHi(v) { this.freq = (this.freq & 0x00ff) | ((v & 0xff) << 8); }

  writePwLo(v) { this.pw = (this.pw & 0x0f00) | (v & 0xff); }

  writePwHi(v) { this.pw = (this.pw & 0x00ff) | ((v & 0x0f) << 8); }

  writeControlReg(control) {
    this.waveform = (control >> 4) & 0x0f;
    this.ringMod = (control & 0x04) !== 0;
    this.sync = (control & 0x02) !== 0;
    const testNext = (control & 0x08) !== 0;
    if (testNext && !this.test) {
      // Setting TEST freezes the oscillator at zero and refills the LFSR, which
      // is how players "reset" a noise voice to a known state.
      this.accumulator = 0;
      this.shiftRegister = 0x7ffff8;
    }
    this.test = testNext;
  }

  clock() {
    if (this.test) {
      this.msbRising = false;
      return;
    }
    const prev = this.accumulator;
    this.accumulator = (this.accumulator + this.freq) & 0xffffff;
    this.msbRising = (prev & 0x800000) === 0 && (this.accumulator & 0x800000) !== 0;
    // The noise register shifts once each time accumulator bit 19 goes high.
    if ((prev & 0x080000) === 0 && (this.accumulator & 0x080000) !== 0) {
      const bit0 = ((this.shiftRegister >>> 22) ^ (this.shiftRegister >>> 17)) & 0x01;
      this.shiftRegister = ((this.shiftRegister << 1) & 0x7fffff) | bit0;
    }
  }

  /** Hard sync: reset this oscillator when its sync source's MSB rises. */
  synchronize() {
    if (this.sync && this.syncSource.msbRising) {
      this.accumulator = 0;
    }
  }

  outputTriangle() {
    // Ring modulation replaces this oscillator's MSB with the XOR of its own
    // and the sync source's, which is what produces the metallic timbre.
    const msb = (this.ringMod
      ? this.accumulator ^ this.syncSource.accumulator
      : this.accumulator) & 0x800000;
    const value = msb ? ~this.accumulator : this.accumulator;
    return (value >>> 11) & 0xfff;
  }

  outputSawtooth() {
    return (this.accumulator >>> 12) & 0xfff;
  }

  outputPulse() {
    return this.test || this.pw > (this.accumulator >>> 12) ? 0xfff : 0x000;
  }

  outputNoise() {
    const sr = this.shiftRegister;
    return ((sr & 0x400000) >>> 11)
      | ((sr & 0x100000) >>> 10)
      | ((sr & 0x010000) >>> 7)
      | ((sr & 0x002000) >>> 5)
      | ((sr & 0x000800) >>> 4)
      | ((sr & 0x000080) >>> 1)
      | ((sr & 0x000010) << 1)
      | ((sr & 0x000004) << 2);
  }

  /**
   * 12-bit oscillator output.
   *
   * Selecting more than one waveform ties their outputs together on the chip's
   * internal bus. A true model needs sampled tables from real silicon; the
   * bitwise AND used here is the standard approximation, with an attenuation on
   * the 6581 where combined waveforms are markedly quieter than on the 8580.
   */
  output() {
    switch (this.waveform) {
      case 0x0: return 0x000;
      case 0x1: return this.outputTriangle();
      case 0x2: return this.outputSawtooth();
      case 0x4: return this.outputPulse();
      case 0x8: return this.outputNoise();
      default: break;
    }
    // Combining anything with noise drags the shift register low on real
    // hardware, silencing the voice within a few cycles.
    if (this.waveform & 0x8) return 0x000;

    let value = 0xfff;
    if (this.waveform & 0x1) value &= this.outputTriangle();
    if (this.waveform & 0x2) value &= this.outputSawtooth();
    if (this.waveform & 0x4) value &= this.outputPulse();
    if (this.model === MODEL_6581) {
      // Pull the result towards the zero level rather than just scaling it, so
      // the waveform stays centred.
      value = 0x800 + (((value - 0x800) * 3) >> 2);
    }
    return value & 0xfff;
  }
}
