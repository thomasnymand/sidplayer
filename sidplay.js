#!/usr/bin/env node
// Command line front end: parse a .sid file, emulate the C64 that plays it,
// and either write the result as a WAV or hand it to the system audio player.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { parseSidFile, songUsesCiaTiming, SidFileError } from './src/sidfile.js';
import { SidPlayer } from './src/player.js';
import { encodeWav, peakOf, rmsOf } from './src/wav.js';

const USAGE = `sidplay -- a MOS 6581/8580 SID simulator for the command line

Usage:
  node sidplay.js <file.sid> [options]

Options:
  -s, --song <n>         subsong to play (default: the file's start song)
  -t, --time <seconds>   how much to render (default: 180)
  -o, --out <file.wav>   write a WAV file instead of playing
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
      case '-t': case '--time': options.time = Number(needsValue(arg, argv[++i])); break;
      case '-o': case '--out': options.out = needsValue(arg, argv[++i]); break;
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

  process.stdout.write(`${tune.name || basename(options.file)}\n`);
  if (tune.author) process.stdout.write(`  by ${tune.author}\n`);
  if (tune.released) process.stdout.write(`  ${tune.released}\n`);
  process.stdout.write(
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
    process.stdout.write(
      `  init ${hex(tune.initAddress)} took ${player.initCycles} cycles (${initMs.toFixed(1)} ms)\n`
      + `  after init: CIA 1 timer A latch ${hex(player.cia1.latchA)}`
      + `, play period ${player.playPeriod} cycles`
      + ` = ${player.playRate.toFixed(2)} Hz\n`
      + `  resampler: ${player.resampler.description}\n`,
    );
  }

  const sampleCount = Math.round(options.time * options.rate);
  const renderStart = process.hrtime.bigint();
  const samples = player.render(sampleCount, (written, total) => {
    const percent = ((written / total) * 100).toFixed(0);
    process.stdout.write(
      `\r  rendering ${formatTime(written / options.rate)} / `
      + `${formatTime(total / options.rate)}  ${percent}%   `,
    );
  });
  const renderSeconds = Number(process.hrtime.bigint() - renderStart) / 1e9;
  process.stdout.write(
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
    process.stdout.write(
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
    process.stdout.write(`  wrote ${options.out} (${(wav.length / 1024 / 1024).toFixed(1)} MB)\n`);
    return;
  }

  const temp = join(tmpdir(), `sidplay-${process.pid}.wav`);
  writeFileSync(temp, wav);
  try {
    process.stdout.write(`  playing (${formatTime(options.time)}), press Ctrl-C to stop\n`);
    await playWav(temp);
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
