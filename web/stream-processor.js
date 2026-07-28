// The emulator, running inside the audio render thread.
//
// This is the whole point of the streaming path: instead of rendering a tune to
// a buffer and then playing it, the 6510 and the SID advance on demand, filling
// each 128-frame quantum as the audio hardware asks for it. Playback starts
// immediately and has no end.
//
// Everything here has to hold to a hard deadline: at 48 kHz a quantum is 2.67 ms
// of audio, and if process() has not returned by then the stream glitches. All
// buffers are therefore allocated up front, and nothing in the loop allocates.

import { parseSidFile } from '../src/sidfile.js';
import { SidPlayer } from '../src/player.js';

// SID cycles emulated per step, matching the offline renderer. About 17 ms of
// audio, so roughly one quantum in six does the work for the following six.
// Measured on an M-series Mac at 48 kHz that costs around 15% of the audio
// thread's time; 4096 was tried and came out worse, at around 19%, because the
// resampler's per-call overhead is then paid four times as often.
const CHUNK = 16384;

// Quanta between status messages. 64 is roughly six updates a second.
const REPORT_INTERVAL = 64;

class SidStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const {
      bytes, song, model, clock, voices,
    } = options.processorOptions;

    this.stopped = false;
    try {
      const tune = parseSidFile(bytes);
      // `sampleRate` is a global in the worklet scope: the context's true rate.
      this.player = new SidPlayer(tune, {
        sampleRate, model, clock, voices,
      });
      this.player.init(song);
    } catch (error) {
      this.stopped = true;
      this.port.postMessage({ type: 'error', message: error.message });
      return;
    }

    const player = this.player;
    this.sidBuffer = new Float32Array(CHUNK + 64);
    this.outBuffer = new Float64Array(player.resampler.maxOutput(CHUNK + 64));
    this.pendingOffset = 0;
    this.pendingLength = 0;

    this.quanta = 0;
    this.cpuMillis = 0;
    this.startTime = currentTime;

    this.port.onmessage = ({ data }) => {
      if (data === 'stop') this.stopped = true;
    };

    this.port.postMessage({
      type: 'ready',
      sampleRate,
      clockName: player.timing.name,
      modelName: player.model === 2 ? 'MOS8580' : 'MOS6581',
      playRate: player.playRate,
    });
  }

  process(_inputs, outputs) {
    if (this.stopped) return false; // lets the node be collected
    const out = outputs[0][0];
    if (!out) return true;

    // performance.now() does not exist in this scope, so this is Date.now() at
    // whole-millisecond resolution against a call costing a fraction of one.
    // Individually that reads 0 or 1, but the chance of crossing a millisecond
    // boundary is exactly the fractional duration, so accumulating over a whole
    // reporting window is unbiased.
    const started = Date.now();

    let written = 0;
    // The guard only exists so a pathological zero-length resampler result
    // cannot spin the audio thread forever; it is never reached in practice.
    let guard = 0;
    while (written < out.length && guard++ < 64) {
      if (this.pendingOffset >= this.pendingLength) {
        const filled = this.player.runCycles(CHUNK, this.sidBuffer);
        this.pendingLength = this.player.resampler.process(
          this.sidBuffer, filled, this.outBuffer,
        );
        this.pendingOffset = 0;
      }
      const take = Math.min(out.length - written, this.pendingLength - this.pendingOffset);
      for (let i = 0; i < take; i++) out[written + i] = this.outBuffer[this.pendingOffset + i];
      written += take;
      this.pendingOffset += take;
    }

    this.cpuMillis += Date.now() - started;

    if (++this.quanta >= REPORT_INTERVAL) {
      const audioMillis = (this.quanta * out.length * 1000) / sampleRate;
      this.port.postMessage({
        type: 'status',
        elapsed: currentTime - this.startTime,
        playCalls: this.player.playCalls,
        playRate: this.player.playRate,
        cpuJammed: this.player.cpuJammed,
        // Fraction of the audio thread's deadline actually consumed.
        load: this.cpuMillis / audioMillis,
      });
      this.quanta = 0;
      this.cpuMillis = 0;
    }

    return true;
  }
}

registerProcessor('sid-stream', SidStreamProcessor);
