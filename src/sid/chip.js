// A complete MOS 6581 / 8580 SID: three voices, the shared filter, and the
// register interface the CPU sees at $D400.

import { WaveformGenerator } from './wave.js';
import { EnvelopeGenerator } from './envelope.js';
import { Filter, ExternalFilter } from './filter.js';

export const MODEL_6581 = 1;
export const MODEL_8580 = 2;

// On the 6581 each voice sits on a large DC offset, which is exactly why
// writing the volume register produces an audible step (the basis of every
// volume-register sample routine). The 8580 has almost none.
const VOICE_DC_6581 = 0x800 * 0xff;

// Nominal full scale: three voices at maximum amplitude and maximum volume.
const OUTPUT_SCALE = 1 / (0x7ff * 0xff * 15 * 3);

export class SIDChip {
  /**
   * @param {number} model MODEL_6581 or MODEL_8580
   * @param {number} clockFrequency chip clock in Hz
   */
  constructor(model = MODEL_6581, clockFrequency = 985248) {
    this.model = model;
    this.clockFrequency = clockFrequency;
    this.waves = [
      new WaveformGenerator(model),
      new WaveformGenerator(model),
      new WaveformGenerator(model),
    ];
    this.envelopes = [
      new EnvelopeGenerator(),
      new EnvelopeGenerator(),
      new EnvelopeGenerator(),
    ];
    // Voice n is synced from voice n-1, wrapping round: 0 <- 2, 1 <- 0, 2 <- 1.
    for (let i = 0; i < 3; i++) {
      this.waves[i].syncSource = this.waves[(i + 2) % 3];
      this.waves[i].syncDest = this.waves[(i + 1) % 3];
    }
    this.filter = new Filter(model, clockFrequency);
    this.externalFilter = new ExternalFilter(clockFrequency);
    this.voiceDC = model === MODEL_6581 ? VOICE_DC_6581 : 0;
    this.registers = new Uint8Array(32);
    this.mute = [false, false, false];
    this.busValue = 0;
    this.busValueTtl = 0;
  }

  reset() {
    for (const w of this.waves) w.reset();
    for (const e of this.envelopes) e.reset();
    this.filter.reset();
    this.externalFilter.reset();
    this.registers.fill(0);
    this.busValue = 0;
  }

  setMute(voice, muted) {
    this.mute[voice] = !!muted;
  }

  setFilterEnabled(enabled) {
    this.filter.filterEnabled = !!enabled;
  }

  read(reg) {
    switch (reg & 0x1f) {
      // Paddle inputs; nothing is connected, so they float high.
      case 0x19: case 0x1a: return 0xff;
      // Oscillator 3 and envelope 3 are the SID's only readable state, and are
      // widely used as a random source and for waveform-driven modulation.
      case 0x1b: return (this.waves[2].output() >> 4) & 0xff;
      case 0x1c: return this.envelopes[2].output();
      // Everything else is write-only and returns whatever last sat on the bus.
      default: return this.busValue;
    }
  }

  write(reg, value) {
    reg &= 0x1f;
    value &= 0xff;
    this.registers[reg] = value;
    this.busValue = value;

    const voice = (reg / 7) | 0;
    switch (reg) {
      case 0x00: case 0x07: case 0x0e: this.waves[voice].writeFreqLo(value); break;
      case 0x01: case 0x08: case 0x0f: this.waves[voice].writeFreqHi(value); break;
      case 0x02: case 0x09: case 0x10: this.waves[voice].writePwLo(value); break;
      case 0x03: case 0x0a: case 0x11: this.waves[voice].writePwHi(value); break;
      case 0x04: case 0x0b: case 0x12:
        this.waves[voice].writeControlReg(value);
        this.envelopes[voice].writeControlReg(value);
        break;
      case 0x05: case 0x0c: case 0x13: this.envelopes[voice].writeAttackDecay(value); break;
      case 0x06: case 0x0d: case 0x14: this.envelopes[voice].writeSustainRelease(value); break;
      case 0x15: this.filter.writeFcLo(value); break;
      case 0x16: this.filter.writeFcHi(value); break;
      case 0x17: this.filter.writeResFilt(value); break;
      case 0x18: this.filter.writeModeVol(value); break;
      default: break;
    }
  }

  /**
   * Run the chip for `cycles` clocks, writing one output sample per clock.
   *
   * @param {number} cycles
   * @param {Float32Array} out destination buffer
   * @param {number} offset first index to write
   * @param {boolean} accumulate add to the buffer instead of overwriting it
   *   (used when mixing a second or third SID)
   */
  clock(cycles, out, offset, accumulate = false) {
    const [w0, w1, w2] = this.waves;
    const [e0, e1, e2] = this.envelopes;
    const filter = this.filter;
    const extFilter = this.externalFilter;
    const dc = this.voiceDC;
    const [m0, m1, m2] = this.mute;

    for (let i = 0; i < cycles; i++) {
      // Oscillators all advance before any of them syncs, so that hard sync
      // sees the same cycle's MSB transitions.
      w0.clock(); w1.clock(); w2.clock();
      w0.synchronize(); w1.synchronize(); w2.synchronize();
      e0.clock(); e1.clock(); e2.clock();

      const v0 = m0 ? 0 : (w0.output() - 0x800) * e0.output() + dc;
      const v1 = m1 ? 0 : (w1.output() - 0x800) * e1.output() + dc;
      const v2 = m2 ? 0 : (w2.output() - 0x800) * e2.output() + dc;

      const sample = extFilter.clock(filter.clock(v0, v1, v2, 0)) * OUTPUT_SCALE;
      if (accumulate) out[offset + i] += sample;
      else out[offset + i] = sample;
    }
  }
}
