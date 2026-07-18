#!/usr/bin/env python3
# Serwer HTTP z nagłówkami COOP/COEP, wymaganymi przez tryb wielowątkowy ffmpeg.wasm
# (SharedArrayBuffer / crossOriginIsolated), który z kolei jest potrzebny do montowania
# dużych plików przez WORKERFS (cięcie VOD-ów > 2 GB bez ładowania całości do pamięci).
#
# Użycie:
#   cd folder-z-shorty.html
#   python3 serve.py           # domyślnie port 8000
#   python3 serve.py 8080      # własny port
# potem otwórz http://localhost:8000/shorty.html
#
# Dla plików < 2 GB serwer nie jest konieczny — wystarczy zwykły `python3 -m http.server`.

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class COOPCOEPHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # pozwól, by zasoby z CDN (rdzeń ffmpeg) ładowały się przy require-corp
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    httpd = ThreadingHTTPServer(('0.0.0.0', port), COOPCOEPHandler)
    print(f"Serwer z COOP/COEP działa na http://localhost:{port}/")
    print(f"Otwórz http://localhost:{port}/shorty.html")
    print("Ctrl+C aby zatrzymać.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nZatrzymano.")
