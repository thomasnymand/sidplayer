// Renders a tune off the main thread so the page stays responsive. This imports
// exactly the same src/ modules the command line player uses.

import { parseSidFile } from '../src/sidfile.js';
import { SidPlayer } from '../src/player.js';
import { peakOf, rmsOf } from '../src/wav.js';

self.onmessage = (event) => {
  const {
    bytes, song, seconds, sampleRate, model, clock, normalize, gain: fixedGain,
  } = event.data;

  try {
    const tune = parseSidFile(bytes);
    const player = new SidPlayer(tune, { sampleRate, model, clock });
    player.init(song);

    const total = Math.round(seconds * sampleRate);
    const started = performance.now();
    const rendered = player.render(total, (written) => {
      self.postMessage({ type: 'progress', written, total });
    });
    const elapsed = (performance.now() - started) / 1000;

    const peak = peakOf(rendered);
    let gain = 1;
    if (fixedGain !== null && fixedGain !== undefined) gain = fixedGain;
    else if (normalize && peak > 0) gain = 0.89 / peak;

    // Web Audio wants float32; fold the gain in during the narrowing pass
    // rather than walking the buffer twice.
    const samples = new Float32Array(rendered.length);
    for (let i = 0; i < rendered.length; i++) samples[i] = rendered[i] * gain;

    self.postMessage({
      type: 'done',
      samples,
      sampleRate,
      stats: {
        peak,
        rms: rmsOf(rendered),
        gain,
        elapsed,
        realtimeFactor: seconds / elapsed,
        playCalls: player.playCalls,
        playRate: player.playRate,
        cpuJammed: player.cpuJammed,
        clockName: player.timing.name,
        modelName: player.model === 2 ? 'MOS8580' : 'MOS6581',
      },
    }, [samples.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
