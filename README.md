# Shorty — selektor i cięcie fragmentów VODa

Statyczna aplikacja webowa do wybierania fragmentów z długiego VODa, edycji czasów
i cięcia klipów w przeglądarce (ffmpeg.wasm). Hostowana na **Cloudflare Workers with
Static Assets** — strona jest czysto statyczna, Worker budzi się tylko dla `/api/*`.

## Struktura

```
public/            # assety statyczne (serwowane bez uruchamiania Workera)
  index.html       # cały front (dawne shorty.html)
  _headers         # COOP/COEP → cross-origin isolation dla ffmpeg core-mt / WORKERFS
src/
  index.js         # Worker: obsługuje tylko /api/* (health, transcribe proxy)
wrangler.toml      # konfiguracja; run_worker_first = ["/api/*"]
serve.py           # lokalny serwer z COOP/COEP do testów bez deployu
```

## Dlaczego cross-origin isolation

ffmpeg.wasm w trybie wielowątkowym (`core-mt`) wymaga `SharedArrayBuffer`, a ten jest
dostępny tylko gdy `crossOriginIsolated === true`. To z kolei wymaga nagłówków:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Dopiero tryb `core-mt` pozwala **montować** duże pliki (WORKERFS) zamiast ładować całość
do pamięci — konieczne dla VOD-ów ≥ 2 GB (limit heapu 32-bit WASM ~2 GB).

## Lokalne testy

```bash
python3 serve.py           # http://localhost:8000/  (wysyła COOP/COEP)
```

Albo przez wrangler (obsługuje też `/api/*` i `_headers`):

```bash
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

Po deployu **zweryfikować** w DevTools → Console:

```js
crossOriginIsolated === true
```

oraz w Network, że odpowiedź `index.html` ma nagłówek `Cross-Origin-Embedder-Policy`.

## /api/transcribe (proxy do API transkrypcji)

Worker przyjmuje audio z przeglądarki i strumieniowo (bez buforowania — limit pamięci
Workera 128 MB) przekazuje je do zewnętrznego API, dokładając klucz z sekretu:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Cel można nadpisać zmiennymi środowiskowymi (np. własny endpoint OVH WhisperX):

- `TRANSCRIBE_UPSTREAM_URL` — domyślnie `https://api.openai.com/v1/audio/transcriptions`
- `TRANSCRIBE_AUTH_HEADER` / `TRANSCRIBE_AUTH_PREFIX` — nazwa/prefiks nagłówka autoryzacji

Limity: request body 100 MB (Free/Pro), OpenAI Whisper limit pliku 25 MB.
