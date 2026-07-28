// PSID / RSID file parsing, per spec.txt (HVSC "SID FILE FORMAT DESCRIPTION").
//
// All multi-byte header fields are BIG endian (spec.txt line 41). The only
// little-endian quantity in the whole format is the optional load address
// embedded in the first two bytes of the C64 data, which follows the normal
// C64 binary file convention.

export const PAL_CLOCK = 985248;
export const NTSC_CLOCK = 1022727;

// 312 lines * 63 cycles (PAL), 263 lines * 65 cycles (NTSC).
export const PAL_CYCLES_PER_FRAME = 19656;
export const NTSC_CYCLES_PER_FRAME = 17095;

// Default CIA 1 Timer A latch giving ~60Hz, mandated by spec.txt lines 476-478.
export const PAL_CIA_DEFAULT = 0x4025;
export const NTSC_CIA_DEFAULT = 0x4295;

export const CLOCK_UNKNOWN = 0;
export const CLOCK_PAL = 1;
export const CLOCK_NTSC = 2;
export const CLOCK_ANY = 3;

export const MODEL_UNKNOWN = 0;
export const MODEL_6581 = 1;
export const MODEL_8580 = 2;
export const MODEL_ANY = 3;

const CLOCK_NAMES = ['unknown', 'PAL', 'NTSC', 'PAL and NTSC'];
const MODEL_NAMES = ['unknown', 'MOS6581', 'MOS8580', 'MOS6581 and MOS8580'];

// Windows-1252 differs from Latin-1 only in 0x80-0x9F, which the spec calls for
// explicitly (spec.txt line 45). Undefined slots map to U+FFFD.
const CP1252_HIGH = [
  '€', '�', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '�', 'Ž', '�',
  '�', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '�', 'ž', 'Ÿ',
];

function readString(buf, offset, length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    const c = buf[offset + i];
    if (c === 0) break; // Strings under 32 chars are NUL terminated.
    out += c >= 0x80 && c <= 0x9f ? CP1252_HIGH[c - 0x80] : String.fromCharCode(c);
  }
  return out.replace(/\s+$/, '');
}

// A second/third SID address byte encodes the middle nibbles of $Dxx0: 0x42
// means $D420. Only even values in $42-$7F and $E0-$FE are meaningful; anything
// else (including 0) means "no such chip".
function decodeExtraSidAddress(value) {
  if (value === 0 || (value & 1) !== 0) return 0;
  const inLow = value >= 0x42 && value <= 0x7f;
  const inHigh = value >= 0xe0 && value <= 0xfe;
  if (!inLow && !inHigh) return 0;
  return 0xd000 | (value << 4);
}

export class SidFileError extends Error {}

/**
 * Parse a .sid file image.
 * @param {Buffer|Uint8Array} bytes raw file contents
 * @returns {object} decoded tune, including the C64 data image and its load address
 */
export function parseSidFile(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 0x76) {
    throw new SidFileError(`file is too short to be a SID (${buf.length} bytes)`);
  }

  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'PSID' && magic !== 'RSID') {
    throw new SidFileError(`not a SID file: expected magic 'PSID' or 'RSID', found '${magic}'`);
  }
  const isRsid = magic === 'RSID';

  const version = buf.readUInt16BE(0x04);
  if (version < 1 || version > 4) {
    throw new SidFileError(`unsupported SID version ${version} (expected 1-4)`);
  }
  if (isRsid && version < 2) {
    throw new SidFileError(`RSID requires version 2, 3 or 4, found ${version}`);
  }

  const dataOffset = buf.readUInt16BE(0x06);
  const expectedOffset = version === 1 ? 0x76 : 0x7c;
  if (dataOffset !== expectedOffset) {
    throw new SidFileError(
      `dataOffset $${dataOffset.toString(16).toUpperCase()} does not match ` +
      `version ${version} (expected $${expectedOffset.toString(16).toUpperCase()})`,
    );
  }
  if (dataOffset >= buf.length) {
    throw new SidFileError('dataOffset points past the end of the file');
  }

  const headerLoadAddress = buf.readUInt16BE(0x08);
  const headerInitAddress = buf.readUInt16BE(0x0a);
  const playAddress = buf.readUInt16BE(0x0c);
  const songs = buf.readUInt16BE(0x0e);
  const rawStartSong = buf.readUInt16BE(0x10);
  const speed = buf.readUInt32BE(0x12);

  const name = readString(buf, 0x16, 32);
  const author = readString(buf, 0x36, 32);
  const released = readString(buf, 0x56, 32);

  // v2+ fields. Version 1 files get the documented defaults.
  let flags = 0;
  let startPage = 0;
  let pageLength = 0;
  let secondSidAddress = 0;
  let thirdSidAddress = 0;
  if (version >= 2) {
    flags = buf.readUInt16BE(0x76);
    startPage = buf[0x78];
    pageLength = buf[0x79];
    if (version >= 3) secondSidAddress = decodeExtraSidAddress(buf[0x7a]);
    if (version >= 4) thirdSidAddress = decodeExtraSidAddress(buf[0x7b]);
  }

  const musPlayer = (flags & 0x01) !== 0;
  // Bit 1 is "PlaySID specific" for PSID and "C64 BASIC" for RSID.
  const psidSpecific = !isRsid && (flags & 0x02) !== 0;
  const basic = isRsid && (flags & 0x02) !== 0;
  const clock = (flags >> 2) & 0x03;
  const sidModel = (flags >> 4) & 0x03;
  // Unknown for the 2nd/3rd chip means "same as the first" (spec.txt lines 347, 358).
  const rawSecondModel = (flags >> 6) & 0x03;
  const rawThirdModel = (flags >> 8) & 0x03;
  const secondSidModel = rawSecondModel === MODEL_UNKNOWN ? sidModel : rawSecondModel;
  const thirdSidModel = rawThirdModel === MODEL_UNKNOWN ? sidModel : rawThirdModel;

  if (musPlayer) {
    throw new SidFileError(
      'this file holds Compute!\'s Sidplayer (MUS) data rather than a built-in ' +
      'player; an external player binary would have to be merged to replay it',
    );
  }

  if (songs < 1 || songs > 0x100) {
    throw new SidFileError(`songs must be 1-256, found ${songs}`);
  }
  const startSong = rawStartSong >= 1 && rawStartSong <= songs ? rawStartSong : 1;

  // RSID reserves loadAddress, playAddress and speed; the spec requires we
  // reject files that set them (spec.txt lines 86-97).
  if (isRsid) {
    if (headerLoadAddress !== 0) throw new SidFileError('RSID requires loadAddress = 0');
    if (playAddress !== 0) throw new SidFileError('RSID requires playAddress = 0');
    if (speed !== 0) throw new SidFileError('RSID requires speed = 0');
  }

  // Extract the C64 image. loadAddress = 0 means the true address sits in the
  // first two data bytes, little endian, and those bytes are not part of the image.
  let data;
  let loadAddress;
  if (headerLoadAddress === 0) {
    if (buf.length < dataOffset + 2) {
      throw new SidFileError('file ends before the embedded load address');
    }
    loadAddress = buf.readUInt16LE(dataOffset);
    data = buf.subarray(dataOffset + 2);
  } else {
    loadAddress = headerLoadAddress;
    data = buf.subarray(dataOffset);
  }
  if (data.length === 0) throw new SidFileError('file contains no C64 data');

  // initAddress = 0 means "same as the effective load address".
  const initAddress = headerInitAddress === 0 ? loadAddress : headerInitAddress;

  if (isRsid) {
    if (loadAddress < 0x07e8) {
      throw new SidFileError(
        `RSID load address $${loadAddress.toString(16).toUpperCase()} is below $07E8`,
      );
    }
    if (basic && headerInitAddress !== 0) {
      throw new SidFileError('RSID with the C64 BASIC flag set requires initAddress = 0');
    }
    if (!basic) {
      const inRom = (initAddress >= 0xa000 && initAddress <= 0xbfff) || initAddress >= 0xd000;
      if (inRom || initAddress < 0x07e8) {
        throw new SidFileError(
          `RSID initAddress $${initAddress.toString(16).toUpperCase()} must be in ` +
          '$07E8-$9FFF or $C000-$CFFF',
        );
      }
    }
  }

  const endAddress = (loadAddress + data.length - 1) & 0xffff;

  return {
    magic,
    isRsid,
    version,
    dataOffset,
    loadAddress,
    initAddress,
    playAddress,
    songs,
    startSong,
    speed,
    name,
    author,
    released,
    flags,
    musPlayer,
    psidSpecific,
    basic,
    clock,
    sidModel,
    secondSidModel,
    thirdSidModel,
    startPage,
    pageLength,
    secondSidAddress,
    thirdSidAddress,
    data,
    endAddress,
    clockName: CLOCK_NAMES[clock],
    sidModelName: MODEL_NAMES[sidModel],
  };
}

/**
 * Is the given (1-based) song driven by a CIA timer rather than the vertical blank?
 *
 * Each bit of `speed` covers one song. For tunes with more than 32 songs the
 * spec gives two rules: with the PlaySID-specific flag set the bits wrap, and
 * with it cleared bit 31 covers every song from 32 upwards (spec.txt lines
 * 211-224). RSID always reports vertical blank since its `speed` is reserved.
 */
export function songUsesCiaTiming(tune, song) {
  if (tune.isRsid) return false;
  const index = tune.psidSpecific || tune.version < 3
    ? (song - 1) % 32
    : Math.min(song - 1, 31);
  return ((tune.speed >>> index) & 1) !== 0;
}

/** Resolve the video standard to use, honouring an explicit user override. */
export function resolveClock(tune, override) {
  if (override) return override === 'ntsc' ? CLOCK_NTSC : CLOCK_PAL;
  // "Unknown" and "PAL and NTSC" both fall back to PAL, the C64's home format.
  return tune.clock === CLOCK_NTSC ? CLOCK_NTSC : CLOCK_PAL;
}

/** Resolve the SID model to use, honouring an explicit user override. */
export function resolveModel(model, override) {
  if (override) return override === '8580' ? MODEL_8580 : MODEL_6581;
  return model === MODEL_8580 ? MODEL_8580 : MODEL_6581;
}

/** Per-clock constants for the resolved video standard. */
export function clockConstants(clock) {
  return clock === CLOCK_NTSC
    ? {
      name: 'NTSC',
      cpuClock: NTSC_CLOCK,
      cyclesPerFrame: NTSC_CYCLES_PER_FRAME,
      ciaDefault: NTSC_CIA_DEFAULT,
      rasterLines: 263,
      cyclesPerLine: 65,
    }
    : {
      name: 'PAL',
      cpuClock: PAL_CLOCK,
      cyclesPerFrame: PAL_CYCLES_PER_FRAME,
      ciaDefault: PAL_CIA_DEFAULT,
      rasterLines: 312,
      cyclesPerLine: 63,
    };
}
