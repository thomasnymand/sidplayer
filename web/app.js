// Browser front end.
//
// Two paths, for two different jobs. Play streams through an AudioWorklet: the
// emulator runs in the audio thread and sound starts immediately, for as long
// as you like. Download WAV renders a fixed length in a worker instead, because
// normalising a level requires knowing the peak, which a stream cannot know.

import { parseSidFile, songUsesCiaTiming, SidFileError } from '../src/sidfile.js';
import { encodeWav } from '../src/wav.js';

const $ = (id) => document.getElementById(id);

const ui = {
  drop: $('drop'),
  file: $('file'),
  info: $('info'),
  controls: $('controls'),
  export: $('export'),
  song: $('song'),
  time: $('time'),
  model: $('model'),
  clock: $('clock'),
  volume: $('volume'),
  play: $('play'),
  stop: $('stop'),
  download: $('download'),
  bar: $('bar'),
  barFill: $('bar-fill'),
  status: $('status'),
  stats: $('stats'),
};

let tune = null;
let bytes = null;

let audioContext = null;
let workletLoaded = false;
let streamNode = null;
let gainNode = null;
let streamHeader = '';

let exporting = false;

const hex = (value, digits = 4) => `$${value.toString(16).toUpperCase().padStart(digits, '0')}`;

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = kind;
}

function setStats(lines) {
  ui.stats.innerHTML = lines.map((line) => `<span>${line}</span>`).join('');
  ui.stats.hidden = lines.length === 0;
}

const exportSeconds = () => Math.max(1, Math.min(600, Number(ui.time.value) || 180));
const selectedSong = () => Number(ui.song.value) || (tune ? tune.startSong : 1);
const isStreaming = () => streamNode !== null;

function refreshControls() {
  ui.play.disabled = !tune || isStreaming() || exporting;
  ui.stop.disabled = !isStreaming();
  ui.download.disabled = !tune || exporting;
}

function showInfo(parsed) {
  const song = selectedSong();
  const rows = [
    ['Title', parsed.name || '(none)'],
    ['Author', parsed.author || '(none)'],
    ['Released', parsed.released || '(none)'],
    ['Format', `${parsed.magic} v${parsed.version}`],
    ['Songs', `${parsed.songs} (default ${parsed.startSong})`],
    ['Load', `${hex(parsed.loadAddress)}-${hex(parsed.endAddress)} (${parsed.data.length} bytes)`],
    ['Init', hex(parsed.initAddress)],
    ['Play', parsed.playAddress ? hex(parsed.playAddress) : 'interrupt driven'],
    ['Clock', parsed.clockName],
    ['SID model', parsed.sidModelName],
    ['Speed', `${hex(parsed.speed, 8)} — song ${song} uses `
      + `${songUsesCiaTiming(parsed, song) ? 'CIA 1 timer A' : 'vertical blank'}`],
  ];
  if (parsed.secondSidAddress) rows.push(['Second SID', hex(parsed.secondSidAddress)]);
  if (parsed.thirdSidAddress) rows.push(['Third SID', hex(parsed.thirdSidAddress)]);

  ui.info.innerHTML = rows
    .map(([label, value]) => `<div class="k">${label}</div><div class="v">${value}</div>`)
    .join('');
  ui.info.hidden = false;
}

function loadTune(raw, label) {
  stop();
  setStats([]);
  ui.bar.hidden = true;

  try {
    tune = parseSidFile(raw);
  } catch (error) {
    tune = null;
    bytes = null;
    ui.info.hidden = true;
    ui.controls.hidden = true;
    ui.export.hidden = true;
    refreshControls();
    setStatus(
      error instanceof SidFileError ? `${label}: ${error.message}` : String(error),
      'error',
    );
    return;
  }

  bytes = raw;
  ui.song.innerHTML = Array.from(
    { length: tune.songs },
    (_, i) => `<option value="${i + 1}">${i + 1}</option>`,
  ).join('');
  ui.song.value = String(tune.startSong);
  ui.song.disabled = tune.songs < 2;

  showInfo(tune);
  ui.controls.hidden = false;
  ui.export.hidden = false;
  refreshControls();
  setStatus(`${tune.name || label} loaded — press Play.`);
}

async function readFile(file) {
  loadTune(new Uint8Array(await file.arrayBuffer()), file.name);
}

function ensureContext() {
  if (!audioContext) audioContext = new AudioContext();
  // Browsers start a context suspended until a gesture unlocks it.
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

/** Settings shared by both the streaming and the offline path. */
const emulationOptions = () => ({
  bytes,
  song: selectedSong(),
  model: ui.model.value || null,
  clock: ui.clock.value || null,
});

// --- streaming -------------------------------------------------------------

async function play() {
  if (!tune || isStreaming()) return;
  const context = ensureContext();

  if (!context.audioWorklet) {
    setStatus('this browser has no AudioWorklet; Download WAV still works', 'error');
    return;
  }

  try {
    if (!workletLoaded) {
      await context.audioWorklet.addModule('./stream-processor.js');
      workletLoaded = true;
    }
  } catch (error) {
    setStatus(`could not load the audio processor: ${error.message}`, 'error');
    return;
  }

  // A second Play may have landed while addModule was in flight.
  if (isStreaming()) return;

  const node = new AudioWorkletNode(context, 'sid-stream', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: emulationOptions(),
  });

  node.onprocessorerror = () => {
    setStatus('the audio processor crashed', 'error');
    stop();
  };

  node.port.onmessage = ({ data }) => {
    if (data.type === 'error') {
      setStatus(data.message, 'error');
      stop();
      return;
    }
    if (data.type === 'ready') {
      streamHeader = `${data.clockName}, ${data.modelName}, ${data.sampleRate} Hz`;
      setStatus('streaming');
      setStats([streamHeader]);
      return;
    }
    if (data.type === 'status') {
      setStatus(`playing ${formatTime(data.elapsed)}`);
      const lines = [
        streamHeader,
        `${data.playCalls} play calls at ${data.playRate.toFixed(2)} Hz`,
      ];
      lines.push(`audio thread load ${(data.load * 100).toFixed(1)}% of its deadline`);
      if (data.cpuJammed) lines.push('the CPU hit an illegal opcode');
      setStats(lines);
    }
  };

  gainNode = context.createGain();
  gainNode.gain.value = Number(ui.volume.value);
  node.connect(gainNode).connect(context.destination);

  streamNode = node;
  refreshControls();
}

function stop() {
  if (!streamNode) {
    if (tune) setStatus('ready');
    refreshControls();
    return;
  }
  // Telling the processor to stop lets it return false and be collected;
  // disconnecting alone would leave it running silently.
  streamNode.port.postMessage('stop');
  streamNode.port.onmessage = null;
  streamNode.disconnect();
  if (gainNode) gainNode.disconnect();
  streamNode = null;
  gainNode = null;
  refreshControls();
  setStatus('ready');
}

/** Any change to what would be emulated restarts an in-flight stream. */
function restartIfPlaying() {
  if (!isStreaming()) return;
  stop();
  play();
}

// --- offline render, for the WAV export ------------------------------------

function renderOffline(context) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./render-worker.js', { type: 'module' });
    const finish = (fn, value) => {
      worker.terminate();
      fn(value);
    };

    worker.onerror = (event) => finish(
      reject,
      new Error(event.message || 'could not load render-worker.js'),
    );
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        ui.barFill.style.width = `${((data.written / data.total) * 100).toFixed(1)}%`;
      } else if (data.type === 'error') {
        finish(reject, new Error(data.message));
      } else {
        finish(resolve, data);
      }
    };

    worker.postMessage({
      ...emulationOptions(),
      seconds: exportSeconds(),
      sampleRate: context.sampleRate,
      normalize: true,
      gain: null,
    });
  });
}

async function download() {
  if (!tune || exporting) return;
  const context = ensureContext();
  const length = exportSeconds();

  exporting = true;
  refreshControls();
  ui.bar.hidden = false;
  ui.barFill.style.width = '0%';
  const wasStreaming = isStreaming();
  setStatus(`rendering ${formatTime(length)} for export…`);

  try {
    const data = await renderOffline(context);
    const wav = encodeWav(data.samples, data.sampleRate, 1);
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const link = document.createElement('a');
    const stem = (tune.name || 'tune').replace(/[^\w.-]+/g, '_');
    link.href = url;
    link.download = `${stem}.wav`;
    link.click();
    URL.revokeObjectURL(url);

    const s = data.stats;
    setStats([
      `${s.clockName}, ${s.modelName}`,
      `exported ${formatTime(length)} in ${s.elapsed.toFixed(1)}s `
        + `(${s.realtimeFactor.toFixed(1)}× realtime)`,
      `peak ${s.peak.toFixed(3)}, rms ${s.rms.toFixed(3)}, normalised by ${s.gain.toFixed(2)}`,
    ]);
    setStatus(wasStreaming ? 'exported; still playing' : 'exported');
  } catch (error) {
    setStatus(`export failed: ${error.message}`, 'error');
  } finally {
    exporting = false;
    ui.bar.hidden = true;
    refreshControls();
  }
}

// --- wiring ----------------------------------------------------------------

ui.file.addEventListener('change', () => {
  if (ui.file.files[0]) readFile(ui.file.files[0]);
});
ui.play.addEventListener('click', play);
ui.stop.addEventListener('click', stop);
ui.download.addEventListener('click', download);

ui.volume.addEventListener('input', () => {
  if (gainNode) gainNode.gain.value = Number(ui.volume.value);
});

for (const control of [ui.song, ui.model, ui.clock]) {
  control.addEventListener('change', () => {
    if (tune) showInfo(tune);
    restartIfPlaying();
  });
}

for (const type of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(type, (event) => {
    event.preventDefault();
    ui.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  ui.drop.addEventListener(type, (event) => {
    event.preventDefault();
    ui.drop.classList.remove('over');
  });
}
ui.drop.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) readFile(file);
});

if (!window.AudioContext) setStatus('this browser has no Web Audio', 'error');
refreshControls();
