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
  -t, --time <seconds>     how much to render (default: 180, 0 for no limit)
  -o, --out <file.wav>     write a WAV file instead of playing ('-' for stdout)
  -d, --direct             stream to the audio device as it is emulated
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

By default, playback renders the tune to a temporary WAV and hands it to macOS's
`afplay`. Rendering runs at roughly 25x realtime, so a three minute tune is
ready in about seven seconds, and the level can be normalised because the whole
waveform is there to measure.

### Playing without rendering first

```
node sidplay.js Lightforce.sid --direct
```

`--direct` emulates straight into the audio device instead: sound starts
immediately and, with no `-t`, keeps going until Ctrl-C. It looks for the first
of `ffplay`, `play` (sox), `pw-play` or `aplay` on PATH. `afplay` cannot be used
here — it takes a file path and will not read a pipe, which is exactly why the
default path writes a temporary file.

Nothing throttles the emulator except the pipe. It runs about twenty times
faster than realtime, so it fills the player's buffer, blocks on backpressure,
and from then on is paced by the audio device itself. The progress line counts
what has gone into the pipe, so it leads what you hear by however much the
player has buffered.

`-o -` writes a WAV to stdout for piping somewhere else, and moves all the
human-readable output to stderr so it cannot corrupt the stream:

```
node sidplay.js Lightforce.sid -t 30 -o - | ffplay -i -
node sidplay.js Lightforce.sid -o - > tune.wav
```

With `-t 0` the header carries `0xFFFFFFFF` for its lengths, the usual way of
saying "read until the input ends".

The catch is the level. Normalising means dividing by the peak, and a stream
cannot know its peak before it has produced the audio, so both streaming modes
apply a fixed gain of 0.6 instead — enough headroom for the loud tunes, which
tend to peak near 1.5. Use `--gain` to set it yourself. Streamed audio is
otherwise identical to rendered audio: `-o -` and `-o file.wav` at the same gain
produce byte-identical files.

## In the browser

```
npm run web
```

Then open <http://localhost:8080/>, drop a `.sid` file on the page, and press
Play.

Nothing is bundled, transpiled or vendored: the page imports the same `src/`
modules the CLI does, straight from disk. The only reason a server is needed at
all is that ES module imports do not work over `file://`; `tools/serve.js` is a
forty-line static file server with no configuration.

| Part | File |
|---|---|
| Page and controls | `web/index.html`, `web/app.js` |
| Emulation in the audio thread, for playback | `web/stream-processor.js` |
| Emulation in a worker, for the WAV export | `web/render-worker.js` |
| Static server | `tools/serve.js` |

### Playback streams

Play does not render anything first. `web/stream-processor.js` is an
`AudioWorkletProcessor` that holds a `SidPlayer` and advances it inside the
audio render thread, filling each 128 frame quantum as the hardware asks for
it. Sound starts in about 200 ms and continues until you stop it; there is no
length to choose and no ceiling to hit.

That thread is a hard realtime context: at 48 kHz a quantum is 2.67 ms of audio,
and missing that deadline is an audible glitch. So the processor allocates every
buffer up front and never allocates in `process()`. Emulating 16384 SID cycles
at a time — about 17 ms of audio, so roughly one quantum in six does the work
for the next six — costs between 9% and 20% of the deadline on an M-series Mac,
depending on what else is running. Emulating 4096 at a time measured
consistently worse, because the resampler's per-call overhead is then paid four
times as often.

Worth knowing: the audio thread is markedly slower than a worker for the same
code, about 6x realtime against 21x. The headroom is still comfortable, but it
is not the headroom a worker benchmark would suggest.

The streamed output is bit for bit identical to the offline renderer's, verified
by rendering both through an `OfflineAudioContext` and comparing: zero
difference across 96000 samples. Streaming is the same computation, not an
approximation of it.

### Export renders

Download WAV takes the other path, rendering a fixed length in a module worker
at roughly 21x realtime. This is not duplication for its own sake: normalising a
level requires knowing the peak, and a stream cannot know its own peak in
advance. The export is normalised the way the CLI normalises; the stream has a
volume slider instead.

Requirements: Web Audio, module workers, and static `import` inside
`AudioWorklet`. Verified on Chrome 150. Firefox and Safari are untested — if
worklet imports fail there, the imports would have to be inlined into
`stream-processor.js`, which is the one place this project's no-build-step rule
gets uncomfortable.

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
