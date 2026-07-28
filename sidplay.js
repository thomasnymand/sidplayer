#!/usr/bin/env node
// Command line front end: parse a .sid file, emulate the C64 that plays it,
// and either write the result as a WAV or hand it to the system audio player.

import {
  readFileSync, writeFileSync, unlinkSync, accessSync, constants,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, basename, delimiter } from 'node:path';
import { parseSidFile, songUsesCiaTiming, SidFileError } from './src/sidfile.js';
import { SidPlayer } from './src/player.js';
import {
  encodeWav, encodePcm16, wavHeader, peakOf, rmsOf, WAV_LENGTH_UNKNOWN,
} from './src/wav.js';

// Level used when streaming. Normalisation needs the peak of the whole render,
// which no stream can know in advance, so this stands in for it: low enough
// that the loud tunes do not clip, since most peak somewhere near 1.5.
const STREAM_GAIN = 0.6;

const USAGE = `sidplay -- a MOS 6581/8580 SID simulator for the command line

Usage:
  node sidplay.js <file.sid> [options]

Options:
  -s, --song <n>         subsong to play (default: the file's start song)
  -t, --time <seconds>   how much to render (default: 180, 0 for no limit)
  -o, --out <file.wav>   write a WAV file instead of playing ('-' for stdout)
  -d, --direct           stream to the audio device as it is emulated, which
                         starts at once and, unless -t says otherwise, does
                         not stop
  -r, --rate <hz>        output sample rate (default: 44100)
  -m, --model <6581|8580>  override the SID model
  -c, --clock <pal|ntsc>   override the video standard
      --voices <mask>    which voices to play, e.g. 101 to mute voice 2
      --gain <x>         output gain; disables auto normalisation
      --no-normalize     keep the raw level instead of normalising
      --no-filter        bypass the SID filter (for debugging)
      --info             print the file's header and exit
      --dump-regs <n>    log SID register writes for the first n play calls
      --verbose          report timing, replay rate and per-voice levels
  -h, --help             show this message
`;

function parseArgs(argv) {
  const options = {
    file: null,
    song: null,
    time: 180,
    timeGiven: false,
    direct: false,
    out: null,
    rate: 44100,
    model: null,
    clock: null,
    voices: null,
    gain: null,
    normalize: true,
    filter: true,
    info: false,
    dumpRegs: 0,
    verbose: false,
    help: false,
  };

  const needsValue = (name, value) => {
    if (value === undefined) throw new Error(`${name} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '-s': case '--song': options.song = Number(needsValue(arg, argv[++i])); break;
      case '-t': case '--time':
        options.time = Number(needsValue(arg, argv[++i]));
        options.timeGiven = true;
        break;
      case '-o': case '--out': options.out = needsValue(arg, argv[++i]); break;
      case '-d': case '--direct': options.direct = true; break;
      case '-r': case '--rate': options.rate = Number(needsValue(arg, argv[++i])); break;
      case '-m': case '--model': options.model = needsValue(arg, argv[++i]); break;
      case '-c': case '--clock': options.clock = needsValue(arg, argv[++i]).toLowerCase(); break;
      case '--voices': options.voices = needsValue(arg, argv[++i]); break;
      case '--gain': options.gain = Number(needsValue(arg, argv[++i])); break;
      case '--no-normalize': options.normalize = false; break;
      case '--no-filter': options.filter = false; break;
      case '--info': options.info = true; break;
      case '--dump-regs': options.dumpRegs = Number(needsValue(arg, argv[++i])); break;
      case '--verbose': options.verbose = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        if (options.file) throw new Error('only one input file may be given');
        options.file = arg;
        break;
    }
  }
  return options;
}

const hex = (value, digits = 4) => `$${value.toString(16).toUpperCase().padStart(digits, '0')}`;

function formatTime(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function printInfo(tune, options) {
  const song = options.song || tune.startSong;
  const speedKind = songUsesCiaTiming(tune, song) ? 'CIA 1 timer A' : 'vertical blank';
  const lines = [
    ['Title', tune.name || '(none)'],
    ['Author', tune.author || '(none)'],
    ['Released', tune.released || '(none)'],
    ['Format', `${tune.magic} v${tune.version}`],
    ['Songs', `${tune.songs} (default ${tune.startSong})`],
    ['Load', `${hex(tune.loadAddress)}-${hex(tune.endAddress)} (${tune.data.length} bytes)`],
    ['Init', hex(tune.initAddress)],
    ['Play', tune.playAddress ? hex(tune.playAddress) : 'interrupt driven'],
    ['Clock', tune.clockName],
    ['SID model', tune.sidModelName],
    ['Speed', `${hex(tune.speed, 8)} -- song ${song} uses ${speedKind}`],
    ['Free pages', tune.startPage
      ? `${hex(tune.startPage << 8)}-${hex(((tune.startPage + tune.pageLength) << 8) - 1)}`
      : 'none declared'],
  ];
  if (tune.secondSidAddress) lines.push(['Second SID', hex(tune.secondSidAddress)]);
  if (tune.thirdSidAddress) lines.push(['Third SID', hex(tune.thirdSidAddress)]);

  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
}

function installRegisterTrace(player, playCallLimit) {
  const sid = player.sids[0];
  const original = sid.write.bind(sid);
  const names = [
    'FREQ1LO', 'FREQ1HI', 'PW1LO', 'PW1HI', 'CTRL1', 'AD1', 'SR1',
    'FREQ2LO', 'FREQ2HI', 'PW2LO', 'PW2HI', 'CTRL2', 'AD2', 'SR2',
    'FREQ3LO', 'FREQ3HI', 'PW3LO', 'PW3HI', 'CTRL3', 'AD3', 'SR3',
    'FCLO', 'FCHI', 'RESFILT', 'MODEVOL',
  ];
  sid.write = (reg, value) => {
    if (player.playCalls <= playCallLimit) {
      const name = names[reg & 0x1f] || `REG${(reg & 0x1f).toString(16)}`;
      process.stdout.write(
        `  call ${String(player.playCalls).padStart(4)}  `
        + `${hex(0xd400 + (reg & 0x1f))} ${name.padEnd(8)} = `
        + `${hex(value, 2)}\n`,
      );
    }
    original(reg, value);
  };
}

// Players that accept raw PCM on stdin. afplay is deliberately absent: it takes
// a file path and nothing else, which is the whole reason the default path
// renders to a temporary file first.
const PCM_PLAYERS = [
  {
    command: 'ffplay',
    // No channel option: the raw demuxer already defaults to mono, and the flag
    // that sets it was renamed (-ac to -ch_layout) in ffmpeg 8, so leaving it
    // out is the only spelling that works on every version.
    args: (rate) => [
      '-f', 's16le', '-ar', String(rate),
      '-nodisp', '-autoexit', '-loglevel', 'error', '-i', '-',
    ],
  },
  {
    command: 'play', // sox
    args: (rate) => [
      '-t', 'raw', '-e', 'signed', '-b', '16', '-c', '1', '-r', String(rate), '-q', '-',
    ],
  },
  {
    command: 'pw-play',
    args: (rate) => ['--format=s16', `--rate=${rate}`, '--channels=1', '-'],
  },
  {
    command: 'aplay',
    args: (rate) => ['-f', 'S16_LE', '-c', '1', '-r', String(rate), '-q', '-'],
  },
];

/** Look up an executable on PATH without shelling out to do it. */
function findExecutable(command) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, command);
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not in this directory */ }
  }
  return null;
}

function findPcmPlayer() {
  for (const entry of PCM_PLAYERS) {
    const path = findExecutable(entry.command);
    if (path) return { ...entry, path };
  }
  return null;
}

/**
 * Emulate straight into a writable stream.
 *
 * Backpressure is what makes this work: emulation runs about twenty times
 * faster than realtime, so the pipe fills almost immediately and every
 * subsequent write waits for drain. The player's own buffer sets the pace.
 */
async function streamSamples(player, sink, sampleCount, gain, { onProgress, cancelled }) {
  let written = 0;
  let lastReport = 0;

  for (const chunk of player.chunks(sampleCount)) {
    if (cancelled() || sink.destroyed || sink.writableEnded) break;
    if (!sink.write(encodePcm16(chunk, chunk.length, gain))) {
      try {
        await once(sink, 'drain');
      } catch {
        break; // the reader went away
      }
    }
    written += chunk.length;
    if (onProgress && written - lastReport >= player.sampleRate) {
      lastReport = written;
      onProgress(written);
    }
  }
  return written;
}

/** Stream to a system audio player, for as long as it will listen. */
async function playDirect(found, player, options, gain, report) {
  const child = spawn(found.path, found.args(options.rate), {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  const exited = once(child, 'exit');

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  // The child exiting first turns the next write into EPIPE; that is a normal
  // way for this to end, not an error worth reporting.
  child.stdin.on('error', stop);
  child.on('exit', stop);
  child.on('error', (error) => {
    stopping = true;
    report.write(`\n  ${found.command} failed to start: ${error.message}\n`);
  });

  const sampleCount = options.time > 0 ? Math.round(options.time * options.rate) : Infinity;
  report.write(
    `  streaming through ${found.command}`
    + `${Number.isFinite(sampleCount) ? ` for ${formatTime(options.time)}` : ''}`
    + ', press Ctrl-C to stop\n',
  );

  await streamSamples(player, child.stdin, sampleCount, gain, {
    cancelled: () => stopping,
    // Counts what has gone into the pipe, which leads what is audible by
    // however much the player has buffered, so do not call it "playing".
    onProgress: (written) => report.write(
      `\r  streamed ${formatTime(written / options.rate)}    `,
    ),
  });
  report.write('\n');

  // Let whatever is already buffered finish playing rather than cutting it off.
  if (!stopping) child.stdin.end();
  else child.kill('SIGTERM');
  await exited;
  process.off('SIGINT', stop);
  return 0;
}

/** Stream a WAV to stdout, for piping somewhere else. */
async function streamToStdout(player, options, gain) {
  const sampleCount = options.time > 0 ? Math.round(options.time * options.rate) : Infinity;
  let broken = false;
  process.stdout.on('error', () => { broken = true; }); // e.g. piped into head

  process.stdout.write(wavHeader(
    options.rate,
    Number.isFinite(sampleCount) ? sampleCount * 2 : WAV_LENGTH_UNKNOWN,
  ));
  await streamSamples(player, process.stdout, sampleCount, gain, {
    cancelled: () => broken,
  });
  return 0;
}

function playWav(path) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      process.stderr.write(
        `Automatic playback only knows about macOS's afplay.\n`
        + `The rendered audio is at ${path}\n`,
      );
      resolve(false);
      return;
    }
    const child = spawn('afplay', [path], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`afplay exited with code ${code}`));
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.help || !options.file) {
    process.stdout.write(USAGE);
    process.exitCode = options.file ? 0 : 1;
    return;
  }

  let tune;
  try {
    tune = parseSidFile(readFileSync(options.file));
  } catch (error) {
    if (error instanceof SidFileError || error.code === 'ENOENT' || error.code === 'EACCES') {
      const reason = error.code === 'ENOENT' ? 'no such file'
        : error.code === 'EACCES' ? 'permission denied'
          : error.message;
      process.stderr.write(`${options.file}: ${reason}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  // Streaming has no natural length, so --direct runs until stopped unless a
  // time was actually asked for.
  if (options.direct && !options.timeGiven) options.time = 0;

  const streaming = options.direct || options.out === '-';
  if (!(options.time >= 0) || !Number.isFinite(options.time)) {
    process.stderr.write(`--time must be a number of seconds, or 0 for no limit\n`);
    process.exitCode = 2;
    return;
  }
  if (options.time === 0 && !streaming) {
    process.stderr.write('--time 0 only makes sense with --direct or -o -\n');
    process.exitCode = 2;
    return;
  }

  const song = options.song || tune.startSong;
  if (song < 1 || song > tune.songs) {
    process.stderr.write(`song ${song} is out of range (1-${tune.songs})\n`);
    process.exitCode = 1;
    return;
  }

  if (options.info) {
    printInfo(tune, options);
    return;
  }

  let voices = null;
  if (options.voices) {
    if (!/^[01]{3}$/.test(options.voices)) {
      process.stderr.write('--voices takes three binary digits, e.g. 101\n');
      process.exitCode = 1;
      return;
    }
    voices = [...options.voices].map((c) => c === '1');
  }

  const player = new SidPlayer(tune, {
    sampleRate: options.rate,
    model: options.model,
    clock: options.clock,
    voices,
    noFilter: !options.filter,
  });

  // With the audio itself going to stdout, everything meant for a human has to
  // move aside or it would corrupt the stream.
  const toStdout = options.out === '-';
  const report = toStdout ? process.stderr : process.stdout;

  report.write(`${tune.name || basename(options.file)}\n`);
  if (tune.author) report.write(`  by ${tune.author}\n`);
  if (tune.released) report.write(`  ${tune.released}\n`);
  report.write(
    `  ${player.timing.name}, ${player.model === 2 ? 'MOS8580' : 'MOS6581'}`
    + `, song ${song} of ${tune.songs}\n`,
  );

  if (options.dumpRegs > 0) installRegisterTrace(player, options.dumpRegs);

  const initStart = process.hrtime.bigint();
  player.init(song);
  const initMs = Number(process.hrtime.bigint() - initStart) / 1e6;

  if (player.cpuJammed) {
    process.stderr.write('  warning: the CPU hit an illegal opcode and locked up\n');
  }

  if (options.verbose) {
    report.write(
      `  init ${hex(tune.initAddress)} took ${player.initCycles} cycles (${initMs.toFixed(1)} ms)\n`
      + `  after init: CIA 1 timer A latch ${hex(player.cia1.latchA)}`
      + `, play period ${player.playPeriod} cycles`
      + ` = ${player.playRate.toFixed(2)} Hz\n`
      + `  resampler: ${player.resampler.description}\n`,
    );
  }

  if (streaming) {
    // Find the player before announcing anything, so a machine without one
    // fails with that and nothing else.
    let found = null;
    if (options.direct) {
      found = findPcmPlayer();
      if (!found) {
        report.write(
          '  --direct needs a player that reads PCM on stdin; none of '
          + `${PCM_PLAYERS.map((p) => p.command).join(', ')} is on PATH\n`
          + '  install one, or drop --direct to render and hand the file to afplay\n',
        );
        process.exitCode = 1;
        return;
      }
    }

    // Nothing here has a complete buffer to inspect, so the peak is unknowable
    // and normalisation is off the table. A fixed gain stands in for it.
    const gain = options.gain !== null ? options.gain : STREAM_GAIN;
    if (options.gain === null) {
      report.write(
        `  streaming, so the level cannot be normalised; gain ${gain.toFixed(2)}`
        + ' (override with --gain)\n',
      );
    }
    process.exitCode = options.direct
      ? await playDirect(found, player, options, gain, report)
      : await streamToStdout(player, options, gain);
    return;
  }

  const sampleCount = Math.round(options.time * options.rate);
  const renderStart = process.hrtime.bigint();
  const samples = player.render(sampleCount, (written, total) => {
    const percent = ((written / total) * 100).toFixed(0);
    report.write(
      `\r  rendering ${formatTime(written / options.rate)} / `
      + `${formatTime(total / options.rate)}  ${percent}%   `,
    );
  });
  const renderSeconds = Number(process.hrtime.bigint() - renderStart) / 1e9;
  report.write(
    `\r  rendered ${formatTime(options.time)} in ${renderSeconds.toFixed(1)}s `
    + `(${(options.time / renderSeconds).toFixed(1)}x realtime)      \n`,
  );

  const peak = peakOf(samples);
  let gain = 1;
  if (options.gain !== null) gain = options.gain;
  else if (options.normalize && peak > 0) gain = 0.89 / peak;

  if (options.verbose) {
    const levels = player.voiceLevels.map((v) => `${(v * 100).toFixed(0)}%`).join(' ');
    // The tune may reprogram the timer well after init, so report what it
    // actually settled on rather than only the value init left behind.
    report.write(
      `  at end: CIA 1 timer A latch ${hex(player.cia1.latchA)}`
      + `, ${player.playRate.toFixed(2)} Hz`
      + ` (${(player.playCalls / options.time).toFixed(2)} Hz measured over the render)\n`
      + `  peak ${peak.toFixed(4)}, rms ${rmsOf(samples).toFixed(4)}, gain ${gain.toFixed(2)}\n`
      + `  play calls ${player.playCalls}, mean voice levels ${levels}\n`,
    );
  }

  if (peak === 0) {
    process.stderr.write('  warning: the rendered output is completely silent\n');
  }

  const wav = encodeWav(samples, options.rate, gain);

  if (options.out) {
    writeFileSync(options.out, wav);
    report.write(`  wrote ${options.out} (${(wav.length / 1024 / 1024).toFixed(1)} MB)\n`);
    return;
  }

  const temp = join(tmpdir(), `sidplay-${process.pid}.wav`);
  writeFileSync(temp, wav);
  try {
    report.write(`  playing (${formatTime(options.time)}), press Ctrl-C to stop\n`);
    await playWav(temp);
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
