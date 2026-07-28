// MOS 6510 CPU core.
//
// Cycle accounting is per instruction: step() executes one instruction and
// returns the number of cycles it consumed, including page-cross and
// branch-taken penalties. That is the standard fidelity level for SID replay --
// register writes land on the right instruction boundary, which is what the
// ADSR and filter models care about.
//
// The full documented instruction set is implemented, plus the undocumented
// NMOS opcodes, since a fair number of tunes use LAX/SAX/DCP/ISC and friends.

// Base cycle counts for all 256 opcodes. Page-cross and branch penalties are
// added at run time by the addressing helpers.
const CYCLES = new Uint8Array([
  7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
]);

export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_D = 0x08;
export const FLAG_B = 0x10;
export const FLAG_U = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;

export class CPU6510 {
  /** @param {{read(addr:number):number, write(addr:number, value:number):void}} mem */
  constructor(mem) {
    this.mem = mem;
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xff;
    this.pc = 0;
    // Flags kept unpacked as 0/1 for speed; packed only for PHP/PLP/BRK/IRQ.
    this.c = 0;
    this.z = 0;
    this.i = 0;
    this.d = 0;
    this.v = 0;
    this.n = 0;
    this.cycles = 0;
    this.jammed = false;
    this.irqLine = false;
    this.nmiLine = false;
    this.nmiEdge = false;
  }

  reset() {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xfd;
    this.c = this.z = this.d = this.v = this.n = 0;
    this.i = 1;
    this.jammed = false;
    this.irqLine = false;
    this.nmiLine = false;
    this.nmiEdge = false;
    this.pc = this.read16(0xfffc);
  }

  read(addr) {
    return this.mem.read(addr & 0xffff);
  }

  write(addr, value) {
    this.mem.write(addr & 0xffff, value & 0xff);
  }

  read16(addr) {
    return this.read(addr) | (this.read(addr + 1) << 8);
  }

  getP(withBreak) {
    return (this.c ? FLAG_C : 0)
      | (this.z ? FLAG_Z : 0)
      | (this.i ? FLAG_I : 0)
      | (this.d ? FLAG_D : 0)
      | (withBreak ? FLAG_B : 0)
      | FLAG_U
      | (this.v ? FLAG_V : 0)
      | (this.n ? FLAG_N : 0);
  }

  setP(p) {
    this.c = p & FLAG_C ? 1 : 0;
    this.z = p & FLAG_Z ? 1 : 0;
    this.i = p & FLAG_I ? 1 : 0;
    this.d = p & FLAG_D ? 1 : 0;
    this.v = p & FLAG_V ? 1 : 0;
    this.n = p & FLAG_N ? 1 : 0;
  }

  push(value) {
    this.write(0x0100 | this.sp, value);
    this.sp = (this.sp - 1) & 0xff;
  }

  pull() {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x0100 | this.sp);
  }

  setNZ(value) {
    this.z = value === 0 ? 1 : 0;
    this.n = value & 0x80 ? 1 : 0;
  }

  /** Raise or lower the IRQ line (level triggered). */
  setIRQ(active) {
    this.irqLine = !!active;
  }

  /** Raise or lower the NMI line (edge triggered on the rising edge). */
  setNMI(active) {
    if (active && !this.nmiLine) this.nmiEdge = true;
    this.nmiLine = !!active;
  }

  interrupt(vector, isBreak) {
    this.push((this.pc >> 8) & 0xff);
    this.push(this.pc & 0xff);
    this.push(this.getP(isBreak));
    this.i = 1;
    this.pc = this.read16(vector);
    return 7;
  }

  // --- addressing modes -----------------------------------------------------
  // `penalty` marks read instructions, which pay an extra cycle when the
  // indexed address crosses a page. Stores and read-modify-writes always pay it
  // and have it folded into the base cycle table instead.

  addrImm() {
    return this.pc++ & 0xffff;
  }

  addrZp() {
    return this.read(this.pc++);
  }

  addrZpX() {
    return (this.read(this.pc++) + this.x) & 0xff;
  }

  addrZpY() {
    return (this.read(this.pc++) + this.y) & 0xff;
  }

  addrAbs() {
    const addr = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    return addr;
  }

  addrAbsX(penalty) {
    const base = this.addrAbs();
    const addr = (base + this.x) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  addrAbsY(penalty) {
    const base = this.addrAbs();
    const addr = (base + this.y) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  addrIndX() {
    const zp = (this.read(this.pc++) + this.x) & 0xff;
    return this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
  }

  addrIndY(penalty) {
    const zp = this.read(this.pc++);
    const base = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
    const addr = (base + this.y) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  branch(taken) {
    const offset = (this.read(this.pc++) << 24) >> 24; // sign extend
    if (!taken) return;
    const target = (this.pc + offset) & 0xffff;
    // Taken costs one cycle, plus another if it lands on a different page.
    this.cycles += (this.pc & 0xff00) !== (target & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  // --- ALU helpers ----------------------------------------------------------

  adc(m) {
    const a = this.a;
    if (this.d) {
      // NMOS decimal mode, following Bruce Clark's description: Z comes from
      // the binary result while N and V come from the intermediate sum.
      let low = (a & 0x0f) + (m & 0x0f) + this.c;
      if (low >= 0x0a) low = ((low + 0x06) & 0x0f) + 0x10;
      let sum = (a & 0xf0) + (m & 0xf0) + low;
      this.z = ((a + m + this.c) & 0xff) === 0 ? 1 : 0;
      this.n = sum & 0x80 ? 1 : 0;
      this.v = (~(a ^ m) & (a ^ sum) & 0x80) ? 1 : 0;
      if (sum >= 0xa0) sum += 0x60;
      this.c = sum >= 0x100 ? 1 : 0;
      this.a = sum & 0xff;
    } else {
      const sum = a + m + this.c;
      this.c = sum > 0xff ? 1 : 0;
      this.v = (~(a ^ m) & (a ^ sum) & 0x80) ? 1 : 0;
      this.a = sum & 0xff;
      this.setNZ(this.a);
    }
  }

  sbc(m) {
    const a = this.a;
    const borrow = 1 - this.c;
    // In decimal mode the NMOS part still derives every flag from the binary
    // subtraction; only the stored result is adjusted.
    const diff = a - m - borrow;
    this.c = diff >= 0 ? 1 : 0;
    this.v = ((a ^ m) & (a ^ diff) & 0x80) ? 1 : 0;
    this.setNZ(diff & 0xff);
    if (this.d) {
      let low = (a & 0x0f) - (m & 0x0f) - borrow;
      if (low < 0) low = ((low - 0x06) & 0x0f) - 0x10;
      let result = (a & 0xf0) - (m & 0xf0) + low;
      if (result < 0) result -= 0x60;
      this.a = result & 0xff;
    } else {
      this.a = diff & 0xff;
    }
  }

  compare(reg, m) {
    const diff = reg - m;
    this.c = diff >= 0 ? 1 : 0;
    this.setNZ(diff & 0xff);
  }

  aslValue(m) {
    this.c = m & 0x80 ? 1 : 0;
    const r = (m << 1) & 0xff;
    this.setNZ(r);
    return r;
  }

  lsrValue(m) {
    this.c = m & 0x01;
    const r = m >> 1;
    this.setNZ(r);
    return r;
  }

  rolValue(m) {
    const r = ((m << 1) | this.c) & 0xff;
    this.c = m & 0x80 ? 1 : 0;
    this.setNZ(r);
    return r;
  }

  rorValue(m) {
    const r = (m >> 1) | (this.c << 7);
    this.c = m & 0x01;
    this.setNZ(r);
    return r;
  }

  /**
   * Execute one instruction (or take a pending interrupt).
   * @returns {number} cycles consumed
   */
  step() {
    if (this.nmiEdge) {
      this.nmiEdge = false;
      return this.interrupt(0xfffa, false);
    }
    if (this.irqLine && !this.i) {
      return this.interrupt(0xfffe, false);
    }
    if (this.jammed) return 1;

    const op = this.read(this.pc++);
    this.pc &= 0xffff;
    this.cycles = CYCLES[op];
    let addr;
    let m;

    switch (op) {
      // --- load / store ---
      case 0xa9: this.a = this.read(this.addrImm()); this.setNZ(this.a); break;
      case 0xa5: this.a = this.read(this.addrZp()); this.setNZ(this.a); break;
      case 0xb5: this.a = this.read(this.addrZpX()); this.setNZ(this.a); break;
      case 0xad: this.a = this.read(this.addrAbs()); this.setNZ(this.a); break;
      case 0xbd: this.a = this.read(this.addrAbsX(true)); this.setNZ(this.a); break;
      case 0xb9: this.a = this.read(this.addrAbsY(true)); this.setNZ(this.a); break;
      case 0xa1: this.a = this.read(this.addrIndX()); this.setNZ(this.a); break;
      case 0xb1: this.a = this.read(this.addrIndY(true)); this.setNZ(this.a); break;

      case 0xa2: this.x = this.read(this.addrImm()); this.setNZ(this.x); break;
      case 0xa6: this.x = this.read(this.addrZp()); this.setNZ(this.x); break;
      case 0xb6: this.x = this.read(this.addrZpY()); this.setNZ(this.x); break;
      case 0xae: this.x = this.read(this.addrAbs()); this.setNZ(this.x); break;
      case 0xbe: this.x = this.read(this.addrAbsY(true)); this.setNZ(this.x); break;

      case 0xa0: this.y = this.read(this.addrImm()); this.setNZ(this.y); break;
      case 0xa4: this.y = this.read(this.addrZp()); this.setNZ(this.y); break;
      case 0xb4: this.y = this.read(this.addrZpX()); this.setNZ(this.y); break;
      case 0xac: this.y = this.read(this.addrAbs()); this.setNZ(this.y); break;
      case 0xbc: this.y = this.read(this.addrAbsX(true)); this.setNZ(this.y); break;

      case 0x85: this.write(this.addrZp(), this.a); break;
      case 0x95: this.write(this.addrZpX(), this.a); break;
      case 0x8d: this.write(this.addrAbs(), this.a); break;
      case 0x9d: this.write(this.addrAbsX(false), this.a); break;
      case 0x99: this.write(this.addrAbsY(false), this.a); break;
      case 0x81: this.write(this.addrIndX(), this.a); break;
      case 0x91: this.write(this.addrIndY(false), this.a); break;

      case 0x86: this.write(this.addrZp(), this.x); break;
      case 0x96: this.write(this.addrZpY(), this.x); break;
      case 0x8e: this.write(this.addrAbs(), this.x); break;

      case 0x84: this.write(this.addrZp(), this.y); break;
      case 0x94: this.write(this.addrZpX(), this.y); break;
      case 0x8c: this.write(this.addrAbs(), this.y); break;

      // --- transfers ---
      case 0xaa: this.x = this.a; this.setNZ(this.x); break;
      case 0xa8: this.y = this.a; this.setNZ(this.y); break;
      case 0xba: this.x = this.sp; this.setNZ(this.x); break;
      case 0x8a: this.a = this.x; this.setNZ(this.a); break;
      case 0x9a: this.sp = this.x; break;
      case 0x98: this.a = this.y; this.setNZ(this.a); break;

      // --- stack ---
      case 0x48: this.push(this.a); break;
      case 0x08: this.push(this.getP(true)); break;
      case 0x68: this.a = this.pull(); this.setNZ(this.a); break;
      case 0x28: this.setP(this.pull()); break;

      // --- logic ---
      case 0x29: this.a &= this.read(this.addrImm()); this.setNZ(this.a); break;
      case 0x25: this.a &= this.read(this.addrZp()); this.setNZ(this.a); break;
      case 0x35: this.a &= this.read(this.addrZpX()); this.setNZ(this.a); break;
      case 0x2d: this.a &= this.read(this.addrAbs()); this.setNZ(this.a); break;
      case 0x3d: this.a &= this.read(this.addrAbsX(true)); this.setNZ(this.a); break;
      case 0x39: this.a &= this.read(this.addrAbsY(true)); this.setNZ(this.a); break;
      case 0x21: this.a &= this.read(this.addrIndX()); this.setNZ(this.a); break;
      case 0x31: this.a &= this.read(this.addrIndY(true)); this.setNZ(this.a); break;

      case 0x09: this.a |= this.read(this.addrImm()); this.setNZ(this.a); break;
      case 0x05: this.a |= this.read(this.addrZp()); this.setNZ(this.a); break;
      case 0x15: this.a |= this.read(this.addrZpX()); this.setNZ(this.a); break;
      case 0x0d: this.a |= this.read(this.addrAbs()); this.setNZ(this.a); break;
      case 0x1d: this.a |= this.read(this.addrAbsX(true)); this.setNZ(this.a); break;
      case 0x19: this.a |= this.read(this.addrAbsY(true)); this.setNZ(this.a); break;
      case 0x01: this.a |= this.read(this.addrIndX()); this.setNZ(this.a); break;
      case 0x11: this.a |= this.read(this.addrIndY(true)); this.setNZ(this.a); break;

      case 0x49: this.a ^= this.read(this.addrImm()); this.setNZ(this.a); break;
      case 0x45: this.a ^= this.read(this.addrZp()); this.setNZ(this.a); break;
      case 0x55: this.a ^= this.read(this.addrZpX()); this.setNZ(this.a); break;
      case 0x4d: this.a ^= this.read(this.addrAbs()); this.setNZ(this.a); break;
      case 0x5d: this.a ^= this.read(this.addrAbsX(true)); this.setNZ(this.a); break;
      case 0x59: this.a ^= this.read(this.addrAbsY(true)); this.setNZ(this.a); break;
      case 0x41: this.a ^= this.read(this.addrIndX()); this.setNZ(this.a); break;
      case 0x51: this.a ^= this.read(this.addrIndY(true)); this.setNZ(this.a); break;

      case 0x24:
      case 0x2c: {
        addr = op === 0x24 ? this.addrZp() : this.addrAbs();
        m = this.read(addr);
        this.z = (this.a & m) === 0 ? 1 : 0;
        this.n = m & 0x80 ? 1 : 0;
        this.v = m & 0x40 ? 1 : 0;
        break;
      }

      // --- arithmetic ---
      case 0x69: this.adc(this.read(this.addrImm())); break;
      case 0x65: this.adc(this.read(this.addrZp())); break;
      case 0x75: this.adc(this.read(this.addrZpX())); break;
      case 0x6d: this.adc(this.read(this.addrAbs())); break;
      case 0x7d: this.adc(this.read(this.addrAbsX(true))); break;
      case 0x79: this.adc(this.read(this.addrAbsY(true))); break;
      case 0x61: this.adc(this.read(this.addrIndX())); break;
      case 0x71: this.adc(this.read(this.addrIndY(true))); break;

      case 0xe9:
      case 0xeb: this.sbc(this.read(this.addrImm())); break; // $EB is an undocumented SBC
      case 0xe5: this.sbc(this.read(this.addrZp())); break;
      case 0xf5: this.sbc(this.read(this.addrZpX())); break;
      case 0xed: this.sbc(this.read(this.addrAbs())); break;
      case 0xfd: this.sbc(this.read(this.addrAbsX(true))); break;
      case 0xf9: this.sbc(this.read(this.addrAbsY(true))); break;
      case 0xe1: this.sbc(this.read(this.addrIndX())); break;
      case 0xf1: this.sbc(this.read(this.addrIndY(true))); break;

      case 0xc9: this.compare(this.a, this.read(this.addrImm())); break;
      case 0xc5: this.compare(this.a, this.read(this.addrZp())); break;
      case 0xd5: this.compare(this.a, this.read(this.addrZpX())); break;
      case 0xcd: this.compare(this.a, this.read(this.addrAbs())); break;
      case 0xdd: this.compare(this.a, this.read(this.addrAbsX(true))); break;
      case 0xd9: this.compare(this.a, this.read(this.addrAbsY(true))); break;
      case 0xc1: this.compare(this.a, this.read(this.addrIndX())); break;
      case 0xd1: this.compare(this.a, this.read(this.addrIndY(true))); break;

      case 0xe0: this.compare(this.x, this.read(this.addrImm())); break;
      case 0xe4: this.compare(this.x, this.read(this.addrZp())); break;
      case 0xec: this.compare(this.x, this.read(this.addrAbs())); break;

      case 0xc0: this.compare(this.y, this.read(this.addrImm())); break;
      case 0xc4: this.compare(this.y, this.read(this.addrZp())); break;
      case 0xcc: this.compare(this.y, this.read(this.addrAbs())); break;

      // --- increment / decrement ---
      case 0xe6:
      case 0xf6:
      case 0xee:
      case 0xfe: {
        addr = op === 0xe6 ? this.addrZp()
          : op === 0xf6 ? this.addrZpX()
            : op === 0xee ? this.addrAbs() : this.addrAbsX(false);
        m = (this.read(addr) + 1) & 0xff;
        this.write(addr, m);
        this.setNZ(m);
        break;
      }
      case 0xc6:
      case 0xd6:
      case 0xce:
      case 0xde: {
        addr = op === 0xc6 ? this.addrZp()
          : op === 0xd6 ? this.addrZpX()
            : op === 0xce ? this.addrAbs() : this.addrAbsX(false);
        m = (this.read(addr) - 1) & 0xff;
        this.write(addr, m);
        this.setNZ(m);
        break;
      }
      case 0xe8: this.x = (this.x + 1) & 0xff; this.setNZ(this.x); break;
      case 0xc8: this.y = (this.y + 1) & 0xff; this.setNZ(this.y); break;
      case 0xca: this.x = (this.x - 1) & 0xff; this.setNZ(this.x); break;
      case 0x88: this.y = (this.y - 1) & 0xff; this.setNZ(this.y); break;

      // --- shifts ---
      case 0x0a: this.a = this.aslValue(this.a); break;
      case 0x06:
      case 0x16:
      case 0x0e:
      case 0x1e: {
        addr = op === 0x06 ? this.addrZp()
          : op === 0x16 ? this.addrZpX()
            : op === 0x0e ? this.addrAbs() : this.addrAbsX(false);
        this.write(addr, this.aslValue(this.read(addr)));
        break;
      }
      case 0x4a: this.a = this.lsrValue(this.a); break;
      case 0x46:
      case 0x56:
      case 0x4e:
      case 0x5e: {
        addr = op === 0x46 ? this.addrZp()
          : op === 0x56 ? this.addrZpX()
            : op === 0x4e ? this.addrAbs() : this.addrAbsX(false);
        this.write(addr, this.lsrValue(this.read(addr)));
        break;
      }
      case 0x2a: this.a = this.rolValue(this.a); break;
      case 0x26:
      case 0x36:
      case 0x2e:
      case 0x3e: {
        addr = op === 0x26 ? this.addrZp()
          : op === 0x36 ? this.addrZpX()
            : op === 0x2e ? this.addrAbs() : this.addrAbsX(false);
        this.write(addr, this.rolValue(this.read(addr)));
        break;
      }
      case 0x6a: this.a = this.rorValue(this.a); break;
      case 0x66:
      case 0x76:
      case 0x6e:
      case 0x7e: {
        addr = op === 0x66 ? this.addrZp()
          : op === 0x76 ? this.addrZpX()
            : op === 0x6e ? this.addrAbs() : this.addrAbsX(false);
        this.write(addr, this.rorValue(this.read(addr)));
        break;
      }

      // --- jumps / calls ---
      case 0x4c: this.pc = this.addrAbs(); break;
      case 0x6c: {
        const ptr = this.addrAbs();
        // NMOS bug: an indirect vector at $xxFF reads its high byte from $xx00.
        const lo = this.read(ptr);
        const hi = this.read((ptr & 0xff00) | ((ptr + 1) & 0x00ff));
        this.pc = lo | (hi << 8);
        break;
      }
      case 0x20: {
        const target = this.read16(this.pc);
        const ret = (this.pc + 1) & 0xffff; // JSR pushes the address of the last byte
        this.push((ret >> 8) & 0xff);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: this.pc = (this.pull() | (this.pull() << 8)) + 1 & 0xffff; break;
      case 0x40: {
        this.setP(this.pull());
        this.pc = this.pull() | (this.pull() << 8);
        break;
      }
      case 0x00: {
        this.pc = (this.pc + 1) & 0xffff; // BRK skips a padding byte
        this.interrupt(0xfffe, true);
        break;
      }

      // --- branches ---
      case 0x10: this.branch(!this.n); break;
      case 0x30: this.branch(!!this.n); break;
      case 0x50: this.branch(!this.v); break;
      case 0x70: this.branch(!!this.v); break;
      case 0x90: this.branch(!this.c); break;
      case 0xb0: this.branch(!!this.c); break;
      case 0xd0: this.branch(!this.z); break;
      case 0xf0: this.branch(!!this.z); break;

      // --- flags ---
      case 0x18: this.c = 0; break;
      case 0x38: this.c = 1; break;
      case 0x58: this.i = 0; break;
      case 0x78: this.i = 1; break;
      case 0xb8: this.v = 0; break;
      case 0xd8: this.d = 0; break;
      case 0xf8: this.d = 1; break;

      // --- NOPs, documented and not ---
      case 0xea:
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa:
        break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2:
        this.pc = (this.pc + 1) & 0xffff;
        break;
      case 0x04: case 0x44: case 0x64:
        this.addrZp();
        break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4:
        this.addrZpX();
        break;
      case 0x0c:
        this.addrAbs();
        break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc:
        this.addrAbsX(true);
        break;

      // --- undocumented: combined loads and stores ---
      case 0xa7: case 0xb7: case 0xaf: case 0xbf: case 0xa3: case 0xb3: {
        // LAX: load A and X together
        addr = op === 0xa7 ? this.addrZp()
          : op === 0xb7 ? this.addrZpY()
            : op === 0xaf ? this.addrAbs()
              : op === 0xbf ? this.addrAbsY(true)
                : op === 0xa3 ? this.addrIndX() : this.addrIndY(true);
        this.a = this.x = this.read(addr);
        this.setNZ(this.a);
        break;
      }
      case 0xab: {
        // LAX #imm ("ATX"): unstable on hardware; the common result is A = X = imm.
        this.a = this.x = this.read(this.addrImm());
        this.setNZ(this.a);
        break;
      }
      case 0x87: case 0x97: case 0x8f: case 0x83: {
        // SAX: store A AND X
        addr = op === 0x87 ? this.addrZp()
          : op === 0x97 ? this.addrZpY()
            : op === 0x8f ? this.addrAbs() : this.addrIndX();
        this.write(addr, this.a & this.x);
        break;
      }

      // --- undocumented: read-modify-write combinations ---
      case 0xc7: case 0xd7: case 0xcf: case 0xdf: case 0xdb: case 0xc3: case 0xd3: {
        // DCP: DEC then CMP
        addr = op === 0xc7 ? this.addrZp()
          : op === 0xd7 ? this.addrZpX()
            : op === 0xcf ? this.addrAbs()
              : op === 0xdf ? this.addrAbsX(false)
                : op === 0xdb ? this.addrAbsY(false)
                  : op === 0xc3 ? this.addrIndX() : this.addrIndY(false);
        m = (this.read(addr) - 1) & 0xff;
        this.write(addr, m);
        this.compare(this.a, m);
        break;
      }
      case 0xe7: case 0xf7: case 0xef: case 0xff: case 0xfb: case 0xe3: case 0xf3: {
        // ISC: INC then SBC
        addr = op === 0xe7 ? this.addrZp()
          : op === 0xf7 ? this.addrZpX()
            : op === 0xef ? this.addrAbs()
              : op === 0xff ? this.addrAbsX(false)
                : op === 0xfb ? this.addrAbsY(false)
                  : op === 0xe3 ? this.addrIndX() : this.addrIndY(false);
        m = (this.read(addr) + 1) & 0xff;
        this.write(addr, m);
        this.sbc(m);
        break;
      }
      case 0x07: case 0x17: case 0x0f: case 0x1f: case 0x1b: case 0x03: case 0x13: {
        // SLO: ASL then ORA
        addr = op === 0x07 ? this.addrZp()
          : op === 0x17 ? this.addrZpX()
            : op === 0x0f ? this.addrAbs()
              : op === 0x1f ? this.addrAbsX(false)
                : op === 0x1b ? this.addrAbsY(false)
                  : op === 0x03 ? this.addrIndX() : this.addrIndY(false);
        m = this.aslValue(this.read(addr));
        this.write(addr, m);
        this.a |= m;
        this.setNZ(this.a);
        break;
      }
      case 0x27: case 0x37: case 0x2f: case 0x3f: case 0x3b: case 0x23: case 0x33: {
        // RLA: ROL then AND
        addr = op === 0x27 ? this.addrZp()
          : op === 0x37 ? this.addrZpX()
            : op === 0x2f ? this.addrAbs()
              : op === 0x3f ? this.addrAbsX(false)
                : op === 0x3b ? this.addrAbsY(false)
                  : op === 0x23 ? this.addrIndX() : this.addrIndY(false);
        m = this.rolValue(this.read(addr));
        this.write(addr, m);
        this.a &= m;
        this.setNZ(this.a);
        break;
      }
      case 0x47: case 0x57: case 0x4f: case 0x5f: case 0x5b: case 0x43: case 0x53: {
        // SRE: LSR then EOR
        addr = op === 0x47 ? this.addrZp()
          : op === 0x57 ? this.addrZpX()
            : op === 0x4f ? this.addrAbs()
              : op === 0x5f ? this.addrAbsX(false)
                : op === 0x5b ? this.addrAbsY(false)
                  : op === 0x43 ? this.addrIndX() : this.addrIndY(false);
        m = this.lsrValue(this.read(addr));
        this.write(addr, m);
        this.a ^= m;
        this.setNZ(this.a);
        break;
      }
      case 0x67: case 0x77: case 0x6f: case 0x7f: case 0x7b: case 0x63: case 0x73: {
        // RRA: ROR then ADC
        addr = op === 0x67 ? this.addrZp()
          : op === 0x77 ? this.addrZpX()
            : op === 0x6f ? this.addrAbs()
              : op === 0x7f ? this.addrAbsX(false)
                : op === 0x7b ? this.addrAbsY(false)
                  : op === 0x63 ? this.addrIndX() : this.addrIndY(false);
        m = this.rorValue(this.read(addr));
        this.write(addr, m);
        this.adc(m);
        break;
      }

      // --- undocumented: immediate ALU oddities ---
      case 0x0b: case 0x2b: {
        // ANC: AND then copy bit 7 into carry
        this.a &= this.read(this.addrImm());
        this.setNZ(this.a);
        this.c = this.n;
        break;
      }
      case 0x4b: {
        // ALR: AND then LSR
        this.a &= this.read(this.addrImm());
        this.a = this.lsrValue(this.a);
        break;
      }
      case 0x6b: {
        // ARR: AND then ROR, with carry and overflow taken from the result.
        // Decimal-mode ARR behaves differently again; binary mode is modelled here.
        const t = this.a & this.read(this.addrImm());
        this.a = (t >> 1) | (this.c << 7);
        this.setNZ(this.a);
        this.c = (this.a >> 6) & 1;
        this.v = ((this.a >> 6) ^ (this.a >> 5)) & 1;
        break;
      }
      case 0xcb: {
        // AXS/SBX: X = (A AND X) - imm, carry set as for a compare
        m = this.read(this.addrImm());
        const t = (this.a & this.x) - m;
        this.c = t >= 0 ? 1 : 0;
        this.x = t & 0xff;
        this.setNZ(this.x);
        break;
      }
      case 0xbb: {
        // LAS/LAE: A = X = SP = memory AND SP
        addr = this.addrAbsY(true);
        const t = this.read(addr) & this.sp;
        this.a = this.x = this.sp = t;
        this.setNZ(t);
        break;
      }

      // --- undocumented: unstable stores ---
      // These AND the stored value with the high byte of the target address
      // plus one, and corrupt the address itself when the index crosses a page.
      case 0x9c: case 0x9e: case 0x93: case 0x9f: case 0x9b: {
        const base = op === 0x93 ? (() => {
          const zp = this.read(this.pc++);
          return this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
        })() : this.addrAbs();
        const index = op === 0x9c ? this.x : this.y;
        let target = (base + index) & 0xffff;
        let value;
        if (op === 0x9c) value = this.y;              // SHY abs,X
        else if (op === 0x9e) value = this.x;         // SHX abs,Y
        else if (op === 0x9b) {                       // TAS abs,Y
          this.sp = this.a & this.x;
          value = this.sp;
        } else value = this.a & this.x;               // AHX abs,Y / (zp),Y
        value &= ((base >> 8) + 1) & 0xff;
        if ((base & 0xff00) !== (target & 0xff00)) {
          target = (value << 8) | (target & 0xff);
        }
        this.write(target, value);
        break;
      }

      // --- JAM / KIL: the CPU locks up until reset ---
      default:
        this.jammed = true;
        break;
    }

    this.pc &= 0xffff;
    return this.cycles;
  }
}
