#!/usr/bin/env node
// Test suite. Run with `npm test` or `node test/run.js`.
//
// The CPU tests cover the areas that quietly break music replay: flag
// behaviour, decimal mode, cycle counts around page boundaries, and the
// undocumented opcodes. Klaus Dormann's functional test is used too if it has
// been placed in this directory (see the README).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CPU6510 } from '../src/cpu6510.js';
import { EnvelopeGenerator, RATE_COUNTER_PERIOD } from '../src/sid/envelope.js';
import { SidResampler } from '../src/resample.js';
import { parseSidFile, songUsesCiaTiming } from '../src/sidfile.js';
import { SidPlayer, bankRegisterFor } from '../src/player.js';
import { peakOf, rmsOf } from '../src/wav.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `expected ${expected}, got ${actual}`);
}

function near(name, actual, expected, tolerance) {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
}

// --- CPU helpers ------------------------------------------------------------

function makeCPU() {
  const ram = new Uint8Array(0x10000);
  const cpu = new CPU6510({
    read: (addr) => ram[addr],
    write: (addr, value) => { ram[addr] = value; },
  });
  cpu.sp = 0xff;
  return { cpu, ram };
}

/** Load bytes at $0200, run one instruction, and return the cycles it took. */
function step(cpu, ram, bytes, at = 0x0200) {
  ram.set(bytes, at);
  cpu.pc = at;
  return cpu.step();
}

// --- CPU: flags and arithmetic ---------------------------------------------

{
  const { cpu, ram } = makeCPU();

  // Signed overflow: $50 + $50 = $A0, which is negative, so V is set.
  cpu.a = 0x50; cpu.c = 0; cpu.d = 0;
  step(cpu, ram, [0x69, 0x50]); // ADC #$50
  equal('ADC overflow result', cpu.a, 0xa0);
  equal('ADC overflow V', cpu.v, 1);
  equal('ADC overflow N', cpu.n, 1);
  equal('ADC overflow C', cpu.c, 0);

  // $50 + $10 stays in range, so V is clear.
  cpu.a = 0x50; cpu.c = 0;
  step(cpu, ram, [0x69, 0x10]);
  equal('ADC no overflow V', cpu.v, 0);

  // Carry out.
  cpu.a = 0xff; cpu.c = 1;
  step(cpu, ram, [0x69, 0x01]);
  equal('ADC carry result', cpu.a, 0x01);
  equal('ADC carry flag', cpu.c, 1);

  // SBC borrow.
  cpu.a = 0x50; cpu.c = 1; cpu.d = 0;
  step(cpu, ram, [0xe9, 0xb0]); // SBC #$B0
  equal('SBC overflow result', cpu.a, 0xa0);
  equal('SBC overflow V', cpu.v, 1);
  equal('SBC overflow C', cpu.c, 0);

  // CMP sets carry when the register is greater or equal.
  cpu.a = 0x40;
  step(cpu, ram, [0xc9, 0x40]);
  equal('CMP equal C', cpu.c, 1);
  equal('CMP equal Z', cpu.z, 1);
  cpu.a = 0x30;
  step(cpu, ram, [0xc9, 0x40]);
  equal('CMP less C', cpu.c, 0);
}

// --- CPU: decimal mode ------------------------------------------------------

{
  const { cpu, ram } = makeCPU();
  cpu.d = 1;

  cpu.a = 0x09; cpu.c = 0;
  step(cpu, ram, [0x69, 0x01]); // ADC #$01
  equal('BCD 09+01', cpu.a, 0x10);
  equal('BCD 09+01 C', cpu.c, 0);

  cpu.a = 0x99; cpu.c = 0;
  step(cpu, ram, [0x69, 0x01]);
  equal('BCD 99+01', cpu.a, 0x00);
  equal('BCD 99+01 C', cpu.c, 1);

  cpu.a = 0x58; cpu.c = 0;
  step(cpu, ram, [0x69, 0x46]);
  equal('BCD 58+46', cpu.a, 0x04);
  equal('BCD 58+46 C', cpu.c, 1);

  cpu.a = 0x00; cpu.c = 1;
  step(cpu, ram, [0xe9, 0x01]); // SBC #$01
  equal('BCD 00-01', cpu.a, 0x99);
  equal('BCD 00-01 C', cpu.c, 0);

  cpu.a = 0x46; cpu.c = 1;
  step(cpu, ram, [0xe9, 0x12]);
  equal('BCD 46-12', cpu.a, 0x34);
  equal('BCD 46-12 C', cpu.c, 1);
}

// --- CPU: cycle counts ------------------------------------------------------

{
  const { cpu, ram } = makeCPU();

  cpu.x = 0x01;
  equal('LDA abs,X no page cross', step(cpu, ram, [0xbd, 0x00, 0x30]), 4);
  cpu.x = 0x01;
  equal('LDA abs,X page cross', step(cpu, ram, [0xbd, 0xff, 0x30]), 5);

  // Stores always pay the indexing cycle, so no extra penalty applies.
  cpu.x = 0x01;
  equal('STA abs,X page cross', step(cpu, ram, [0x9d, 0xff, 0x30]), 5);

  // Branch: not taken 2, taken 3, taken across a page 4.
  cpu.z = 0;
  equal('BEQ not taken', step(cpu, ram, [0xf0, 0x10]), 2);
  cpu.z = 1;
  equal('BEQ taken', step(cpu, ram, [0xf0, 0x10]), 3);
  cpu.z = 1;
  equal('BEQ taken across page', step(cpu, ram, [0xf0, 0x7f], 0x02f0), 4);

  // The NMOS indirect-jump bug: a vector at $30FF reads its high byte from $3000.
  ram[0x30ff] = 0x34;
  ram[0x3000] = 0x12;
  ram[0x3100] = 0xff;
  step(cpu, ram, [0x6c, 0xff, 0x30]);
  equal('JMP (ind) page bug', cpu.pc, 0x1234);
}

// --- CPU: undocumented opcodes ---------------------------------------------

{
  const { cpu, ram } = makeCPU();

  ram[0x0050] = 0x77;
  step(cpu, ram, [0xa7, 0x50]); // LAX $50
  equal('LAX loads A', cpu.a, 0x77);
  equal('LAX loads X', cpu.x, 0x77);

  cpu.a = 0xf0; cpu.x = 0x3c;
  step(cpu, ram, [0x87, 0x51]); // SAX $51
  equal('SAX stores A AND X', ram[0x0051], 0x30);

  cpu.a = 0xf0; cpu.c = 0;
  step(cpu, ram, [0x0b, 0x80]); // ANC #$80
  equal('ANC result', cpu.a, 0x80);
  equal('ANC copies N into C', cpu.c, 1);

  cpu.a = 0xff;
  step(cpu, ram, [0x4b, 0x08]); // ALR #$08
  equal('ALR result', cpu.a, 0x04);
  equal('ALR carry', cpu.c, 0);

  cpu.a = 0x30; cpu.x = 0xf0;
  step(cpu, ram, [0xcb, 0x10]); // AXS #$10
  equal('AXS result', cpu.x, 0x20);
  equal('AXS carry', cpu.c, 1);

  ram[0x0060] = 0x05; cpu.a = 0x04;
  step(cpu, ram, [0xc7, 0x60]); // DCP $60
  equal('DCP decrements memory', ram[0x0060], 0x04);
  equal('DCP compares', cpu.z, 1);

  // An undefined opcode jams the CPU rather than doing something arbitrary.
  step(cpu, ram, [0x02]);
  check('undefined opcode jams', cpu.jammed === true);
}

// --- CPU: stack and interrupts ---------------------------------------------

{
  const { cpu, ram } = makeCPU();

  cpu.sp = 0xff;
  ram[0x1000] = 0x60; // RTS
  step(cpu, ram, [0x20, 0x00, 0x10]); // JSR $1000
  equal('JSR sets PC', cpu.pc, 0x1000);
  equal('JSR pushes two bytes', cpu.sp, 0xfd);
  cpu.step(); // RTS
  equal('RTS returns past the operand', cpu.pc, 0x0203);
  equal('RTS restores SP', cpu.sp, 0xff);

  // An IRQ is ignored while the interrupt disable flag is set.
  ram[0xfffe] = 0x00; ram[0xffff] = 0x40;
  cpu.i = 1;
  cpu.setIRQ(true);
  cpu.pc = 0x0300; ram[0x0300] = 0xea; // NOP
  cpu.step();
  equal('IRQ masked by I flag', cpu.pc, 0x0301);
  cpu.i = 0;
  cpu.step();
  equal('IRQ taken when enabled', cpu.pc, 0x4000);
  equal('IRQ sets I', cpu.i, 1);
}

// --- Envelope generator -----------------------------------------------------

{
  const env = new EnvelopeGenerator();
  env.writeAttackDecay(0x00); // fastest attack, fastest decay
  env.writeSustainRelease(0xf0); // sustain at maximum, fastest release
  env.writeControlReg(0x01); // gate on

  // The rate counter has to reach the period and then step, so one envelope
  // step costs period + 1 cycles. Attack climbs 0 to 255 in 255 such steps.
  let attackCycles = 0;
  while (env.output() !== 0xff && attackCycles < 100_000) {
    env.clock();
    attackCycles++;
  }
  equal('envelope reaches full after attack', env.output(), 0xff);
  equal('attack takes 255 steps', attackCycles, (RATE_COUNTER_PERIOD[0] + 1) * 255);

  // With sustain at maximum the level holds.
  for (let i = 0; i < 100000; i++) env.clock();
  equal('envelope holds at sustain', env.output(), 0xff);

  env.writeControlReg(0x00); // gate off
  for (let i = 0; i < 2_000_000; i++) env.clock();
  equal('envelope releases to zero', env.output(), 0x00);
}

{
  // Sustain level n should hold at n repeated in both nibbles.
  const env = new EnvelopeGenerator();
  env.writeAttackDecay(0x00);
  env.writeSustainRelease(0x80);
  env.writeControlReg(0x01);
  for (let i = 0; i < 500_000; i++) env.clock();
  equal('sustain level 8 holds at $88', env.output(), 0x88);
}

// --- Resampler --------------------------------------------------------------

{
  const inputRate = 985248;
  const outputRate = 44100;
  const resampler = new SidResampler(inputRate, outputRate);

  const runTone = (frequency) => {
    const total = inputRate; // one second
    const chunk = 16384;
    const input = new Float32Array(chunk);
    const output = new Float64Array(resampler.maxOutput(chunk));
    let produced = 0;
    let energy = 0;
    let phase = 0;
    const advance = (2 * Math.PI * frequency) / inputRate;
    for (let done = 0; done < total; done += chunk) {
      for (let i = 0; i < chunk; i++) {
        input[i] = Math.sin(phase);
        phase += advance;
      }
      const n = resampler.process(input, chunk, output);
      // Skip the filter's start-up transient.
      if (done > 0) for (let i = 0; i < n; i++) energy += output[i] * output[i];
      produced += n;
    }
    return { rms: Math.sqrt(energy / produced), produced };
  };

  const audible = runTone(1000);
  near('resampler output rate', audible.produced, outputRate, outputRate * 0.02);
  // A full scale sine has an RMS of 1/sqrt(2); the filter should pass it intact.
  near('resampler passes 1kHz', audible.rms, 0.707, 0.02);

  const aliasing = new SidResampler(inputRate, outputRate);
  // A 60kHz tone is far above the output Nyquist limit and must not fold back.
  let phase = 0;
  const chunk = 16384;
  const input = new Float32Array(chunk);
  const output = new Float64Array(aliasing.maxOutput(chunk));
  let energy = 0;
  let produced = 0;
  for (let done = 0; done < inputRate; done += chunk) {
    for (let i = 0; i < chunk; i++) {
      input[i] = Math.sin(phase);
      phase += (2 * Math.PI * 60000) / inputRate;
    }
    const n = aliasing.process(input, chunk, output);
    if (done > 0) for (let i = 0; i < n; i++) energy += output[i] * output[i];
    produced += n;
  }
  const rejectedRms = Math.sqrt(energy / produced);
  const attenuationDb = 20 * Math.log10(rejectedRms / 0.707);
  check(
    'resampler rejects 60kHz by at least 60dB',
    attenuationDb < -60,
    `attenuation was ${attenuationDb.toFixed(1)} dB`,
  );
}

// --- Bank register selection (spec.txt lines 482-487) -----------------------

{
  equal('bank register below $A000', bankRegisterFor(0x1000), 0x37);
  equal('bank register at $A000', bankRegisterFor(0xa000), 0x36);
  equal('bank register at $C000', bankRegisterFor(0xc000), 0x36);
  equal('bank register at $D000', bankRegisterFor(0xd000), 0x34);
  equal('bank register at $E000', bankRegisterFor(0xe000), 0x35);
}

// --- SID file parsing and end-to-end replay ---------------------------------

const tunePath = join(here, '..', 'Sanxion_Cover.sid');
if (existsSync(tunePath)) {
  const tune = parseSidFile(readFileSync(tunePath));
  equal('parses magic', tune.magic, 'PSID');
  equal('parses version', tune.version, 2);
  equal('resolves load address from the data', tune.loadAddress, 0xa000);
  equal('computes end address', tune.endAddress, 0xcbd3);
  equal('parses init address', tune.initAddress, 0xc000);
  equal('parses play address', tune.playAddress, 0xc020);
  equal('parses title', tune.name, 'Sanxion Cover');
  equal('parses author', tune.author, 'Tomas Danko');
  equal('decodes PAL clock', tune.clockName, 'PAL');
  equal('decodes 6581 model', tune.sidModelName, 'MOS6581');
  check('song 1 is CIA driven', songUsesCiaTiming(tune, 1) === true);

  const player = new SidPlayer(tune, { sampleRate: 44100 });
  player.init(1);
  equal('$02A6 marks PAL', player.memory.ram[0x02a6], 0x01);
  check('CPU did not jam during init', player.cpuJammed === false);

  // Twenty seconds is long enough for all three voices to have entered.
  const samples = player.render(44100 * 20);
  const peak = peakOf(samples);
  const rms = rmsOf(samples);
  check('replay produces audio', peak > 0.01, `peak was ${peak}`);
  check('replay is not clipped flat', rms > 0.005 && rms < peak, `rms ${rms}, peak ${peak}`);

  let dc = 0;
  for (let i = 0; i < samples.length; i++) dc += samples[i];
  dc /= samples.length;
  check('output has no DC offset', Math.abs(dc) < 0.01, `dc was ${dc}`);

  // The tune reprograms CIA 1 timer A from its own data; if the CPU or CIA were
  // broken this would still read the $4025 default the environment installs.
  equal('tune reprogrammed the CIA timer', player.cia1.latchA, 0x6f00);
  near('replay rate', player.playRate, 34.67, 0.1);

  const levels = player.voiceLevels;
  for (let v = 0; v < 3; v++) {
    check(`voice ${v + 1} is used`, levels[v] > 0.01, `mean level ${levels[v]}`);
  }
} else {
  process.stdout.write('note: Sanxion_Cover.sid not found, skipping replay tests\n');
}

// --- Klaus Dormann's 6502 functional test (optional) ------------------------

const functionalTest = join(here, '6502_functional_test.bin');
if (existsSync(functionalTest)) {
  const image = readFileSync(functionalTest);
  const ram = new Uint8Array(0x10000);
  ram.set(image.subarray(0, Math.min(image.length, 0x10000)), 0);
  const cpu = new CPU6510({
    read: (addr) => ram[addr],
    write: (addr, value) => { ram[addr] = value; },
  });
  cpu.reset();
  cpu.pc = 0x0400;

  let previousPc = -1;
  let steps = 0;
  const LIMIT = 500_000_000;
  while (steps < LIMIT) {
    previousPc = cpu.pc;
    cpu.step();
    steps++;
    // Every trap in the suite is a branch to itself.
    if (cpu.pc === previousPc) break;
    if (cpu.jammed) break;
  }
  // The standard build reports success by trapping at $3469.
  check(
    'Dormann functional test passes',
    cpu.pc === 0x3469,
    `trapped at $${cpu.pc.toString(16).toUpperCase()} after ${steps} steps`,
  );
} else {
  process.stdout.write(
    'note: test/6502_functional_test.bin not found, skipping the full 6502 suite\n',
  );
}

// --- report -----------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exitCode = 1;
}
