#!/usr/bin/env python3
"""Puts a static ffmpeg in the project's `bin/` folder.

The relay in serve.py needs ffmpeg, and it needs one built with the RTMP
protocol. Rather than require the operator to install it system-wide, this
fetches a static Linux build into `bin/ffmpeg`, where `find_ffmpeg()` looks for
it. Nothing here is needed if ffmpeg is already on the PATH.

    python3 tools/get_ffmpeg.py            # Linux x86_64 (the church machine)
    python3 tools/get_ffmpeg.py --force    # replace an existing copy

Windows and macOS have their own static builds at the same site; point
`EWC_FFMPEG` at whatever you download there, or drop it in as `bin/ffmpeg.exe`.

Note: static Linux builds link glibc's NSS statically, and in some containers
that makes *any* hostname lookup segfault the process before it connects (a
literal IP is fine). serve.py works around this by resolving the RTMP hostname
itself and handing ffmpeg an address, so the build below is usable as-is.
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

BUILDS = {
    "linux-x86_64": (
        "https://johnvansickle.com/ffmpeg/releases/"
        "ffmpeg-release-amd64-static.tar.xz"
    ),
    "linux-aarch64": (
        "https://johnvansickle.com/ffmpeg/releases/"
        "ffmpeg-release-arm64-static.tar.xz"
    ),
}
ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET_DIR = ROOT / "bin"


def platform_key() -> str:
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "linux-x86_64"
    if machine in ("aarch64", "arm64"):
        return "linux-aarch64"
    raise SystemExit(
        "No static build is listed for %s. Download ffmpeg yourself and set "
        "EWC_FFMPEG to its path." % machine
    )


def download(url: str, destination: pathlib.Path) -> None:
    print("Downloading %s" % url)
    with urllib.request.urlopen(url) as response, open(destination, "wb") as out:
        shutil.copyfileobj(response, out)


def extract(archive: pathlib.Path, target: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory() as work:
        with tarfile.open(archive) as tar:
            tar.extractall(work)
        found = list(pathlib.Path(work).glob("ffmpeg-*/ffmpeg"))
        if not found:
            raise SystemExit("The archive did not contain an ffmpeg binary.")
        shutil.copy2(found[0], target)
        probe = list(pathlib.Path(work).glob("ffmpeg-*/ffprobe"))
        if probe:
            shutil.copy2(probe[0], target.parent / "ffprobe")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true",
                        help="replace an existing bin/ffmpeg")
    args = parser.parse_args()

    target = TARGET_DIR / "ffmpeg"
    if target.exists() and not args.force:
        print("%s already exists. Use --force to replace it." % target)
        return 0

    key = platform_key()
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        archive = pathlib.Path(work) / "ffmpeg.tar.xz"
        download(BUILDS[key], archive)
        extract(archive, target)
    target.chmod(target.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    version = subprocess.run([str(target), "-hide_banner", "-version"],
                             capture_output=True, text=True).stdout.splitlines()
    print("Installed %s" % target)
    print(version[0] if version else "ffmpeg installed.")
    protocols = subprocess.run([str(target), "-hide_banner", "-protocols"],
                               capture_output=True, text=True).stdout
    if "rtmp" not in protocols:
        print("Warning: this build does not list the rtmp protocol.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
