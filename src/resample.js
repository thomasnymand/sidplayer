// Sample rate conversion from the SID's ~1 MHz clock down to the output rate.
//
// The SID has to be sampled once per chip clock to capture its waveforms
// faithfully, which leaves a ratio of roughly 22:1 to undo. Doing that in one
// step needs an impractically long FIR, because the filter has to be sharp
// (20 kHz pass, 22.05 kHz stop) relative to the ~1 MHz input rate.
//
// Splitting it in two fixes that. The first stage decimates by an integer
// factor and only has to keep the band below 22 kHz clean, so its transition
// band is enormous and it stays short. The second stage does the sharp,
// fractional conversion at a rate where a sharp filter is cheap.

/** Modified Bessel function of the first kind, order 0. */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 64; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Kaiser window shape parameter for a required stopband attenuation in dB. */
function kaiserBeta(attenuationDb) {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21) {
    return 0.5842 * Math.pow(attenuationDb - 21, 0.4) + 0.07886 * (attenuationDb - 21);
  }
  return 0;
}

function sincPi(x) {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * One FIR resampling stage. Input samples are pushed through a history buffer;
 * an output is produced every `step` input samples, where `step` need not be an
 * integer. Fractional positions are served from a precomputed bank of phases.
 */
class FirStage {
  /**
   * @param {number} inputRate
   * @param {number} outputRate
   * @param {number} passHz  end of the pass band
   * @param {number} stopHz  start of the stop band
   * @param {number} attenuationDb required stopband attenuation
   * @param {number} phases number of fractional phases in the bank
   */
  constructor(inputRate, outputRate, passHz, stopHz, attenuationDb, phases = 256) {
    this.step = inputRate / outputRate;
    this.phases = phases;

    const transition = (stopHz - passHz) / inputRate;
    // Kaiser's design estimate for the number of taps.
    let taps = Math.ceil((attenuationDb - 7.95) / (2.285 * 2 * Math.PI * transition)) + 1;
    taps = Math.max(8, taps | 1); // odd length keeps the kernel symmetric
    this.taps = taps;

    const beta = kaiserBeta(attenuationDb);
    const i0beta = besselI0(beta);
    const cutoff = ((passHz + stopHz) / 2) / inputRate; // normalised to input rate
    const centre = (taps - 1) / 2;
    const halfWidth = taps / 2;

    // bank[p * taps + n] is tap n for fractional phase p / phases.
    this.bank = new Float64Array((phases + 1) * taps);
    for (let p = 0; p <= phases; p++) {
      const phi = p / phases;
      let sum = 0;
      const base = p * taps;
      for (let n = 0; n < taps; n++) {
        const t = centre + phi - 1 - n;
        let value = 0;
        if (Math.abs(t) <= halfWidth) {
          const ratio = t / halfWidth;
          const window = besselI0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / i0beta;
          value = 2 * cutoff * sincPi(2 * cutoff * t) * window;
        }
        this.bank[base + n] = value;
        sum += value;
      }
      // Normalise each phase to unity DC gain so the output has no ripple.
      if (sum !== 0) {
        for (let n = 0; n < taps; n++) this.bank[base + n] /= sum;
      }
    }

    // Doubled history buffer: every sample is stored twice, `taps` apart, so a
    // convolution can always run over a contiguous span without wrapping.
    this.history = new Float64Array(taps * 2);
    this.pos = 0;
    this.countdown = this.step;
  }

  /** Longest output run this stage can produce from `count` input samples. */
  maxOutput(count) {
    return Math.ceil(count / this.step) + 2;
  }

  /**
   * @param {Float32Array|Float64Array} input
   * @param {number} count number of input samples to consume
   * @param {Float64Array} output destination
   * @returns {number} number of output samples written
   */
  process(input, count, output) {
    const history = this.history;
    const bank = this.bank;
    const taps = this.taps;
    const phases = this.phases;
    let pos = this.pos;
    let countdown = this.countdown;
    let written = 0;

    for (let i = 0; i < count; i++) {
      const sample = input[i];
      history[pos] = sample;
      history[pos + taps] = sample;
      pos = pos + 1 === taps ? 0 : pos + 1;

      countdown -= 1;
      while (countdown < 1) {
        // The output falls `countdown` samples after the one just pushed, with
        // countdown in (-1, 0]; shift it into a [0, 1] phase index.
        let phase = Math.round((countdown + 1) * phases);
        if (phase < 0) phase = 0;
        else if (phase > phases) phase = phases;

        const base = phase * taps;
        // `pos` is the oldest sample of the window in the doubled buffer.
        let acc = 0;
        for (let n = 0; n < taps; n++) {
          acc += history[pos + n] * bank[base + n];
        }
        output[written++] = acc;
        countdown += this.step;
      }
    }

    this.pos = pos;
    this.countdown = countdown;
    return written;
  }
}

export class SidResampler {
  /**
   * @param {number} inputRate SID clock frequency
   * @param {number} outputRate desired audio sample rate
   * @param {number} attenuationDb stopband attenuation of both stages
   */
  constructor(inputRate, outputRate, attenuationDb = 70) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;

    // Aim for an intermediate rate a bit above twice the output rate: high
    // enough that the sharp final filter is cheap, low enough that the first
    // stage removes most of the work.
    const decimation = Math.max(1, Math.floor(inputRate / (2.2 * outputRate)));
    this.stages = [];

    if (decimation > 1) {
      const midRate = inputRate / decimation;
      // Stage one only has to keep everything that would fold back into the
      // audible band out of it, so its stop band starts very high.
      this.stages.push(new FirStage(
        inputRate,
        midRate,
        outputRate / 2,
        midRate - outputRate / 2,
        attenuationDb,
        1, // integer decimation never needs a fractional phase
      ));
      this.stages.push(new FirStage(
        midRate,
        outputRate,
        outputRate * 0.45,
        outputRate * 0.5,
        attenuationDb,
      ));
      this.intermediate = null; // sized lazily
    } else {
      this.stages.push(new FirStage(
        inputRate,
        outputRate,
        outputRate * 0.45,
        outputRate * 0.5,
        attenuationDb,
      ));
    }
  }

  /** Longest output run these stages can produce from `count` input samples. */
  maxOutput(count) {
    let n = count;
    for (const stage of this.stages) n = stage.maxOutput(n);
    return n;
  }

  /**
   * @param {Float32Array} input SID samples at the chip clock rate
   * @param {number} count how many of them to consume
   * @param {Float64Array} output destination for resampled audio
   * @returns {number} number of output samples written
   */
  process(input, count, output) {
    if (this.stages.length === 1) {
      return this.stages[0].process(input, count, output);
    }
    const needed = this.stages[0].maxOutput(count);
    if (!this.intermediate || this.intermediate.length < needed) {
      this.intermediate = new Float64Array(needed);
    }
    const midCount = this.stages[0].process(input, count, this.intermediate);
    return this.stages[1].process(this.intermediate, midCount, output);
  }

  /** Total tap count, for reporting. */
  get description() {
    return this.stages.map((s) => `${s.taps} taps @ 1:${s.step.toFixed(3)}`).join(' -> ');
  }
}
