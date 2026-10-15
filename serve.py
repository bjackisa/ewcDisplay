#!/usr/bin/env python3
"""Serves this folder over http so the display system can be opened at localhost.

    python3 serve.py            # http://localhost:12000
    python3 serve.py 8080       # pick your own port

Then open:

    http://localhost:12000/console.html   the control room (operator's screen)
    http://localhost:12000/display.html   the projection (church screen)
    http://localhost:12000/                a small page linking to both

Both pages must be served from the same origin: they share the songs and
settings in localStorage and the background photo in IndexedDB, and they talk
to each other over a BroadcastChannel, none of which works across file://.

Opening display.html straight off disk (file:///…) still gives you a working
clock and countdown as a standalone screen. Scripture and lyrics need a
console to drive them — the console holds the Bible text and sends it over,
so there is nothing off-disk for the display to render on its own. This
server is the tidier option: no CORS quirks, and the console can reach it.

The webpage panel fetches its page through this server (see /proxy below). A
browser refuses to frame a page whose server sends X-Frame-Options or a
frame-ancestors CSP — which is most of the web — so the console asks this
server to fetch the page instead, drop those headers, and hand it back from
the same origin. That is the only way an arbitrary link can appear on the
glass panel.
"""

import base64
import functools
import hashlib
import html
import http.server
import ipaddress
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PORT = 12000
PROXY_PATH = "/proxy"
STREAM_PATH = "/stream"
STREAM_WS_PATH = "/stream/ws"
STREAM_STOP_PATH = "/stream/stop"
STREAM_STATUS_PATH = "/stream/status"
STREAM_PROBE_PATH = "/stream/probe"
MAX_PROXY_BYTES = 12 * 1024 * 1024
PROXY_TIMEOUT = 20
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 EWC-Display"
)

# The console sends a fragmented MP4 (already H.264 + AAC, encoded by the
# browser) into ffmpeg's stdin and ffmpeg relays it to the RTMP server. Nothing
# is re-encoded, so the picture that arrives at YouTube is the picture the
# console produced; ffmpeg only re-times it onto the RTMP clock and reconnects
# if the socket drops.
STREAM_INPUT_ARGS = [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-fflags", "+genpts+igndts",
    "-f", "mp4", "-i", "pipe:0",
]
# The video is always copied — the console encoded it, so re-encoding would only
# cost quality. RTMP carries AAC, and the console sends AAC wherever the
# platform can encode it. Where it cannot (WebCodecs then offers only Opus) the
# audio alone is transcoded, which is the difference between a stream with sound
# and one without. The output format args come last.
STREAM_OUTPUT_ARGS = [
    "-flvflags", "no_duration_filesize",
    "-f", "flv",
]
STREAM_AUDIO_COPY_ARGS = ["-c:v", "copy", "-c:a", "copy"]
STREAM_AUDIO_TRANSCODE_ARGS = ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]

# The proxy can reach any host this machine can, so by default it refuses
# private, loopback and link-local addresses — otherwise anyone who can reach
# this server could use it to probe the local network. Set
# EWC_PROXY_ALLOW_PRIVATE=1 to fetch intranet pages on purpose.
ALLOW_PRIVATE = os.environ.get("EWC_PROXY_ALLOW_PRIVATE", "").strip() not in ("", "0", "false", "False")

_BASE_TAG_RE = re.compile(rb"<base\b[^>]*>", re.I)
_META_CSP_RE = re.compile(
    rb"<meta[^>]+http-equiv\s*=\s*[\"']?\s*content-security-policy[\"']?[^>]*>", re.I
)
_META_XFO_RE = re.compile(
    rb"<meta[^>]+http-equiv\s*=\s*[\"']?\s*x-frame-options[\"']?[^>]*>", re.I
)
_HEAD_TAG_RE = re.compile(rb"<head\b[^>]*>", re.I)
_HTML_TAG_RE = re.compile(rb"<html\b[^>]*>", re.I)


class _ChunkedReader:
    """Decodes an HTTP/1.1 chunked body into a plain byte stream.

    A browser streaming a `fetch` body sends it chunked, because the length is
    not known in advance. ffmpeg must see the raw MP4 bytes, not the chunk
    framing, so the framing is stripped here before the pipe."""

    def __init__(self, raw):
        self.raw = raw
        self.remaining = 0
        self.done = False

    def read(self, size: int) -> bytes:
        if self.done:
            return b""
        out = bytearray()
        while size > 0:
            if self.remaining == 0:
                line = self.raw.readline()
                if not line:
                    self.done = True
                    break
                line = line.strip().split(b";", 1)[0]
                if not line:
                    continue
                try:
                    self.remaining = int(line, 16)
                except ValueError:
                    self.done = True
                    break
                if self.remaining == 0:
                    self.done = True
                    break
            data = self.raw.read(min(size, self.remaining))
            if not data:
                self.done = True
                break
            out.extend(data)
            self.remaining -= len(data)
            size -= len(data)
            if self.remaining == 0:
                self.raw.readline()  # the CRLF that follows each chunk
        return bytes(out)


# WebSocket opcodes we care about. The console sends the encoded MP4 as binary
# frames; close and ping are the protocol's own housekeeping.
_WS_TEXT = 0x1
_WS_BINARY = 0x2
_WS_CLOSE = 0x8
_WS_PING = 0x9
_WS_PONG = 0xA

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def websocket_accept(key: str) -> str:
    """The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key."""
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class _WebSocketReader:
    """Reads a WebSocket stream as plain bytes.

    A browser cannot send a streaming request body over plain HTTP/1.1 —
    Chromium refuses a `ReadableStream` body unless the connection is HTTP/2
    (it fails with ERR_ALPN_NEGOTIATION_FAILED) — and this church server is
    HTTP/1.1. A WebSocket is the transport that is *meant* for a continuous
    browser-to-server byte pipe over HTTP/1.1, so the encoded video travels in
    binary frames and this unwraps them into the plain MP4 ffmpeg expects.

    Control frames (ping, close) are answered here and never surface as data."""

    def __init__(self, rfile, wfile):
        self.rfile = rfile
        self.wfile = wfile
        self.done = False
        self._buf = bytearray()

    def _read_exact(self, n: int) -> bytes:
        out = bytearray()
        while len(out) < n:
            chunk = self.rfile.read(n - len(out))
            if not chunk:
                return b""
            out.extend(chunk)
        return bytes(out)

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(127)
            header.extend(length.to_bytes(8, "big"))
        try:
            self.wfile.write(bytes(header) + payload)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.done = True

    def _read_message(self) -> bytes:
        """One whole client message, reassembled from its frames."""
        message = bytearray()
        while True:
            head = self._read_exact(2)
            if len(head) < 2:
                self.done = True
                return bytes(message)
            fin = bool(head[0] & 0x80)
            opcode = head[0] & 0x0F
            masked = bool(head[1] & 0x80)
            length = head[1] & 0x7F
            if length == 126:
                ext = self._read_exact(2)
                if len(ext) < 2:
                    self.done = True
                    return bytes(message)
                length = int.from_bytes(ext, "big")
            elif length == 127:
                ext = self._read_exact(8)
                if len(ext) < 8:
                    self.done = True
                    return bytes(message)
                length = int.from_bytes(ext, "big")
            mask = self._read_exact(4) if masked else b""
            if masked and len(mask) < 4:
                self.done = True
                return bytes(message)
            payload = self._read_exact(length) if length else b""
            if length and len(payload) < length:
                self.done = True
                return bytes(message)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

            if opcode == _WS_CLOSE:
                self._send_frame(_WS_CLOSE)
                self.done = True
                return bytes(message)
            if opcode == _WS_PING:
                self._send_frame(_WS_PONG, payload)
                continue
            if opcode == _WS_PONG:
                continue
            # A data frame: the first carries the opcode, the rest are
            # continuations (opcode 0).
            message.extend(payload)
            if fin:
                return bytes(message)

    def read_message(self) -> bytes:
        """Exactly one client message, for the handshake's JSON hello."""
        return self._read_message()

    def read(self, size: int) -> bytes:
        """Up to `size` bytes, drawing on the last message's leftover."""
        if self.done and not self._buf:
            return b""
        while len(self._buf) < size and not self.done:
            self._buf.extend(self._read_message())
        out = bytes(self._buf[:size])
        del self._buf[:size]
        return out


def _is_websocket_upgrade(headers) -> bool:
    """Whether these request headers ask to upgrade to a WebSocket."""
    upgrade = (headers.get("Upgrade") or "").strip().lower()
    connection = (headers.get("Connection") or "").lower()
    return upgrade == "websocket" and "upgrade" in connection


def _host_is_public(host: str) -> bool:
    """True only when every address a host resolves to is a global one."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    seen = False
    for info in infos:
        address = info[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        seen = True
        if not ip.is_global:
            return False
    return seen


def _rewrite_html(body: bytes, document_url: str) -> bytes:
    """Makes a fetched page usable from our own origin.

    A <base> pointing at the real document URL is what makes every relative
    asset and link resolve to the site it came from rather than to us; the
    meta CSP and X-Frame-Options tags are dropped for the same reason the
    response headers are.
    """
    base_tag = ('<base href="%s">' % html.escape(document_url, quote=True)).encode("ascii")
    body = _META_CSP_RE.sub(b"", body)
    body = _META_XFO_RE.sub(b"", body)
    body = _BASE_TAG_RE.sub(b"", body)

    head = _HEAD_TAG_RE.search(body)
    if head:
        return body[: head.end()] + base_tag + body[head.end():]
    root = _HTML_TAG_RE.search(body)
    if root:
        return body[: root.end()] + b"<head>" + base_tag + b"</head>" + body[root.end():]
    return b"<head>" + base_tag + b"</head>" + body


# --------------------------------------------------------------------- stream
#
# The console cannot speak RTMP; no browser can. So it encodes the display to a
# fragmented MP4 and posts those bytes here, and this server pipes them into
# ffmpeg, which relays them to the RTMP server (YouTube). ffmpeg does no
# encoding at all — `-c copy` — so what YouTube receives is exactly what the
# browser produced, and the server stays a thin, honest pipe.
#
# The relay runs on the HTTP thread that is receiving the bytes, so stopping it
# is just closing that request. Status is kept in a module-level slot the
# console polls, because a page cannot read another request's response while
# it is still writing one.

STREAM_STOPPED = "stopped"
STREAM_CONNECTING = "connecting"
STREAM_LIVE = "live"
STREAM_FAILED = "failed"


def find_ffmpeg() -> str:
    """The ffmpeg to relay with, or '' when there is none.

    A build with the RTMP protocol is required; some minimal static builds
    advertise `rtmp` and then crash on it, so the check is only that the binary
    exists and runs. EWC_FFMPEG overrides the search. A binary dropped beside
    this file (or in `bin/`) is used too, so the project can carry its own."""
    override = os.environ.get("EWC_FFMPEG", "").strip()
    if override:
        return override if os.path.exists(override) else ""
    found = shutil.which("ffmpeg")
    if found:
        return found
    # Beside this file, in case ffmpeg was dropped into the project.
    root = pathlib.Path(__file__).resolve().parent
    for candidate in (root / "ffmpeg", root / "ffmpeg.exe",
                      root / "bin" / "ffmpeg", root / "bin" / "ffmpeg.exe"):
        if candidate.exists():
            return str(candidate)
    return ""


def ffmpeg_version(path: str) -> str:
    """The first line of `ffmpeg -version`, for the capability report."""
    try:
        out = subprocess.run(
            [path, "-hide_banner", "-version"],
            capture_output=True, text=True, timeout=10,
        )
        return (out.stdout or "").splitlines()[0] if out.stdout else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def ffmpeg_has_rtmp(path: str) -> bool:
    """Whether this build lists the rtmp protocol, which relaying needs."""
    try:
        out = subprocess.run(
            [path, "-hide_banner", "-protocols"],
            capture_output=True, text=True, timeout=10,
        )
        names = (out.stdout or "").split()
        return "rtmp" in names or "rtmps" in names
    except (OSError, subprocess.SubprocessError):
        return False


def resolve_rtmp_target(rtmp_url: str):
    """Rewrite an RTMP URL's hostname to an IP, keeping the name for the handshake.

    Static ffmpeg builds link glibc's NSS statically, so any hostname lookup —
    even `localhost` from /etc/hosts — can segfault the process before a single
    packet is sent. Python's resolver is healthy, so the name is resolved here
    and ffmpeg is handed a literal address it never has to look up. The real
    hostname still reaches the server: `-rtmp_tcurl` carries it in the connect
    command (so YouTube matches the stream to the key's host), and for `rtmps`
    `-verifyhost` keeps certificate checking against the name, not the IP.

    Returns (connect_url, extra_args). On any failure to resolve, the original
    URL is returned untouched so a healthy resolver is never made worse."""
    parsed = urllib.parse.urlparse(rtmp_url)
    host = parsed.hostname
    if not host:
        return rtmp_url, []
    # A literal address needs no help, and a numeric host is what we produce.
    try:
        ipaddress.ip_address(host)
        return rtmp_url, []
    except ValueError:
        pass

    port = parsed.port or (443 if parsed.scheme == "rtmps" else 1935)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        return rtmp_url, []
    if not infos:
        return rtmp_url, []
    address = infos[0][4][0]

    # Rebuild the URL with the address in the host position. The netloc's
    # userinfo, if any, is preserved; the port is kept explicit.
    userinfo = ""
    if parsed.username:
        userinfo = urllib.parse.quote(parsed.username, safe="")
        if parsed.password:
            userinfo += ":" + urllib.parse.quote(parsed.password, safe="")
        userinfo += "@"
    literal = address if ":" not in address else "[%s]" % address
    connect_url = urllib.parse.urlunparse((
        parsed.scheme, "%s%s:%d" % (userinfo, literal, port),
        parsed.path, parsed.params, parsed.query, parsed.fragment,
    ))

    # tcUrl is scheme://host[:port]/app — the app is the URL's first path
    # segment, and the stream key is everything after it.
    app = parsed.path.lstrip("/").split("/", 1)[0]
    hostport = host if port == (443 if parsed.scheme == "rtmps" else 1935) \
        else "%s:%d" % (host, port)
    extra = ["-rtmp_tcurl", "%s://%s/%s" % (parsed.scheme, hostport, app)]
    if parsed.scheme == "rtmps":
        # Keep certificate validation pointed at the real name.
        extra += ["-verifyhost", host]
    return connect_url, extra


class StreamSession:
    """One live RTMP relay: an ffmpeg process fed from the console's upload.

    The upload thread owns the process. It writes the fragmented MP4 into
    ffmpeg's stdin, reads ffmpeg's stderr on a side thread (so a chatty ffmpeg
    can never block the pipe), and when the upload ends or Stop is pressed it
    closes stdin, waits briefly for ffmpeg to flush its last fragment, then
    records whether the relay succeeded."""

    def __init__(self, ffmpeg: str, rtmp_url: str, audio_codec: str = "aac"):
        self.ffmpeg = ffmpeg
        self.rtmp_url = rtmp_url
        self.audio_codec = (audio_codec or "aac").lower()
        self.lock = threading.Lock()
        self.state = STREAM_CONNECTING
        self.detail = ""
        self.started_at = time.time()
        self.bytes_in = 0
        self.stop_event = threading.Event()
        self.proc = None
        self.stderr_tail = []
        self.ended = threading.Event()

    def _set(self, state: str, detail: str = "") -> None:
        with self.lock:
            self.state = state
            if detail:
                self.detail = detail

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "state": self.state,
                "detail": self.detail,
                "seconds": round(time.time() - self.started_at, 1),
                "bytes": self.bytes_in,
                "url": _redact_url(self.rtmp_url),
            }

    def start(self) -> None:
        audio_args = (STREAM_AUDIO_COPY_ARGS if self.audio_codec == "aac"
                      else STREAM_AUDIO_TRANSCODE_ARGS)
        # Static ffmpeg segfaults on a hostname lookup, so the name is resolved
        # here and ffmpeg is handed a literal address; the real name still
        # rides along in tcUrl (and, for rtmps, the certificate check).
        connect_url, resolve_args = resolve_rtmp_target(self.rtmp_url)
        args = ([self.ffmpeg] + STREAM_INPUT_ARGS + audio_args
                + STREAM_OUTPUT_ARGS + resolve_args + [connect_url])
        try:
            self.proc = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            self._set(STREAM_FAILED, "Could not start ffmpeg: %s" % exc)
            self.ended.set()
            return
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self) -> None:
        """Keeps ffmpeg's last few log lines for the failure message.

        The lines are collected but never decide the state: ffmpeg says things
        like "Failed to update header with correct duration" on a perfectly
        healthy live stream, so a keyword match would cry wolf. Whether the
        relay worked is decided by the exit code, and whether it died mid-stream
        by the feed loop noticing the process has gone."""
        proc = self.proc
        if not proc or not proc.stderr:
            return
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            # The RTMP URL carries the stream key, so it is never echoed back.
            self.stderr_tail.append(_redact_text(line))
            del self.stderr_tail[:-12]

    def feed(self, reader) -> None:
        """Copy the request body into ffmpeg until it ends or Stop is pressed."""
        proc = self.proc
        if not proc or not proc.stdin:
            self.ended.set()
            return
        # ffmpeg opens the RTMP output as soon as it has read the input header,
        # so it either connects early or exits early. The relay is only called
        # live once ffmpeg has consumed more than its pipe buffer without
        # dying — proof it is really reading and the handshake went through.
        live_marked = False
        try:
            while not self.stop_event.is_set():
                chunk = reader.read(65536)
                if not chunk:
                    break
                if proc.poll() is not None:
                    # ffmpeg exited before we stopped: a bad key, no network, an
                    # unsupported stream. Its stderr tail says which.
                    tail = " ".join(self.stderr_tail[-3:])
                    self._set(STREAM_FAILED, tail or "ffmpeg stopped.")
                    break
                try:
                    proc.stdin.write(chunk)
                    proc.stdin.flush()
                except (BrokenPipeError, ValueError, OSError) as exc:
                    tail = " ".join(self.stderr_tail[-3:]) or str(exc)
                    self._set(STREAM_FAILED, tail)
                    break
                self.bytes_in += len(chunk)
                if not live_marked and self.bytes_in >= 131072:
                    live_marked = True
                    self._set(STREAM_LIVE, "")
        finally:
            self._close_stdin()
            self._finish()

    def _close_stdin(self) -> None:
        proc = self.proc
        if proc and proc.stdin:
            try:
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

    def _finish(self) -> None:
        proc = self.proc
        if not proc:
            self.ended.set()
            return
        try:
            code = proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                code = proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                code = -1
        with self.lock:
            stopping = self.state == STREAM_STOPPED
        if code == 0:
            self._set(STREAM_STOPPED, "")
        elif not stopping:
            tail = " ".join(self.stderr_tail[-3:])
            self._set(STREAM_FAILED, tail or ("ffmpeg exited with %s" % code))
        self.ended.set()

    def stop(self) -> None:
        self.stop_event.set()
        with self.lock:
            if self.state in (STREAM_CONNECTING, STREAM_LIVE):
                self.state = STREAM_STOPPED
        # Closing stdin makes the feed loop end and ffmpeg flush and exit.
        self._close_stdin()


def _redact_url(url: str) -> str:
    """The RTMP URL with the stream key removed, for display and logs."""
    if not url:
        return ""
    head, sep, tail = url.rpartition("/")
    if not sep:
        return url
    return head + "/" + ("*" * min(len(tail), 12) if tail else "")


def _redact_text(text: str) -> str:
    """Strip anything that looks like a stream key from an ffmpeg log line."""
    return re.sub(r"(rtmps?://\S+/)\S+", r"\1****", text)


# The one live session, guarded by a lock. The console starts one at a time.
_stream_lock = threading.Lock()
_stream: "StreamSession | None" = None


def current_stream() -> "StreamSession | None":
    with _stream_lock:
        return _stream


def begin_stream(session: StreamSession) -> bool:
    """Claim the single stream slot. False when one is already live."""
    global _stream
    with _stream_lock:
        if _stream is not None and not _stream.ended.is_set():
            return False
        _stream = session
        return True


def clear_stream(session: StreamSession) -> None:
    global _stream
    with _stream_lock:
        if _stream is session:
            _stream = None


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files, plus /proxy for the webpage panel and /stream for RTMP."""

    # Uploading a live stream means reading the body as it arrives, so the
    # usual per-connection timeout does not apply.
    timeout = None

    def do_GET(self):  # noqa: N802 (http.server naming)
        path = urllib.parse.urlparse(self.path).path
        if path == PROXY_PATH:
            self._handle_proxy()
            return
        if path == STREAM_STATUS_PATH:
            self._handle_stream_status()
            return
        if path == STREAM_PROBE_PATH:
            self._handle_stream_probe()
            return
        if path == STREAM_STOP_PATH:
            self._handle_stream_stop()
            return
        if path == STREAM_WS_PATH and _is_websocket_upgrade(self.headers):
            self._handle_stream_ws()
            return
        super().do_GET()

    def do_POST(self):  # noqa: N802 (http.server naming)
        path = urllib.parse.urlparse(self.path).path
        if path == STREAM_PATH:
            self._handle_stream_start()
            return
        self.send_error(404, "Not found")

    # ------------------------------------------------------------------ stream

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write(body)

    def _handle_stream_status(self) -> None:
        session = current_stream()
        if session is None:
            self._json(200, {"state": "idle"})
            return
        self._json(200, session.snapshot())

    def _handle_stream_stop(self) -> None:
        session = current_stream()
        if session is not None:
            session.stop()
        self._json(200, {"state": "stopping"})

    def _handle_stream_probe(self) -> None:
        ffmpeg = find_ffmpeg()
        self._json(200, {
            "ffmpeg": bool(ffmpeg),
            "path": ffmpeg,
            "version": ffmpeg_version(ffmpeg) if ffmpeg else "",
            "rtmp": ffmpeg_has_rtmp(ffmpeg) if ffmpeg else False,
        })

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _open_relay(self, rtmp_url: str, audio_codec: str = "aac"):
        """Claims the one stream slot for this RTMP target.

        Returns (session, None) on success, or (None, (status, message)) so the
        caller can answer in whatever way its transport allows — an HTTP error
        for a POST, a plain close for a WebSocket."""
        parsed = urllib.parse.urlparse(rtmp_url)
        if parsed.scheme not in ("rtmp", "rtmps") or not parsed.hostname:
            return None, (400, "Enter an rtmp:// or rtmps:// address.")

        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            return None, (503, "ffmpeg was not found on the server, so it cannot "
                               "relay to RTMP. Install ffmpeg or set EWC_FFMPEG "
                               "to its path.")
        if not ffmpeg_has_rtmp(ffmpeg):
            return None, (503, "This ffmpeg has no RTMP support, so it cannot "
                               "relay. Install a build with RTMP, or set "
                               "EWC_FFMPEG.")

        session = StreamSession(ffmpeg, rtmp_url, audio_codec)
        if not begin_stream(session):
            return None, (409, "A stream is already running.")
        return session, None

    def _handle_stream_start(self) -> None:
        # The URL travels in a header, not the body: the body is the live video
        # and there is nothing to buffer it with. The key is in the URL, so the
        # server never logs or echoes it back.
        rtmp_url = (self.headers.get("X-RTMP-URL") or "").strip()
        session, error = self._open_relay(rtmp_url)
        if session is None:
            self._json(error[0], {"error": error[1]})
            return

        # The body is an unbounded upload, so it must not be read as a whole.
        # Answer the headers first (the console treats a 200 as "relay ready"),
        # then pipe the body into ffmpeg for as long as it lasts.
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self._write(b'{"state":"ready"}\n')
        except (BrokenPipeError, ConnectionResetError):
            clear_stream(session)
            return

        session.start()
        if session.state == STREAM_FAILED:
            # ffmpeg could not even start; say so and stop.
            clear_stream(session)
            return
        transfer = (self.headers.get("Transfer-Encoding") or "").lower()
        body = _ChunkedReader(self.rfile) if "chunked" in transfer else self.rfile
        session.feed(body)
        # The session is deliberately left in place: its final state ('stopped'
        # or 'failed', with the reason) is what the console reads next. The next
        # Go Live replaces it, because begin_stream sees that it has ended.

    def _handle_stream_ws(self) -> None:
        """The live relay over a WebSocket.

        A streaming `fetch` body needs HTTP/2, which this server is not, so the
        console sends the encoded MP4 as WebSocket binary frames instead. The
        RTMP URL arrives as the first text message (a header cannot be read
        after the handshake reply is already on the wire), the relay is opened,
        and the rest of the socket is piped into ffmpeg."""
        key = self.headers.get("Sec-WebSocket-Key") or ""
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", websocket_accept(key))
        self.end_headers()
        # Past the handshake there are no more HTTP requests on this socket.
        self.close_connection = True
        try:
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

        reader = _WebSocketReader(self.rfile, self.wfile)
        hello = reader.read_message()
        if not hello:
            return
        try:
            hello_json = json.loads(hello.decode("utf-8"))
            rtmp_url = str(hello_json.get("url", "")).strip()
            audio_codec = str(hello_json.get("audio", "aac") or "aac").strip()
        except (ValueError, UnicodeDecodeError, AttributeError):
            reader._send_frame(_WS_CLOSE)
            return

        session, error = self._open_relay(rtmp_url, audio_codec)
        if session is None:
            # The relay refused (bad URL, no ffmpeg, already running). The
            # console cannot read an HTTP body after the 101 handshake, so it
            # reads the reason from /stream/status instead.
            reader._send_frame(_WS_CLOSE)
            return

        session.start()
        if session.state == STREAM_FAILED:
            clear_stream(session)
            reader._send_frame(_WS_CLOSE)
            return
        reader._send_frame(_WS_TEXT, b'{"state":"ready"}')
        session.feed(reader)

    # ------------------------------------------------------------------ proxy

    def _write(self, data: bytes) -> None:
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _proxy_error(self, status: int, message: str) -> None:
        page = (
            "<!doctype html><meta charset=\"utf-8\">"
            "<title>Cannot show this page</title>"
            "<style>"
            "html,body{height:100%;margin:0}"
            "body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#0b1533;"
            "color:#f8f9fd;display:flex;align-items:center;justify-content:center;text-align:center}"
            "div{max-width:34rem;padding:2rem}"
            "b{display:block;margin-bottom:.6rem;font-size:1.1rem;color:#ffc24b}"
            "</style>"
            "<div><b>Cannot show this page</b>%s</div>" % html.escape(message)
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write(page)

    def _handle_proxy(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (query.get("url") or [""])[0].strip()

        parsed = urllib.parse.urlparse(target)
        if not target or parsed.scheme not in ("http", "https") or not parsed.hostname:
            self._proxy_error(400, "Enter an address starting with http:// or https://")
            return
        if not ALLOW_PRIVATE and not _host_is_public(parsed.hostname):
            self._proxy_error(
                403,
                "That address is on a private or local network, which this server will "
                "not fetch. Start the server with EWC_PROXY_ALLOW_PRIVATE=1 if you "
                "really do need an intranet page.",
            )
            return

        request = urllib.request.Request(
            target,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-GB,en;q=0.9",
                "Accept-Encoding": "identity",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=PROXY_TIMEOUT) as response:
                final_url = response.geturl()
                final_host = urllib.parse.urlparse(final_url).hostname or ""
                if not ALLOW_PRIVATE and not _host_is_public(final_host):
                    self._proxy_error(403, "That address redirected to a private network.")
                    return
                content_type = response.headers.get("Content-Type", "text/html")
                body = response.read(MAX_PROXY_BYTES + 1)
        except urllib.error.HTTPError as exc:
            self._proxy_error(502, "The site answered %s %s." % (exc.code, exc.reason))
            return
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, ValueError) as exc:
            self._proxy_error(502, "Could not reach that address (%s)." % html.escape(str(exc)))
            return

        if len(body) > MAX_PROXY_BYTES:
            body = body[:MAX_PROXY_BYTES]

        lowered = content_type.lower()
        if "html" in lowered or "xml" in lowered:
            body = _rewrite_html(body, final_url)

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(
        Handler,
        directory=str(pathlib.Path(__file__).resolve().parent),
    )
    print(f"Control room  http://localhost:{port}/console.html")
    print(f"Display       http://localhost:{port}/display.html")
    ffmpeg = find_ffmpeg()
    if ffmpeg and ffmpeg_has_rtmp(ffmpeg):
        print(f"Go Live       ffmpeg relay ready ({ffmpeg})")
    elif ffmpeg:
        print(f"Go Live       ffmpeg at {ffmpeg} has no RTMP support")
    else:
        print("Go Live       no ffmpeg found; RTMP streaming is unavailable")
    print("Ctrl-C to stop")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
