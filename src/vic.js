// Just enough VIC-II to keep music code happy: a free-running raster counter
// visible through $D011/$D012 and a raster-compare interrupt.
//
// Plenty of tunes busy-wait on $D012 or hang their timing off a raster IRQ, so
// the counter has to actually advance; nothing else about the video chip
// matters for audio.

export class VIC {
  /** @param {{rasterLines:number, cyclesPerLine:number}} timing */
  constructor(timing) {
    this.rasterLines = timing.rasterLines;
    this.cyclesPerLine = timing.cyclesPerLine;
    this.cyclesPerFrame = this.rasterLines * this.cyclesPerLine;
    this.registers = new Uint8Array(0x40);
    this.reset();
  }

  reset() {
    this.registers.fill(0);
    this.registers[0x11] = 0x1b; // default screen control
    this.registers[0x16] = 0xc8;
    this.frameCycle = 0;
    this.rasterLine = 0;
    this.rasterCompare = 0;
    this.irqLatch = 0;
    this.irqMask = 0;
    this.irq = false;
  }

  /** Advance the raster by `cycles`, latching a raster IRQ on each match. */
  clock(cycles) {
    const previousLine = this.rasterLine;
    this.frameCycle += cycles;
    if (this.frameCycle >= this.cyclesPerFrame) {
      this.frameCycle %= this.cyclesPerFrame;
    }
    this.rasterLine = (this.frameCycle / this.cyclesPerLine) | 0;

    if (this.rasterLine !== previousLine) {
      // A long instruction can step over several lines; check whether the
      // compare value fell anywhere in the span we just crossed.
      let crossed = false;
      if (this.rasterLine > previousLine) {
        crossed = this.rasterCompare > previousLine && this.rasterCompare <= this.rasterLine;
      } else {
        // Wrapped past the end of the frame.
        crossed = this.rasterCompare > previousLine || this.rasterCompare <= this.rasterLine;
      }
      if (crossed) {
        this.irqLatch |= 0x01;
        if (this.irqMask & 0x01) {
          this.irqLatch |= 0x80;
          this.irq = true;
        }
      }
    }
  }

  read(reg) {
    switch (reg & 0x3f) {
      case 0x11: return (this.registers[0x11] & 0x7f) | ((this.rasterLine >> 1) & 0x80);
      case 0x12: return this.rasterLine & 0xff;
      case 0x19: return this.irqLatch | 0x70; // unused bits read as 1
      case 0x1a: return this.irqMask | 0xf0;
      default: return this.registers[reg & 0x3f];
    }
  }

  write(reg, value) {
    reg &= 0x3f;
    value &= 0xff;
    this.registers[reg] = value;
    switch (reg) {
      case 0x11:
        this.rasterCompare = (this.rasterCompare & 0x00ff) | ((value & 0x80) << 1);
        break;
      case 0x12:
        this.rasterCompare = (this.rasterCompare & 0x0100) | value;
        break;
      case 0x19:
        // Writing a 1 acknowledges that latch bit.
        this.irqLatch &= ~(value & 0x0f);
        if (!(this.irqLatch & this.irqMask & 0x0f)) {
          this.irqLatch &= 0x7f;
          this.irq = false;
        }
        break;
      case 0x1a:
        this.irqMask = value & 0x0f;
        if (this.irqLatch & this.irqMask & 0x0f) {
          this.irqLatch |= 0x80;
          this.irq = true;
        } else {
          this.irqLatch &= 0x7f;
          this.irq = false;
        }
        break;
      default:
        break;
    }
  }
}
