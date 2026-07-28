// MOS 6526 CIA -- only the parts that matter for music replay: the two 16-bit
// interval timers and the interrupt control register. Ports, the serial shift
// register and the time-of-day clock are present as storage so that reads and
// writes behave sanely, but they have no side effects.

const CRA_START = 0x01;
const CRA_RUNMODE = 0x08; // 1 = one shot
const CRA_LOAD = 0x10;    // strobe: force latch into counter
const CRA_INMODE = 0x20;  // 0 = count phi2, 1 = count CNT pulses

const ICR_TA = 0x01;
const ICR_TB = 0x02;
const ICR_IR = 0x80;

export class CIA {
  constructor(name = 'cia') {
    this.name = name;
    this.reset();
  }

  reset() {
    this.pra = 0;
    this.prb = 0;
    this.ddra = 0;
    this.ddrb = 0;
    this.latchA = 0xffff;
    this.latchB = 0xffff;
    this.counterA = 0xffff;
    this.counterB = 0xffff;
    this.cra = 0;
    this.crb = 0;
    this.icrData = 0; // pending interrupt flags
    this.icrMask = 0; // enabled interrupt sources
    this.sdr = 0;
    this.tod = [0, 0, 0, 0];
    this.irq = false;
  }

  /**
   * Configure the timer the way the SID file environment requires, without
   * going through the register interface.
   */
  setTimerA(latch, running) {
    this.latchA = latch & 0xffff;
    this.counterA = this.latchA;
    this.cra = running ? (this.cra | CRA_START) : (this.cra & ~CRA_START);
  }

  setTimerB(latch, running) {
    this.latchB = latch & 0xffff;
    this.counterB = this.latchB;
    this.crb = running ? (this.crb | CRA_START) : (this.crb & ~CRA_START);
  }

  raiseInterrupt(flag) {
    this.icrData |= flag;
    if (this.icrMask & flag) {
      this.icrData |= ICR_IR;
      this.irq = true;
    }
  }

  /**
   * Advance both timers by `cycles` phi2 clocks.
   * @returns {number} how many times Timer A underflowed
   */
  clock(cycles) {
    let timerAUnderflows = 0;

    // Timer A counts phi2 when INMODE is clear. A counter at value c underflows
    // after c+1 clocks, then reloads from the latch -- so the period is latch+1.
    if ((this.cra & CRA_START) && !(this.cra & CRA_INMODE)) {
      let remaining = cycles;
      while (remaining > this.counterA) {
        remaining -= this.counterA + 1;
        this.counterA = this.latchA;
        timerAUnderflows++;
        this.raiseInterrupt(ICR_TA);
        if (this.cra & CRA_RUNMODE) {
          this.cra &= ~CRA_START; // one shot: stop after a single underflow
          remaining = 0;
          break;
        }
        // A latch of 0 would spin forever; treat it as a single underflow.
        if (this.latchA === 0) { remaining = 0; break; }
      }
      this.counterA -= remaining;
      if (this.counterA < 0) this.counterA = 0;
    }

    // Timer B counts phi2 (INMODE 00) or Timer A underflows (INMODE 10).
    if (this.crb & CRA_START) {
      const inmode = (this.crb >> 5) & 0x03;
      let ticks = 0;
      if (inmode === 0) ticks = cycles;
      else if (inmode === 2) ticks = timerAUnderflows;
      if (ticks > 0) {
        let remaining = ticks;
        while (remaining > this.counterB) {
          remaining -= this.counterB + 1;
          this.counterB = this.latchB;
          this.raiseInterrupt(ICR_TB);
          if (this.crb & CRA_RUNMODE) {
            this.crb &= ~CRA_START;
            remaining = 0;
            break;
          }
          if (this.latchB === 0) { remaining = 0; break; }
        }
        this.counterB -= remaining;
        if (this.counterB < 0) this.counterB = 0;
      }
    }

    return timerAUnderflows;
  }

  read(reg) {
    switch (reg & 0x0f) {
      case 0x00: return this.pra | ~this.ddra & 0xff;
      case 0x01: return this.prb | ~this.ddrb & 0xff;
      case 0x02: return this.ddra;
      case 0x03: return this.ddrb;
      case 0x04: return this.counterA & 0xff;
      case 0x05: return (this.counterA >> 8) & 0xff;
      case 0x06: return this.counterB & 0xff;
      case 0x07: return (this.counterB >> 8) & 0xff;
      case 0x08: case 0x09: case 0x0a: case 0x0b:
        return this.tod[(reg & 0x0f) - 8];
      case 0x0c: return this.sdr;
      case 0x0d: {
        // Reading the ICR returns the pending flags and clears them, which also
        // releases the interrupt line.
        const value = this.icrData;
        this.icrData = 0;
        this.irq = false;
        return value;
      }
      case 0x0e: return this.cra & ~CRA_LOAD;
      case 0x0f: return this.crb & ~CRA_LOAD;
      default: return 0xff;
    }
  }

  write(reg, value) {
    value &= 0xff;
    switch (reg & 0x0f) {
      case 0x00: this.pra = value; break;
      case 0x01: this.prb = value; break;
      case 0x02: this.ddra = value; break;
      case 0x03: this.ddrb = value; break;
      case 0x04: this.latchA = (this.latchA & 0xff00) | value; break;
      case 0x05:
        this.latchA = (this.latchA & 0x00ff) | (value << 8);
        // Writing the high byte of a stopped timer loads the counter too.
        if (!(this.cra & CRA_START)) this.counterA = this.latchA;
        break;
      case 0x06: this.latchB = (this.latchB & 0xff00) | value; break;
      case 0x07:
        this.latchB = (this.latchB & 0x00ff) | (value << 8);
        if (!(this.crb & CRA_START)) this.counterB = this.latchB;
        break;
      case 0x08: case 0x09: case 0x0a: case 0x0b:
        this.tod[(reg & 0x0f) - 8] = value;
        break;
      case 0x0c: this.sdr = value; break;
      case 0x0d: {
        // Bit 7 decides whether the selected sources are enabled or disabled.
        if (value & 0x80) this.icrMask |= value & 0x1f;
        else this.icrMask &= ~(value & 0x1f);
        if (this.icrData & this.icrMask & 0x1f) {
          this.icrData |= ICR_IR;
          this.irq = true;
        }
        break;
      }
      case 0x0e:
        this.cra = value;
        if (value & CRA_LOAD) this.counterA = this.latchA;
        break;
      case 0x0f:
        this.crb = value;
        if (value & CRA_LOAD) this.counterB = this.latchB;
        break;
      default: break;
    }
  }

  /** Period in cycles between Timer A underflows, as configured right now. */
  get timerAPeriod() {
    return this.latchA + 1;
  }
}
