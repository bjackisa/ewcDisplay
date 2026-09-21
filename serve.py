#!/usr/bin/env python3
"""Serves this folder over http so index.html can be opened at localhost.

    python3 serve.py            # http://localhost:12000
    python3 serve.py 8080       # pick your own port

Opening index.html straight off disk (file:///…) also works — sermon text
comes from bible-data.js, and a classic <script src> is allowed across
file:// URLs where fetch() is not. This server is just the tidier option:
no CORS quirks, and nothing depends on bible-data.js being present.
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
    print(f"Serving on http://localhost:{port}/index.html — Ctrl-C to stop")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
