#!/usr/bin/env python3
"""Puts a static ffmpeg in the project's `bin/` folder.

The relay in serve.py needs ffmpeg, and it needs one built with the RTMP
protocol. Rather than require the operator to install it system-wide, this
fetches a static build for the machine you are on into `bin/`, where
`find_ffmpeg()` looks for it. Nothing here is needed if ffmpeg is already on
the PATH.

    python tools/get_ffmpeg.py            # this machine
    python tools/get_ffmpeg.py --force    # replace an existing copy

Windows gets `bin/ffmpeg.exe` and `bin/ffprobe.exe`; Linux and macOS get
`bin/ffmpeg` and `bin/ffprobe`. `--platform` fetches another platform's build
(handy for preparing the church Linux box from a Windows laptop); it writes
the binary the *target* platform expects. Point `EWC_FFMPEG` at a build you
fetched yourself to use that instead.

Note: on Linux the static builds link glibc's NSS statically, and in some
containers that makes *any* hostname lookup segfault the process before it
connects (a literal IP is fine). serve.py works around this by resolving the
RTMP hostname itself and handing ffmpeg an address, so the build below is
usable as-is. Windows and macOS builds are unaffected.
"""
import argparse
import pathlib
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

BINARIES = ("ffmpeg", "ffprobe")

# Each platform maps every binary to the archive that holds it. Linux ships
# both in one tarball; macOS uses a separate download per binary. The same URL
# may appear twice and is fetched only once.
BUILDS = {
    "linux-x86_64": {
        "ffmpeg": "https://johnvansickle.com/ffmpeg/releases/"
                  "ffmpeg-release-amd64-static.tar.xz",
        "ffprobe": "https://johnvansickle.com/ffmpeg/releases/"
                   "ffmpeg-release-amd64-static.tar.xz",
    },
    "linux-aarch64": {
        "ffmpeg": "https://johnvansickle.com/ffmpeg/releases/"
                  "ffmpeg-release-arm64-static.tar.xz",
        "ffprobe": "https://johnvansickle.com/ffmpeg/releases/"
                   "ffmpeg-release-arm64-static.tar.xz",
    },
    "macos-x86_64": {
        "ffmpeg": "https://ffmpeg.martin-riedl.de/redirect/latest/"
                  "macos/amd64/release/ffmpeg.zip",
        "ffprobe": "https://ffmpeg.martin-riedl.de/redirect/latest/"
                   "macos/amd64/release/ffprobe.zip",
    },
    "macos-arm64": {
        "ffmpeg": "https://ffmpeg.martin-riedl.de/redirect/latest/"
                  "macos/arm64/release/ffmpeg.zip",
        "ffprobe": "https://ffmpeg.martin-riedl.de/redirect/latest/"
                   "macos/arm64/release/ffprobe.zip",
    },
    "windows-x86_64": {
        "ffmpeg": "https://www.gyan.dev/ffmpeg/builds/"
                  "ffmpeg-release-essentials.zip",
        "ffprobe": "https://www.gyan.dev/ffmpeg/builds/"
                   "ffmpeg-release-essentials.zip",
    },
    "windows-arm64": {
        "ffmpeg": "https://github.com/BtbN/FFmpeg-Builds/releases/download/"
                  "latest/ffmpeg-master-latest-winarm64-gpl.zip",
        "ffprobe": "https://github.com/BtbN/FFmpeg-Builds/releases/download/"
                   "latest/ffmpeg-master-latest-winarm64-gpl.zip",
    },
}
ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET_DIR = ROOT / "bin"


def platform_key() -> str:
    """The build key for the machine this runs on."""
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        arch = "x86_64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        raise SystemExit(
            "No static build is listed for %s (%s). Download ffmpeg yourself "
            "and set EWC_FFMPEG to its path." % (sys.platform, machine)
        )
    if sys.platform.startswith("win"):
        platform_name = "windows"
    elif sys.platform == "darwin":
        platform_name = "macos"
    elif sys.platform.startswith("linux"):
        platform_name = "linux"
    else:
        raise SystemExit(
            "No static build is listed for %s. Download ffmpeg yourself and "
            "set EWC_FFMPEG to its path." % sys.platform
        )
    key = "%s-%s" % (platform_name, arch)
    if key not in BUILDS:
        raise SystemExit(
            "No static build is listed for %s. Download ffmpeg yourself and "
            "set EWC_FFMPEG to its path." % key
        )
    return key


def binary_name(binary: str, key: str) -> str:
    """The filename the target platform expects for a binary."""
    return binary + ".exe" if key.startswith("windows") else binary


def download(url: str, destination: pathlib.Path) -> None:
    print("Downloading %s" % url)
    request = urllib.request.Request(
        url, headers={"User-Agent": "ewcDisplay-get_ffmpeg"})
    with urllib.request.urlopen(request) as response, open(destination, "wb") as out:
        shutil.copyfileobj(response, out)


def archive_members(archive: pathlib.Path):
    """Yield (name, reader) for every file in a .zip or .tar.* archive.

    The reader is a zero-argument callable returning a fresh binary stream, so
    each member is opened only once and the archive is left open while the
    caller consumes the generator."""
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                yield info.filename, (lambda n=info.filename: zf.open(n))
    else:
        with tarfile.open(archive) as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                yield member.name, (lambda m=member: tf.extractfile(m))


def extract(archive: pathlib.Path, binary: str, target: pathlib.Path) -> bool:
    """Copy one binary out of an archive. True when it was found."""
    wanted = target.name.lower()
    for name, reader in archive_members(archive):
        if pathlib.PurePosixPath(name.replace("\\", "/")).name.lower() != wanted:
            continue
        with reader() as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
        return True
    return False


def run_quiet(path: pathlib.Path, *args: str) -> str:
    """The stdout of a binary, or '' when it cannot run."""
    try:
        out = subprocess.run([str(path), *args], capture_output=True,
                             text=True, timeout=20)
        return out.stdout or ""
    except (OSError, subprocess.SubprocessError) as exc:
        print("Warning: could not run %s (%s)." % (path, exc))
        return ""


def remove_stale_names(binary: str, key: str) -> None:
    """Delete a wrong-platform leftover for a binary from this host's `bin/`.

    The only case that matters is Windows: an extensionless `bin/ffmpeg` there
    can only be a Linux or macOS build left by an older version of this tool,
    and Windows will never run it. serve.py skips a binary it cannot run, but
    removing the leftover keeps the "Go Live" report honest. A correct file is
    never touched."""
    target = TARGET_DIR / binary_name(binary, key)
    stale = TARGET_DIR / binary
    if stale == target or not stale.exists():
        return
    try:
        stale.unlink()
        print("Removed the stale %s" % stale)
    except OSError as exc:
        print("Could not remove %s (%s)" % (stale, exc))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="replace an existing bin/ffmpeg")
    parser.add_argument("--platform", choices=sorted(BUILDS), metavar="KEY",
                        help="fetch another platform's build: %s"
                             % ", ".join(sorted(BUILDS)))
    args = parser.parse_args()

    key = args.platform or platform_key()
    # The host's own build key, or '' when this machine has no listed build. The
    # capability check only makes sense for the host's build, and a cross-fetch
    # must not touch the host's files.
    try:
        host_key = platform_key()
    except SystemExit:
        host_key = ""
    ffmpeg_target = TARGET_DIR / binary_name("ffmpeg", key)
    if ffmpeg_target.exists() and not args.force:
        print("%s already exists. Use --force to replace it." % ffmpeg_target)
        return 0

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        scratch = pathlib.Path(work)
        fetched = {}
        for binary in BINARIES:
            url = BUILDS[key][binary]
            archive = fetched.get(url)
            if archive is None:
                archive = scratch / (url.rstrip("/").rsplit("/", 1)[-1] or "archive")
                download(url, archive)
                fetched[url] = archive
            target = TARGET_DIR / binary_name(binary, key)
            if not extract(archive, binary, target):
                print("Warning: %s was not found in %s." % (binary, url))
                continue
            # Only the host's own Windows bin can hold a leftover it cannot run.
            # A cross-fetch (--platform) must never delete the host's working copy.
            if key.startswith("windows") and key == host_key:
                remove_stale_names(binary, key)
            elif not key.startswith("windows"):
                target.chmod(target.stat().st_mode
                             | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    print("Installed %s" % ffmpeg_target)
    if not ffmpeg_target.exists():
        return 1

    # The capability check only makes sense for this machine's own build; a
    # cross-platform fetch cannot be executed here, so skip it rather than
    # report a false failure.
    if key != host_key:
        print("Fetched the %s build; run it on a %s machine." % (key, key))
        return 0

    version = run_quiet(ffmpeg_target, "-hide_banner", "-version").splitlines()
    print(version[0] if version else "ffmpeg installed.")
    protocols = run_quiet(ffmpeg_target, "-hide_banner", "-protocols")
    if "rtmp" not in protocols:
        print("Warning: this build does not list the rtmp protocol.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
