// Builds the emulated C64, sets up the environment the SID file format
// mandates, and drives init/play while collecting audio.

import { CPU6510 } from './cpu6510.js';
import { C64Memory } from './memory.js';
import { CIA } from './cia.js';
import { VIC } from './vic.js';
import { SIDChip } from './sid/chip.js';
import { SidResampler } from './resample.js';
import {
  songUsesCiaTiming, resolveClock, resolveModel, clockConstants, CLOCK_NTSC,
} from './sidfile.js';

// RTS from init/play lands here; the address is never executed because the run
// loop checks for it first.
const SENTINEL = 0xffff;

// A runaway init or play routine is cut off rather than hanging the process.
const CALL_CYCLE_LIMIT = 30_000_000;

/** Bank register value the environment requires for a call to `address`. */
export function bankRegisterFor(address) {
  if (address < 0xa000) return 0x37; // I/O, KERNAL and BASIC
  if (address < 0xd000) return 0x36; // I/O and KERNAL, RAM at $A000
  if (address >= 0xe000) return 0x35; // I/O only
  return 0x34;                        // RAM only
}

export class SidPlayer {
  /**
   * @param {object} tune parsed by parseSidFile()
   * @param {object} [options]
   */
  constructor(tune, options = {}) {
    this.tune = tune;
    this.sampleRate = options.sampleRate || 44100;

    this.clock = resolveClock(tune, options.clock);
    this.timing = clockConstants(this.clock);
    this.model = resolveModel(tune.sidModel, options.model);

    const bases = [0xd400];
    if (tune.secondSidAddress) bases.push(tune.secondSidAddress);
    if (tune.thirdSidAddress) bases.push(tune.thirdSidAddress);
    this.sidBases = bases;

    const models = [
      this.model,
      resolveModel(tune.secondSidModel, options.model),
      resolveModel(tune.thirdSidModel, options.model),
    ];
    this.sids = bases.map((_, i) => new SIDChip(models[i], this.timing.cpuClock));

    this.cia1 = new CIA('cia1');
    this.cia2 = new CIA('cia2');
    this.vic = new VIC(this.timing);
    this.memory = new C64Memory({
      sids: this.sids,
      sidBases: bases,
      cia1: this.cia1,
      cia2: this.cia2,
      vic: this.vic,
    });
    this.cpu = new CPU6510(this.memory);

    this.resampler = new SidResampler(this.timing.cpuClock, this.sampleRate);

    if (options.voices) {
      for (const sid of this.sids) {
        for (let v = 0; v < 3; v++) sid.setMute(v, !options.voices[v]);
      }
    }
    if (options.noFilter) {
      for (const sid of this.sids) sid.setFilterEnabled(false);
    }

    this.song = tune.startSong;
    this.usesCia = false;
    this.cycles = 0;
    this.playCalls = 0;
    this.voiceActivity = [0, 0, 0];
    this.activitySamples = 0;
    this.initCycles = 0;
    this.cpuJammed = false;
  }

  /** Cycles between play calls as currently configured. */
  get playPeriod() {
    return this.usesCia ? this.cia1.timerAPeriod : this.timing.cyclesPerFrame;
  }

  /** Effective replay rate in Hz. */
  get playRate() {
    return this.timing.cpuClock / this.playPeriod;
  }

  /**
   * Reset the machine, install the tune and run its init routine.
   * @param {number} song 1-based song number
   */
  init(song = this.tune.startSong) {
    const tune = this.tune;
    this.song = song;
    this.usesCia = songUsesCiaTiming(tune, song);

    this.memory.reset();
    this.memory.loadImage(tune.loadAddress, tune.data);
    for (const sid of this.sids) sid.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.vic.reset();
    this.cpu.reset();

    // The video standard is published to the tune at $02A6.
    this.memory.ram[0x02a6] = this.clock === CLOCK_NTSC ? 0x00 : 0x01;

    // CIA 1 Timer A runs at 60Hz; every other timer is stopped and holds $FFFF.
    this.cia1.setTimerA(this.timing.ciaDefault, true);
    this.cia1.setTimerB(0xffff, false);
    this.cia2.setTimerA(0xffff, false);
    this.cia2.setTimerB(0xffff, false);
    this.cia1.write(0x0d, this.usesCia ? 0x81 : 0x7f);

    // A raster interrupt stands in for the vertical blank when the tune is not
    // CIA driven.
    if (!this.usesCia) {
      this.vic.write(0x12, 0x00);
      this.vic.write(0x1a, 0x01);
    } else {
      this.vic.write(0x1a, 0x00);
    }

    // With no play address the tune installs its own interrupt handler, so the
    // interrupt lines have to actually reach the CPU. When we call play
    // ourselves, wiring them up would only fight with our own scheduling.
    this.interruptDriven = tune.playAddress === 0;

    this.memory.setBankRegister(tune.isRsid ? 0x37 : bankRegisterFor(tune.initAddress));

    // Init takes the song number in the accumulator, counting from zero.
    this.initCycles = this.runCall(tune.initAddress, (song - 1) & 0xff, 0, 0);

    // Start the play clock from a known point.
    this.cia1.counterA = this.cia1.latchA;
    this.vic.frameCycle = 0;
    this.cyclesToPlay = this.playPeriod;
    this.pendingPlayCalls = 0;
    this.cyclesSincePlay = 0;
    this.cycles = 0;
    this.playCalls = 0;
    this.voiceActivity = [0, 0, 0];
    this.activitySamples = 0;
  }

  /** Prime the CPU to execute a subroutine, returning to the sentinel. */
  beginCall(address, a = 0, x = 0, y = 0) {
    const cpu = this.cpu;
    cpu.a = a & 0xff;
    cpu.x = x & 0xff;
    cpu.y = y & 0xff;
    cpu.sp = 0xff;
    cpu.jammed = false;
    // RTS adds one to the address it pulls, so push the sentinel minus one.
    cpu.push(((SENTINEL - 1) >> 8) & 0xff);
    cpu.push((SENTINEL - 1) & 0xff);
    cpu.pc = address & 0xffff;
  }

  /**
   * Run a subroutine to completion without collecting audio. Used for init,
   * where the SID output does not matter but register writes do.
   */
  runCall(address, a, x, y) {
    this.memory.setBankRegister(
      this.tune.isRsid ? 0x37 : bankRegisterFor(address),
    );
    this.beginCall(address, a, x, y);
    let cycles = 0;
    while (this.cpu.pc !== SENTINEL && cycles < CALL_CYCLE_LIMIT) {
      const step = this.cpu.step();
      cycles += step;
      this.cia1.clock(step);
      this.cia2.clock(step);
      this.vic.clock(step);
      if (this.cpu.jammed) {
        this.cpuJammed = true;
        break;
      }
    }
    return cycles;
  }

  /** Update the CPU's interrupt inputs from the CIA and VIC. */
  updateInterruptLines() {
    if (!this.interruptDriven) return;
    this.cpu.setIRQ(this.cia1.irq || this.vic.irq);
    this.cpu.setNMI(this.cia2.irq);
  }

  /**
   * Render audio.
   *
   * @param {number} sampleCount how many output samples to produce
   * @param {(written:number, total:number)=>void} [onProgress]
   * @returns {Float64Array} mono samples, nominally in [-1, 1]
   */
  render(sampleCount, onProgress) {
    const result = new Float64Array(sampleCount);
    let written = 0;
    let lastProgress = 0;

    for (const chunk of this.chunks(sampleCount)) {
      result.set(chunk, written);
      written += chunk.length;

      if (onProgress && written - lastProgress > this.sampleRate) {
        lastProgress = written;
        onProgress(written, sampleCount);
      }
    }
    if (onProgress) onProgress(sampleCount, sampleCount);
    return result;
  }

  /**
   * Produce output samples a chunk at a time, for as long as the caller keeps
   * asking. This is what playing without rendering first is built on: there is
   * no buffer to fill and no length to decide in advance.
   *
   * The yielded array is a view onto a buffer that is reused on the next
   * iteration, so copy or write it out before asking for more.
   *
   * @param {number} [sampleCount] stop after this many; omit to run forever
   * @yields {Float64Array} mono samples, nominally in [-1, 1]
   */
  * chunks(sampleCount = Infinity) {
    // A generous slack lets a single instruction (or interrupt entry) overrun
    // the chunk boundary without bounds checks in the inner loop.
    const CHUNK = 16384;
    const sidBuffer = new Float32Array(CHUNK + 64);
    const outBuffer = new Float64Array(this.resampler.maxOutput(CHUNK + 64));

    let written = 0;
    while (written < sampleCount) {
      const filled = this.runCycles(CHUNK, sidBuffer);
      const produced = this.resampler.process(sidBuffer, filled, outBuffer);
      const take = Math.min(produced, sampleCount - written);
      yield outBuffer.subarray(0, take);
      written += take;
    }
  }

  /**
   * Advance the machine until at least `target` SID samples have been produced.
   * @returns {number} samples actually written into `buffer`
   */
  runCycles(target, buffer) {
    const cpu = this.cpu;
    const cia1 = this.cia1;
    const cia2 = this.cia2;
    const vic = this.vic;
    const sids = this.sids;
    const sidCount = sids.length;
    let filled = 0;

    while (filled < target) {
      // Schedule a play call if one is due and the CPU has nothing to do.
      if (!this.interruptDriven && cpu.pc === SENTINEL && this.pendingPlayCalls > 0) {
        this.pendingPlayCalls--;
        this.memory.setBankRegister(bankRegisterFor(this.tune.playAddress));
        this.beginCall(this.tune.playAddress);
        this.playCalls++;
        this.sampleVoiceActivity();
      }

      const idle = cpu.pc === SENTINEL
        && !(cpu.irqLine && !cpu.i)
        && !cpu.nmiEdge;

      let step;
      if (idle) {
        // Nothing to execute: jump straight to whichever event comes first
        // rather than stepping cycle by cycle.
        step = Math.min(target - filled, this.cyclesToNextEvent());
        if (step < 1) step = 1;
      } else {
        step = cpu.step();
        if (cpu.jammed) {
          this.cpuJammed = true;
          cpu.pc = SENTINEL; // treat a locked-up CPU as idle so audio keeps flowing
          cpu.jammed = false;
        }
      }

      // Devices and the SID advance together so register writes land in the
      // right place in the audio stream.
      const underflows = cia1.clock(step);
      cia2.clock(step);
      vic.clock(step);
      this.updateInterruptLines();

      for (let i = 0; i < sidCount; i++) {
        sids[i].clock(step, buffer, filled, i > 0);
      }
      filled += step;
      this.cycles += step;

      this.advancePlayClock(step, underflows);
    }

    return filled;
  }

  /** Cycles until the next thing that could change the machine's state. */
  cyclesToNextEvent() {
    if (this.interruptDriven) {
      // An interrupt could arrive from either timer or the raster.
      let next = this.cia1.counterA + 1;
      if (this.vic.irqMask & 0x01) {
        const line = this.vic.rasterLine;
        const target = this.vic.rasterCompare;
        const lines = target > line
          ? target - line
          : this.vic.rasterLines - line + target;
        next = Math.min(next, lines * this.vic.cyclesPerLine);
      }
      return Math.max(1, Math.min(next, 5000));
    }
    return Math.max(1, this.cyclesToPlay);
  }

  /** Track when the next play call is due. */
  advancePlayClock(step, timerAUnderflows) {
    if (this.interruptDriven) return;

    if (this.usesCia) {
      // Driving play calls off real timer underflows means a tune that
      // reprograms $DC04/$DC05 mid-song changes tempo exactly as it would on
      // hardware.
      if (timerAUnderflows > 0) {
        this.pendingPlayCalls = Math.min(this.pendingPlayCalls + timerAUnderflows, 2);
        this.cyclesSincePlay = 0;
      } else {
        this.cyclesSincePlay += step;
        // If the tune stops the timer entirely, fall back to frame rate rather
        // than going silent.
        if (this.cyclesSincePlay > this.timing.cyclesPerFrame * 4) {
          this.cyclesSincePlay = 0;
          this.pendingPlayCalls = Math.min(this.pendingPlayCalls + 1, 2);
        }
      }
      this.cyclesToPlay = this.cia1.counterA + 1;
    } else {
      this.cyclesToPlay -= step;
      while (this.cyclesToPlay <= 0) {
        this.cyclesToPlay += this.timing.cyclesPerFrame;
        this.pendingPlayCalls = Math.min(this.pendingPlayCalls + 1, 2);
      }
    }
  }

  sampleVoiceActivity() {
    const sid = this.sids[0];
    for (let v = 0; v < 3; v++) {
      this.voiceActivity[v] += sid.envelopes[v].output();
    }
    this.activitySamples++;
  }

  /** Mean envelope level per voice since init, as a 0-1 fraction. */
  get voiceLevels() {
    if (!this.activitySamples) return [0, 0, 0];
    return this.voiceActivity.map((sum) => sum / this.activitySamples / 255);
  }
}
