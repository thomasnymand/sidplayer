// C64 memory map: 64K of RAM, ROM banking driven by the 6510's on-chip port at
// $00/$01, and I/O dispatch across $D000-$DFFF.
//
// We cannot ship real Commodore ROM images, so BASIC and CHARGEN are filled
// with RTS and KERNAL is a synthetic stub carrying just the vectors and the
// interrupt entry/exit sequences that music players actually rely on.

// I/O routing codes for the $D000-$DFFF page map.
const IO_VIC = 0;
const IO_SID0 = 1;
const IO_SID1 = 2;
const IO_SID2 = 3;
const IO_COLOR = 4;
const IO_CIA1 = 5;
const IO_CIA2 = 6;
const IO_NONE = 7;

export class C64Memory {
  /**
   * @param {object} devices
   * @param {object[]} devices.sids     up to three SID chips
   * @param {number[]} devices.sidBases base address of each SID
   * @param {object} devices.cia1
   * @param {object} devices.cia2
   * @param {object} devices.vic
   */
  constructor({ sids = [], sidBases = [0xd400], cia1, cia2, vic } = {}) {
    this.ram = new Uint8Array(0x10000);
    this.colorRam = new Uint8Array(0x0400);
    this.basicRom = new Uint8Array(0x2000).fill(0x60);
    this.kernalRom = new Uint8Array(0x2000).fill(0x60);
    this.charRom = new Uint8Array(0x1000);

    this.sids = sids;
    this.cia1 = cia1;
    this.cia2 = cia2;
    this.vic = vic;

    // 6510 on-chip port. Power-on state is DDR $2F / port $37.
    this.ddr = 0x2f;
    this.port = 0x37;
    this.loram = 1;
    this.hiram = 1;
    this.charen = 1;

    this.ioMap = new Uint8Array(0x1000).fill(IO_NONE);
    this.buildIoMap(sidBases);
    this.installKernalStub();
    this.updateBanking();
  }

  buildIoMap(sidBases) {
    const map = this.ioMap;
    // Base layout: VIC, SID, colour RAM, the two CIAs, then the expansion ports.
    map.fill(IO_VIC, 0x000, 0x400);
    map.fill(IO_SID0, 0x400, 0x800);
    map.fill(IO_COLOR, 0x800, 0xc00);
    map.fill(IO_CIA1, 0xc00, 0xd00);
    map.fill(IO_CIA2, 0xd00, 0xe00);
    map.fill(IO_NONE, 0xe00, 0x1000);

    // Extra SID chips claim a 32-byte window wherever the header put them, which
    // may sit on top of any of the regions above.
    for (let i = 1; i < sidBases.length; i++) {
      const base = sidBases[i];
      if (!base) continue;
      map.fill(i === 1 ? IO_SID1 : IO_SID2, base & 0x0fff, (base & 0x0fff) + 0x20);
    }
  }

  // A minimal KERNAL: hardware vectors, the IRQ dispatch entry at $FF48 and the
  // register-restoring exit at $EA81 that players reach via JMP $EA31.
  installKernalStub() {
    const rom = this.kernalRom;
    const put = (addr, ...bytes) => {
      for (let i = 0; i < bytes.length; i++) rom[(addr - 0xe000) + i] = bytes[i];
    };

    // $FF48: save A/X/Y, then dispatch through ($0314) for IRQ or ($0316) for BRK.
    put(0xff48,
      0x48,             // PHA
      0x8a, 0x48,       // TXA / PHA
      0x98, 0x48,       // TYA / PHA
      0xba,             // TSX
      0xbd, 0x04, 0x01, // LDA $0104,X   -- the pushed status register
      0x29, 0x10,       // AND #$10      -- break flag?
      0xf0, 0x03,       // BEQ +3
      0x6c, 0x16, 0x03, // JMP ($0316)
      0x6c, 0x14, 0x03, // JMP ($0314)
    );

    // $EA31 is where players jump when they are done; hand straight to the exit.
    put(0xea31, 0x4c, 0x81, 0xea);       // JMP $EA81
    put(0xea81, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40); // PLA/TAY/PLA/TAX/PLA/RTI

    // Default NMI handler: acknowledge CIA 2 and pass through ($0318).
    put(0xfe43, 0x78, 0x6c, 0x18, 0x03); // SEI / JMP ($0318)
    put(0xfe47, 0x40);                   // RTI

    // Hardware vectors.
    put(0xfffa, 0x43, 0xfe); // NMI   -> $FE43
    put(0xfffc, 0xe2, 0xfc); // RESET -> $FCE2
    put(0xfffe, 0x48, 0xff); // IRQ   -> $FF48

    put(0xfce2, 0x60);       // RESET entry: nothing to do in this environment
  }

  /** Reset RAM and the processor port to a power-on-like state. */
  reset() {
    this.ram.fill(0);
    this.colorRam.fill(0);
    this.ddr = 0x2f;
    this.port = 0x37;
    this.updateBanking();
    // KERNAL RAM vectors, as the real reset routine would leave them.
    this.ram[0x0314] = 0x31; this.ram[0x0315] = 0xea; // IRQ  -> $EA31
    this.ram[0x0316] = 0x66; this.ram[0x0317] = 0xfe; // BRK  -> $FE66
    this.ram[0x0318] = 0x47; this.ram[0x0319] = 0xfe; // NMI  -> $FE47
  }

  updateBanking() {
    // Lines configured as inputs float high thanks to the port's pull-ups.
    const bits = (this.port & this.ddr) | (~this.ddr & 0x07);
    this.loram = bits & 0x01;
    this.hiram = (bits >> 1) & 0x01;
    this.charen = (bits >> 2) & 0x01;
  }

  /** Write the processor port directly, as the player does before init/play. */
  setBankRegister(value) {
    this.port = value & 0xff;
    this.updateBanking();
  }

  read(addr) {
    if (addr < 0xa000) {
      if (addr < 2) return addr === 0 ? this.ddr : ((this.port & this.ddr) | (~this.ddr & 0xff)) & 0xff;
      return this.ram[addr];
    }
    if (addr < 0xc000) {
      // $A000-$BFFF: BASIC ROM only when both LORAM and HIRAM are set.
      return this.loram && this.hiram ? this.basicRom[addr - 0xa000] : this.ram[addr];
    }
    if (addr < 0xd000) return this.ram[addr];
    if (addr < 0xe000) {
      if (!this.loram && !this.hiram) return this.ram[addr];
      if (!this.charen) return this.charRom[addr - 0xd000];
      return this.readIO(addr);
    }
    return this.hiram ? this.kernalRom[addr - 0xe000] : this.ram[addr];
  }

  write(addr, value) {
    if (addr < 2) {
      if (addr === 0) this.ddr = value;
      else this.port = value;
      this.updateBanking();
      // The port latches are also visible in RAM underneath.
      this.ram[addr] = value;
      return;
    }
    // Writes always fall through to the RAM under ROM, except in the I/O window.
    if (addr >= 0xd000 && addr < 0xe000 && (this.loram || this.hiram)) {
      if (this.charen) {
        this.writeIO(addr, value);
        return;
      }
    }
    this.ram[addr] = value;
  }

  readIO(addr) {
    const offset = addr & 0x0fff;
    switch (this.ioMap[offset]) {
      case IO_VIC: return this.vic ? this.vic.read(offset & 0x3f) : 0xff;
      case IO_SID0: return this.sids[0] ? this.sids[0].read(offset & 0x1f) : 0xff;
      case IO_SID1: return this.sids[1] ? this.sids[1].read(offset & 0x1f) : 0xff;
      case IO_SID2: return this.sids[2] ? this.sids[2].read(offset & 0x1f) : 0xff;
      case IO_COLOR: return this.colorRam[offset & 0x3ff] | 0xf0;
      case IO_CIA1: return this.cia1 ? this.cia1.read(offset & 0x0f) : 0xff;
      case IO_CIA2: return this.cia2 ? this.cia2.read(offset & 0x0f) : 0xff;
      default: return 0xff;
    }
  }

  writeIO(addr, value) {
    const offset = addr & 0x0fff;
    switch (this.ioMap[offset]) {
      case IO_VIC: if (this.vic) this.vic.write(offset & 0x3f, value); break;
      case IO_SID0: if (this.sids[0]) this.sids[0].write(offset & 0x1f, value); break;
      case IO_SID1: if (this.sids[1]) this.sids[1].write(offset & 0x1f, value); break;
      case IO_SID2: if (this.sids[2]) this.sids[2].write(offset & 0x1f, value); break;
      case IO_COLOR: this.colorRam[offset & 0x3ff] = value & 0x0f; break;
      case IO_CIA1: if (this.cia1) this.cia1.write(offset & 0x0f, value); break;
      case IO_CIA2: if (this.cia2) this.cia2.write(offset & 0x0f, value); break;
      default: break;
    }
  }

  /** Copy a C64 image into RAM at the given address, wrapping at $FFFF. */
  loadImage(address, data) {
    for (let i = 0; i < data.length; i++) {
      this.ram[(address + i) & 0xffff] = data[i];
    }
  }
}
