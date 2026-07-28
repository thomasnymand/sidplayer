# sidplay

A simulator for the MOS 6581/8580 SID sound chip, and a player for `.sid` music
files. Plain JavaScript, ES modules, no dependencies, no build step. It runs on
the command line and, unchanged, in the browser.

```
node sidplay.js Sanxion_Cover.sid   # command line
npm run web                         # browser, at http://localhost:8080/
```

## What this actually is

A `.sid` file is not a score. It is a block of **6510 machine code** plus data,
with two entry points: `init` to set a song up and `play` to be called at a
steady rate. There is no way to render one without running that code.

So this is a small Commodore 64:

| Part | File | What it does |
|---|---|---|
| 6510 CPU | `src/cpu6510.js` | Full documented instruction set plus the undocumented NMOS opcodes, with per-instruction cycle counts |
| Memory | `src/memory.js` | 64K RAM, ROM banking off the 6510 port at `$00`/`$01`, I/O dispatch across `$D000-$DFFF` |
| CIA 6526 | `src/cia.js` | Interval timers and the interrupt control register |
| VIC-II | `src/vic.js` | Raster counter and raster interrupt (enough to stop tunes hanging on `$D012`) |
| SID | `src/sid/` | Three voices, envelopes, and the multimode filter |
| Resampler | `src/resample.js` | Two-stage windowed-sinc conversion from ~1 MHz to 44.1 kHz |
| Player | `src/player.js` | Builds the environment the format requires and drives `init`/`play` |

The CPU, the timers and the SID all advance together, so a register write lands
at the right point in the audio stream rather than being quantised to a frame.

## Usage

```
node sidplay.js <file.sid> [options]

  -s, --song <n>           subsong to play (default: the file's start song)
  -t, --time <seconds>     how much to render (default: 180)
  -o, --out <file.wav>     write a WAV file instead of playing
  -r, --rate <hz>          output sample rate (default: 44100)
  -m, --model <6581|8580>  override the SID model
  -c, --clock <pal|ntsc>   override the video standard
      --voices <mask>      which voices to play, e.g. 101 to mute voice 2
      --gain <x>           output gain; disables auto normalisation
      --no-normalize       keep the raw level instead of normalising
      --no-filter          bypass the SID filter (for debugging)
      --info               print the file's header and exit
      --dump-regs <n>      log SID register writes for the first n play calls
      --verbose            report timing, replay rate and per-voice levels
```

Playback renders the tune to a temporary WAV and hands it to macOS's `afplay`.
Rendering runs at roughly 25x realtime, so a three minute tune is ready in about
seven seconds. On other platforms, use `-o` and play the file yourself.

## In the browser

```
npm run web
```

Then open <http://localhost:8080/>. Drop a `.sid` file on the page, or load the
bundled one, and press Play.

Nothing is bundled, transpiled or vendored: the page imports the same `src/`
modules the CLI does, straight from disk. The only reason a server is needed at
all is that ES module imports do not work over `file://`; `tools/serve.js` is a
forty-line static file server with no configuration.

| Part | File |
|---|---|
| Page and controls | `web/index.html`, `web/app.js` |
| Emulation, off the main thread | `web/render-worker.js` |
| Static server | `tools/serve.js` |

The tune is emulated in a module worker and the finished buffer is played
through an `AudioBufferSourceNode`, so the UI never blocks and the audio is
never at the mercy of a garbage collection pause. Pressing Play renders first
when the current settings have not been rendered yet, and replays the buffer it
already has when they have; changing the song, duration, model or clock retires
the previous render. In Chrome a three minute tune renders in about eight
seconds, near enough the same speed as under Node.

This needs Web Audio and module workers: Chrome, Safari and Firefox 114+.

## Notes on accuracy

The parts that most affect how a tune sounds are modelled properly rather than
approximated:

- **Oscillators** use a 24-bit phase accumulator clocked once per chip cycle,
  with hard sync, ring modulation, and the real 23-bit noise LFSR (taps 22 and
  17, output gathered from bits 22, 20, 16, 13, 11, 7, 4 and 2).
- **Envelopes** use the authentic rate-counter period table and the exponential
  divider that steps at envelope levels 93, 54, 26, 14 and 6. The ADSR delay bug
  is included, because tunes audibly depend on it.
- **The filter** is a two-integrator state variable loop, the same topology as
  the chip. The 6581's very nonlinear cutoff curve comes from a table of
  measured control points; the 8580's is close to linear.
- **The output stage** models the 6581's large DC offset, which is what makes
  volume-register writes audible, followed by the RC network on the board
  (~16 Hz high-pass, ~16 kHz low-pass) that removes it again.
- **Resampling** is done in two stages. One stage would need a several-thousand
  tap FIR, because a sharp 20 kHz filter is expensive relative to a 1 MHz input
  rate. Decimating by 10 first, where the transition band can be enormous, then
  doing the sharp conversion at 98.5 kHz, costs about a tenth as much.

### Known limitations

- **No real C64 ROMs.** They cannot be redistributed, so BASIC and CHARGEN are
  filled with `RTS` and KERNAL is a stub carrying the hardware vectors, the IRQ
  entry at `$FF48` and the register-restoring exit at `$EA81`. That covers
  essentially every PSID file, but a tune that genuinely calls a KERNAL routine
  will misbehave.
- **Combined waveforms are approximated.** Selecting more than one waveform ties
  their outputs together on an internal bus; reproducing that exactly needs
  sampled tables from real silicon. A bitwise AND with a 6581 attenuation is
  used instead, which is the usual approximation.
- **Cycle accounting is per instruction, not per bus cycle.** This is the normal
  fidelity level for replay, but it is not VICE-grade timing, and there is no
  sprite or badline DMA stealing.
- **RSID support is best-effort**, since those tunes assume a full C64.
- Compute!'s Sidplayer (MUS) files are rejected: they carry no player code, so an
  external player binary would have to be merged in first.

## Tests

```
npm test
```

Covers CPU flags, decimal mode, cycle counts around page boundaries, the
undocumented opcodes, envelope timing, resampler passband and stopband, the bank
register rules, header parsing, and an end-to-end replay check.

The suite will also run [Klaus Dormann's 6502 functional
test](https://github.com/Klaus2m5/6502_65C02_functional_tests) if you drop
`6502_functional_test.bin` into `test/`. It is not bundled here.

## Format reference

`spec.txt` is the HVSC *SID FILE FORMAT DESCRIPTION*. Two details in it are easy
to get wrong and matter a lot:

- Every header field is **big endian**, except the optional load address in the
  first two bytes of the C64 data, which is little endian.
- The bank register `$01` must be rewritten **before every** `init` and `play`
  call, chosen from the target address: below `$A000` use `$37`, below `$D000`
  use `$36`, `$E000` and above use `$35`, otherwise `$34`. The environment also
  needs `$02A6` set (1 for PAL, 0 for NTSC) and CIA 1 timer A preloaded with
  `$4025` (PAL) or `$4295` (NTSC).
