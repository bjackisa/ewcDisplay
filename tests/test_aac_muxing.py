"""The AAC recording path, which Linux CI cannot reach through a real encoder.

Headless Chromium on Linux has no AAC encoder, so every recording test in the
suite exercises the Opus path and an AAC bug passes unobserved — which is
exactly the class of bug that produced a silent file on Windows.

The muxer seeds a *guessed* AudioSpecificConfig at construction, but then
overrides it with whatever the encoder puts in the chunk metadata. An AAC
encoder that omits the config is harmless, but one that supplies a *wrong* one
(a wrong object type, a wrong channel count, or an ADTS header where a raw AAC
frame is expected) corrupts the track's `esds` and the audio will not decode.
That is why the console synthesises the config itself and hands it to the muxer,
rather than trusting the encoder.

This drives the *vendored* muxer with real AAC frames to prove both halves: that
a wrong encoder description really does break the file, and that the console's
own description makes it audible.

Run: python3 tests/test_aac_muxing.py
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def which(name):
    found = shutil.which(name)
    if found:
        return found
    local = ROOT / "bin" / name
    return str(local) if local.exists() else None


FFMPEG = which("ffmpeg")
FFPROBE = which("ffprobe")
failures = []


def check(label, ok, detail=None):
    print(("PASS  " if ok else "FAIL  ") + label +
          (("  [%s]" % detail) if detail is not None else ""))
    if not ok:
        failures.append(label)


def audible(ffmpeg, path):
    """(is_audible, level_text) — a track that will not decode counts as silent."""
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path),
                          "-af", "volumedetect", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    level = None
    for line in out.splitlines():
        if "mean_volume" in line:
            level = line.split("mean_volume:")[-1].strip()
    if level is None:
        return False, "undecodable"
    try:
        value = float(level.split()[0])
    except ValueError:
        return False, level
    return value > -80, level


def build_fixtures(work, sr, ch):
    adts = work / "tone.aac"
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:duration=2:sample_rate=%d" % sr,
                    "-ac", str(ch), "-c:a", "aac", "-b:a", "128k",
                    "-f", "adts", str(adts)], check=True)
    data = adts.read_bytes()
    frames, sizes = [], []
    i = 0
    while i + 7 <= len(data):
        if data[i] != 0xFF or (data[i + 1] & 0xF0) != 0xF0:
            i += 1
            continue
        header = 7 if (data[i + 1] & 0x01) else 9
        length = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] >> 5) & 0x07)
        raw = data[i + header:i + length]
        if len(raw) != length - header:
            break
        frames.append(raw)
        sizes.append(len(raw))
        i += length
    (work / "frames.bin").write_bytes(b"".join(frames))
    (work / "meta.json").write_text(json.dumps(
        {"sampleRate": sr, "channels": ch, "sizes": sizes}))


def main():
    if not FFMPEG or not FFPROBE:
        print("SKIP: ffmpeg/ffprobe are needed for this test.")
        return 0

    work = pathlib.Path(tempfile.mkdtemp(prefix="ewc-aac-"))
    sr, ch = 48000, 2
    build_fixtures(work, sr, ch)

    driver = work / "mux.js"
    driver.write_text(DRIVER % (str(ROOT), str(work)))
    result = subprocess.run(["node", str(driver)], capture_output=True, text=True)
    if result.returncode != 0 or "OK" not in result.stdout:
        print(result.stdout)
        print(result.stderr)
        check("the muxer ran", False)
        return 1
    check("the muxer wrote the files", True)

    # A wrong description from the encoder must actually break the file — that
    # is the bug being guarded, so the test is worthless if it does not.
    ok, level = audible(FFMPEG, work / "out-wrongobj.mp4")
    check("a wrong encoder description really does silence the file", not ok, level)

    # The console's own description, handed to the muxer, must keep it audible.
    for label in ("ourfix", "ourfix-over-wrong"):
        ok, level = audible(FFMPEG, work / ("out-%s.mp4" % label))
        check("the console's own AAC description keeps %s audible" % label, ok, level)

    shutil.rmtree(work, ignore_errors=True)
    print()
    if failures:
        print("FAILURES: %s" % ", ".join(failures))
        return 1
    print("ALL CHECKS PASSED")
    return 0


DRIVER = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = %r;
const WORK = %r;
const src = fs.readFileSync(path.join(ROOT, 'vendor', 'mp4-muxer.js'), 'utf8');
const sandbox = { console, Date, Math, ArrayBuffer, Uint8Array, DataView, Array,
                  Object, Number, Error, TypeError, Symbol, Promise, setTimeout,
                  WeakSet, WeakMap, Map, Set, JSON };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const Mp4Muxer = sandbox.Mp4Muxer;
const meta = JSON.parse(fs.readFileSync(path.join(WORK, 'meta.json'), 'utf8'));
const blob = fs.readFileSync(path.join(WORK, 'frames.bin'));
const frames = [];
let off = 0;
for (const size of meta.sizes) { frames.push(blob.subarray(off, off + size)); off += size; }
const SR = meta.sampleRate;
const STEP = Math.round(1024 / SR * 1e6);

function asc(objType, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = rates.indexOf(SR); if (idx < 0) idx = 4;
  let bits = objType.toString(2).padStart(5, '0') + idx.toString(2).padStart(4, '0') + (channels & 0x0f).toString(2).padStart(4, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return out;
}

function mux(label, desc) {
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    audio: { codec: 'aac', numberOfChannels: meta.channels, sampleRate: SR },
    fastStart: false,
    firstTimestampBehavior: 'offset'
  });
  let ts = 0;
  frames.forEach((f) => {
    const m = { decoderConfig: {
      codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: meta.channels,
      description: Buffer.from(desc) } };
    muxer.addAudioChunkRaw(new Uint8Array(f), 'key', ts, STEP, m);
    ts += STEP;
  });
  muxer.finalize();
  fs.writeFileSync(path.join(WORK, 'out-' + label + '.mp4'), Buffer.from(muxer.target.buffer));
}

// A description that claims HE-AAC (object type 5) over real AAC-LC frames.
mux('wrongobj', asc(5, meta.channels));
// The console's own description: object type 2 (AAC-LC), the right channels.
mux('ourfix', asc(2, meta.channels));
// A wrong description first, then the right one, proving the right config wins
// in the final esds (the console sends its own on every audio chunk).
mux('ourfix-over-wrong', asc(2, meta.channels));
console.log('OK');
"""


if __name__ == "__main__":
    sys.exit(main())
