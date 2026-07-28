// SID envelope generator (one per voice).
//
// The real chip does not decrement a counter once per cycle; it compares a
// 15-bit rate counter against a period drawn from a fixed table, and applies a
// second, "exponential" divider whose value changes at particular envelope
// levels. Both are modelled here because together they give the SID its
// characteristic decay shape -- a plain linear ramp sounds noticeably wrong.

// Cycles per envelope step for each of the 16 attack/decay/release settings.
export const RATE_COUNTER_PERIOD = new Uint16Array([
  9, 32, 63, 95, 149, 220, 267, 313,
  392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
]);

// Sustain level n is simply n repeated in both nibbles.
const SUSTAIN_LEVEL = new Uint8Array(16);
for (let i = 0; i < 16; i++) SUSTAIN_LEVEL[i] = (i << 4) | i;

const ATTACK = 0;
const DECAY_SUSTAIN = 1;
const RELEASE = 2;

export class EnvelopeGenerator {
  constructor() {
    this.reset();
  }

  reset() {
    this.envelopeCounter = 0;
    this.attack = 0;
    this.decay = 0;
    this.sustain = 0;
    this.release = 0;
    this.gate = false;
    this.rateCounter = 0;
    this.ratePeriod = RATE_COUNTER_PERIOD[0];
    this.exponentialCounter = 0;
    this.exponentialCounterPeriod = 1;
    this.holdZero = true;
    this.state = RELEASE;
  }

  writeControlReg(control) {
    const gateNext = (control & 0x01) !== 0;
    if (!this.gate && gateNext) {
      // Gate on always restarts the attack, even from a non-zero level.
      this.state = ATTACK;
      this.ratePeriod = RATE_COUNTER_PERIOD[this.attack];
      this.holdZero = false;
    } else if (this.gate && !gateNext) {
      this.state = RELEASE;
      this.ratePeriod = RATE_COUNTER_PERIOD[this.release];
    }
    this.gate = gateNext;
  }

  writeAttackDecay(value) {
    this.attack = (value >> 4) & 0x0f;
    this.decay = value & 0x0f;
    // Changing the rate mid-envelope takes effect immediately, which is what
    // makes the ADSR delay bug reachable.
    if (this.state === ATTACK) this.ratePeriod = RATE_COUNTER_PERIOD[this.attack];
    else if (this.state === DECAY_SUSTAIN) this.ratePeriod = RATE_COUNTER_PERIOD[this.decay];
  }

  writeSustainRelease(value) {
    this.sustain = (value >> 4) & 0x0f;
    this.release = value & 0x0f;
    if (this.state === RELEASE) this.ratePeriod = RATE_COUNTER_PERIOD[this.release];
  }

  clock() {
    if (this.rateCounter !== this.ratePeriod) {
      // The rate counter is 15 bits wide. If a newly written period sits below
      // the current count, the counter has to wrap all the way around before it
      // matches again -- the ADSR delay bug, audible as a dropped note.
      if (++this.rateCounter & 0x8000) {
        this.rateCounter = (this.rateCounter + 1) & 0x7fff;
      }
      return;
    }
    this.rateCounter = 0;

    // Attack is linear; decay and release run through the exponential divider.
    if (this.state !== ATTACK && ++this.exponentialCounter !== this.exponentialCounterPeriod) {
      return;
    }
    this.exponentialCounter = 0;
    if (this.holdZero) return;

    switch (this.state) {
      case ATTACK:
        this.envelopeCounter = (this.envelopeCounter + 1) & 0xff;
        if (this.envelopeCounter === 0xff) {
          this.state = DECAY_SUSTAIN;
          this.ratePeriod = RATE_COUNTER_PERIOD[this.decay];
        }
        break;
      case DECAY_SUSTAIN:
        if (this.envelopeCounter !== SUSTAIN_LEVEL[this.sustain]) {
          this.envelopeCounter = (this.envelopeCounter - 1) & 0xff;
        }
        break;
      case RELEASE:
        this.envelopeCounter = (this.envelopeCounter - 1) & 0xff;
        break;
      default:
        break;
    }

    // The exponential divider steps down at these fixed envelope levels.
    switch (this.envelopeCounter) {
      case 0xff: this.exponentialCounterPeriod = 1; break;
      case 0x5d: this.exponentialCounterPeriod = 2; break;
      case 0x36: this.exponentialCounterPeriod = 4; break;
      case 0x1a: this.exponentialCounterPeriod = 8; break;
      case 0x0e: this.exponentialCounterPeriod = 16; break;
      case 0x06: this.exponentialCounterPeriod = 30; break;
      case 0x00:
        this.exponentialCounterPeriod = 1;
        this.holdZero = true;
        break;
      default: break;
    }
  }

  output() {
    return this.envelopeCounter;
  }
}
