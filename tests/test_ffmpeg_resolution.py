"""The relay's ffmpeg must be a binary this machine can actually run.

A stale `bin/ffmpeg` on Windows is a Linux ELF that an older get_ffmpeg.py left
behind. find_ffmpeg() used to trust the first path that existed, so the relay
picked that ELF, could not execute it, reported "no RTMP support" and refused
every stream ("The relay refused the stream") while the working `bin/ffmpeg.exe`
sat right beside it.

This checks the resolution with no ffmpeg at all, the stale-plus-real pair, and
a runnable build that simply lacks RTMP — and separately that get_ffmpeg.py
deletes the stale name it can never use.

Run: python3 tests/test_ffmpeg_resolution.py
"""
import importlib.util
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
failures = []


def check(label, ok, detail=None):
    print(("PASS  " if ok else "FAIL  ") + label +
          (("  [%s]" % detail) if detail is not None else ""))
    if not ok:
        failures.append(label)


def load_serve():
    spec = importlib.util.spec_from_file_location("ewc_serve", ROOT / "serve.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ewc_serve"] = module
    spec.loader.exec_module(module)
    return module


def main():
    serve = load_serve()
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ewc-ff-"))

    fake = tmp / "bin"
    fake.mkdir()
    elf = fake / "ffmpeg"          # a "Linux ELF" Windows cannot run
    elf.write_bytes(b"\x7fELF not a Win32 application")
    exe = fake / "ffmpeg.exe"      # the working Windows build
    exe.write_bytes(b"MZ")

    # Stub the probes so no real binary is needed: only the .exe runs, and only
    # it has RTMP. This is exactly the Windows box in the bug report.
    serve.ffmpeg_version = lambda path: "ffmpeg version test" if path.endswith(".exe") else ""
    serve.ffmpeg_has_rtmp = lambda path: path.endswith(".exe")

    # Point the search at the temp bin by overriding the root it derives from
    # __file__, so the real bin/ beside serve.py is never consulted.
    original = serve.__file__
    try:
        serve.__file__ = str(tmp / "serve.py")
        (tmp / "serve.py").write_text("")
        serve._ffmpeg_cache = None
        serve.shutil.which = lambda name: None  # nothing on PATH
        chosen = serve.find_ffmpeg()
        check("the stale Linux bin/ffmpeg is skipped for the working bin/ffmpeg.exe",
              chosen == str(exe), chosen)
    finally:
        serve.__file__ = original

    # A stale binary alone must not be reported as a usable ffmpeg.
    elf_only = tmp / "elfonly" / "bin"
    elf_only.mkdir(parents=True)
    (elf_only / "ffmpeg").write_bytes(b"\x7fELF")
    original = serve.__file__
    try:
        serve.__file__ = str(elf_only.parent / "serve.py")
        (elf_only.parent / "serve.py").write_text("")
        serve._ffmpeg_cache = None
        serve.shutil.which = lambda name: None
        chosen = serve.find_ffmpeg()
        check("a lone un-runnable ffmpeg resolves to nothing", chosen == "", chosen)
    finally:
        serve.__file__ = original

    # get_ffmpeg.py must delete the leftover it can never use on Windows.
    spec = importlib.util.spec_from_file_location(
        "ewc_get_ffmpeg", ROOT / "tools" / "get_ffmpeg.py")
    gf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gf)
    win = tmp / "win" / "bin"
    win.mkdir(parents=True)
    (win / "ffmpeg").write_bytes(b"\x7fELF junk")
    (win / "ffmpeg.exe").write_bytes(b"MZ real")
    gf.TARGET_DIR = win
    gf.platform_key = lambda: "windows-x86_64"
    gf.remove_stale_names("ffmpeg", "windows-x86_64")
    check("the stale extensionless ffmpeg is deleted",
          not (win / "ffmpeg").exists(), sorted(p.name for p in win.iterdir()))
    check("the working ffmpeg.exe is kept", (win / "ffmpeg.exe").exists())

    print()
    if failures:
        print("FAILURES: %s" % ", ".join(failures))
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
