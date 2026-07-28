// SID multimode filter.
//
// Topology follows reSID's two-integrator loop (a state variable filter), which
// mirrors how the chip is actually wired: two integrators in a feedback loop
// giving simultaneous low-pass, band-pass and high-pass taps.
//
// The cutoff control is strongly nonlinear on the 6581 and the curve varies
// between individual chips. The control points below approximate the measured
// response reSID uses; the 8580's on-chip filter is far closer to linear.

export const MODEL_6581 = 1;
export const MODEL_8580 = 2;

// [cutoff register value, cutoff frequency in Hz]
const F0_POINTS_6581 = [
  [0, 220], [128, 230], [256, 250], [384, 300], [512, 420],
  [640, 780], [768, 1600], [832, 2300], [896, 3200], [960, 4300],
  [992, 5000], [1023, 5800],
  // The real chip has a discontinuity at the top of the low range; the curve
  // restarts here rather than continuing smoothly.
  [1024, 5900], [1152, 6800], [1280, 8000], [1408, 9500], [1536, 10500],
  [1664, 11700], [1792, 12500], [1920, 13500], [2047, 14500],
];

const F0_POINTS_8580 = [
  [0, 0], [128, 800], [256, 1600], [384, 2500], [512, 3300],
  [640, 4100], [768, 4800], [896, 5500], [1024, 6100], [1152, 6800],
  [1280, 7400], [1408, 7900], [1536, 8500], [1664, 9000], [1792, 9400],
  [1920, 9800], [2047, 10200],
];

function buildCutoffTable(points) {
  const table = new Float64Array(2048);
  let segment = 0;
  for (let fc = 0; fc < 2048; fc++) {
    while (segment < points.length - 2 && points[segment + 1][0] < fc) segment++;
    const [x0, y0] = points[segment];
    const [x1, y1] = points[segment + 1];
    const t = x1 === x0 ? 0 : (fc - x0) / (x1 - x0);
    table[fc] = y0 + (y1 - y0) * t;
  }
  return table;
}

const CUTOFF_6581 = buildCutoffTable(F0_POINTS_6581);
const CUTOFF_8580 = buildCutoffTable(F0_POINTS_8580);

export class Filter {
  /**
   * @param {number} model MODEL_6581 or MODEL_8580
   * @param {number} clockFrequency chip clock in Hz
   */
  constructor(model, clockFrequency) {
    this.model = model;
    this.clockFrequency = clockFrequency;
    this.cutoffTable = model === MODEL_8580 ? CUTOFF_8580 : CUTOFF_6581;
    this.reset();
  }

  reset() {
    this.fc = 0;
    this.res = 0;
    this.filt = 0;
    this.voice3off = false;
    this.hp = false;
    this.bp = false;
    this.lp = false;
    this.vol = 0;
    this.filterEnabled = true;
    this.vhp = 0;
    this.vbp = 0;
    this.vlp = 0;
    this.updateW0();
    this.updateQ();
  }

  updateW0() {
    const cutoff = this.cutoffTable[this.fc & 0x7ff];
    // Per-clock integrator coefficient. Clamped below the stability limit of
    // the discrete integrator loop.
    this.w0 = Math.min((2 * Math.PI * cutoff) / this.clockFrequency, 0.9);
  }

  updateQ() {
    // Q ranges from 0.707 (no resonance) to 1.707 at maximum.
    this.invQ = 1 / (0.707 + this.res / 15);
  }

  writeFcLo(value) { this.fc = (this.fc & 0x7f8) | (value & 0x07); this.updateW0(); }

  writeFcHi(value) { this.fc = ((value & 0xff) << 3) | (this.fc & 0x007); this.updateW0(); }

  writeResFilt(value) {
    this.res = (value >> 4) & 0x0f;
    this.filt = value & 0x0f;
    this.updateQ();
  }

  writeModeVol(value) {
    this.voice3off = (value & 0x80) !== 0;
    this.hp = (value & 0x40) !== 0;
    this.bp = (value & 0x20) !== 0;
    this.lp = (value & 0x10) !== 0;
    this.vol = value & 0x0f;
  }

  /**
   * Advance the filter one chip clock and return the mixed output.
   * Voice inputs are the 20-bit signed products of waveform and envelope.
   */
  clock(v1, v2, v3, ext) {
    let vi = 0;  // routed into the filter
    let vnf = 0; // bypassing the filter

    if (this.filt & 0x01) vi += v1; else vnf += v1;
    if (this.filt & 0x02) vi += v2; else vnf += v2;
    if (this.filt & 0x04) {
      vi += v3;
    } else if (!this.voice3off) {
      // Bit 7 of $D418 disconnects voice 3, but only while it is unfiltered --
      // players use it to run voice 3 purely as a modulation source.
      vnf += v3;
    }
    if (this.filt & 0x08) vi += ext; else vnf += ext;

    if (!this.filterEnabled) {
      return (vnf + vi) * this.vol;
    }

    // Integrate, then recompute the high-pass tap from the loop equation.
    this.vbp -= this.w0 * this.vhp;
    this.vlp -= this.w0 * this.vbp;
    this.vhp = this.vbp * this.invQ - this.vlp - vi;

    let vf = 0;
    if (this.lp) vf += this.vlp;
    if (this.bp) vf += this.vbp;
    if (this.hp) vf += this.vhp;

    return (vnf + vf) * this.vol;
  }
}

/**
 * The RC network between the SID's output pin and the audio jack: a ~16 Hz
 * high-pass that strips the chip's large DC offset, and a ~16 kHz low-pass.
 * Without it the 6581's DC term would dominate the rendered signal.
 */
export class ExternalFilter {
  constructor(clockFrequency) {
    this.w0lp = Math.min((2 * Math.PI * 16000) / clockFrequency, 0.9);
    this.w0hp = (2 * Math.PI * 16) / clockFrequency;
    this.reset();
  }

  reset() {
    this.vlp = 0;
    this.vhp = 0;
    this.primed = false;
  }

  clock(vi) {
    if (!this.primed) {
      // The 6581's DC offset is large enough that starting from zero would send
      // a full-scale step through the high-pass, taking tens of milliseconds to
      // decay. Start both integrators at the first input so the output begins
      // at silence instead.
      this.vlp = vi;
      this.vhp = vi;
      this.primed = true;
      return 0;
    }
    this.vlp += this.w0lp * (vi - this.vlp);
    this.vhp += this.w0hp * (this.vlp - this.vhp);
    return this.vlp - this.vhp;
  }
}
