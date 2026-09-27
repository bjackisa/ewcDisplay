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
"""

import functools
import http.server
import pathlib
import sys

DEFAULT_PORT = 12000


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=str(pathlib.Path(__file__).resolve().parent),
    )
    print(f"Control room  http://localhost:{port}/console.html")
    print(f"Display       http://localhost:{port}/display.html")
    print("Ctrl-C to stop")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
