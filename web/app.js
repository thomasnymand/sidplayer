// Browser front end. Parses the file on the main thread for immediate feedback,
// renders in a worker, and plays the result through Web Audio.
//
// Rendering is not a step the listener has to think about: Play renders first
// when the current settings have not been rendered yet, and replays the buffer
// it already has when they have.

import { parseSidFile, songUsesCiaTiming, SidFileError } from '../src/sidfile.js';
import { encodeWav } from '../src/wav.js';

const $ = (id) => document.getElementById(id);

const ui = {
  drop: $('drop'),
  file: $('file'),
  info: $('info'),
  controls: $('controls'),
  song: $('song'),
  time: $('time'),
  model: $('model'),
  clock: $('clock'),
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
let tuneSerial = 0;
let worker = null;
let audioContext = null;
let audioBuffer = null;
let samples = null;
let renderedKey = null;
let source = null;
let playStartedAt = 0;
let ticker = 0;

const hex = (value, digits = 4) => `$${value.toString(16).toUpperCase().padStart(digits, '0')}`;

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setStatus(message, kind = '') {
  ui.status.textContent = message;
  ui.status.className = kind;
}

const seconds = () => Math.max(1, Math.min(600, Number(ui.time.value) || 180));
const selectedSong = () => Number(ui.song.value) || (tune ? tune.startSong : 1);

/**
 * Identity of the audio the current settings would produce. A rendered buffer
 * is reusable only while this is unchanged, which is what stops Play from
 * replaying the previous song after the dropdown moves.
 */
function currentKey() {
  if (!tune || !audioContext) return null;
  return [
    tuneSerial, selectedSong(), seconds(),
    ui.model.value, ui.clock.value, audioContext.sampleRate,
  ].join('|');
}

const isFresh = () => audioBuffer !== null && renderedKey !== null && renderedKey === currentKey();

function refreshControls() {
  const rendering = worker !== null;
  ui.play.disabled = !tune || rendering || source !== null;
  ui.stop.disabled = !rendering && source === null;
  ui.download.hidden = !isFresh();
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
  audioBuffer = null;
  samples = null;
  renderedKey = null;
  ui.stats.hidden = true;
  ui.bar.hidden = true;

  try {
    tune = parseSidFile(raw);
  } catch (error) {
    tune = null;
    bytes = null;
    ui.info.hidden = true;
    ui.controls.hidden = true;
    refreshControls();
    setStatus(
      error instanceof SidFileError ? `${label}: ${error.message}` : String(error),
      'error',
    );
    return;
  }

  bytes = raw;
  tuneSerial++;
  ui.song.innerHTML = Array.from(
    { length: tune.songs },
    (_, i) => `<option value="${i + 1}">${i + 1}</option>`,
  ).join('');
  ui.song.value = String(tune.startSong);
  ui.song.disabled = tune.songs < 2;

  showInfo(tune);
  ui.controls.hidden = false;
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

/** Emulate the tune into an AudioBuffer, then play it. */
function render(context, key) {
  worker = new Worker('./render-worker.js', { type: 'module' });
  const length = seconds();

  ui.stats.hidden = true;
  ui.bar.hidden = false;
  ui.barFill.style.width = '0%';
  refreshControls();
  setStatus(`rendering ${formatTime(length)} at ${context.sampleRate} Hz…`);

  const fail = (message) => {
    setStatus(message, 'error');
    ui.bar.hidden = true;
    if (worker) worker.terminate();
    worker = null;
    refreshControls();
  };

  worker.onerror = (event) => {
    // A worker that fails to load at all reports no message, only a bare event.
    fail(`render worker failed: ${event.message || 'could not load render-worker.js'}`);
  };

  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      ui.barFill.style.width = `${((data.written / data.total) * 100).toFixed(1)}%`;
      return;
    }
    if (data.type === 'error') {
      fail(data.message);
      return;
    }

    samples = data.samples;
    audioBuffer = context.createBuffer(1, samples.length, data.sampleRate);
    audioBuffer.copyToChannel(samples, 0);
    renderedKey = key;

    const s = data.stats;
    ui.stats.innerHTML = [
      `${s.clockName}, ${s.modelName}`,
      `rendered in ${s.elapsed.toFixed(1)}s (${s.realtimeFactor.toFixed(1)}× realtime)`,
      `peak ${s.peak.toFixed(3)}, rms ${s.rms.toFixed(3)}, gain ${s.gain.toFixed(2)}`,
      `${s.playCalls} play calls at ${s.playRate.toFixed(2)} Hz`,
    ].map((line) => `<span>${line}</span>`).join('');
    ui.stats.hidden = false;

    worker.terminate();
    worker = null;

    if (s.cpuJammed) setStatus('the CPU hit an illegal opcode; playing anyway', 'warn');
    else if (s.peak === 0) setStatus('the rendered output is silent', 'warn');

    startPlayback(context);
  };

  worker.postMessage({
    bytes,
    song: selectedSong(),
    seconds: length,
    sampleRate: context.sampleRate,
    model: ui.model.value || null,
    clock: ui.clock.value || null,
    normalize: true,
    gain: null,
  });
}

function tick() {
  if (!source || !audioContext) return;
  const elapsed = audioContext.currentTime - playStartedAt;
  const total = audioBuffer.duration;
  ui.barFill.style.width = `${Math.min(100, (elapsed / total) * 100).toFixed(2)}%`;
  setStatus(`playing ${formatTime(elapsed)} / ${formatTime(total)}`);
  ticker = requestAnimationFrame(tick);
}

function startPlayback(context) {
  if (!audioBuffer) return;

  source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(context.destination);
  source.onended = () => {
    // Fires on natural end and on stop(); either way the UI goes back to idle.
    cancelAnimationFrame(ticker);
    source = null;
    ui.bar.hidden = true;
    refreshControls();
    setStatus('ready');
  };
  source.start();
  playStartedAt = context.currentTime;

  ui.bar.hidden = false;
  refreshControls();
  ticker = requestAnimationFrame(tick);
}

/** The one entry point: render if these settings are not rendered yet, then play. */
function play() {
  if (!tune || worker) return;
  const context = ensureContext();
  const key = currentKey();
  if (isFresh()) startPlayback(context);
  else render(context, key);
}

function stopPlayback() {
  cancelAnimationFrame(ticker);
  if (!source) return;
  source.onended = null;
  try { source.stop(); } catch { /* already stopped */ }
  source.disconnect();
  source = null;
  ui.bar.hidden = true;
}

/** Stop cancels playback and an in-flight render alike. */
function stop() {
  const wasRendering = worker !== null;
  if (worker) {
    worker.terminate();
    worker = null;
    ui.bar.hidden = true;
  }
  stopPlayback();
  refreshControls();
  if (wasRendering) setStatus('render cancelled');
  else if (tune) setStatus('ready');
}

function download() {
  if (!samples || !audioBuffer) return;
  // The worker already folded the gain in, so encode at unity.
  const wav = encodeWav(samples, audioBuffer.sampleRate, 1);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const link = document.createElement('a');
  const stem = (tune.name || 'tune').replace(/[^\w.-]+/g, '_');
  link.href = url;
  link.download = `${stem}.wav`;
  link.click();
  URL.revokeObjectURL(url);
}

ui.file.addEventListener('change', () => {
  if (ui.file.files[0]) readFile(ui.file.files[0]);
});
ui.play.addEventListener('click', play);
ui.stop.addEventListener('click', stop);
ui.download.addEventListener('click', download);

// Any setting that changes the audio retires the rendered buffer, so the next
// Play re-emulates instead of replaying something stale.
for (const control of [ui.song, ui.time, ui.model, ui.clock]) {
  control.addEventListener('change', () => {
    if (tune) showInfo(tune);
    refreshControls();
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

if (!window.Worker || !window.AudioContext) {
  setStatus('this browser is missing Web Audio or module workers', 'error');
}
refreshControls();
