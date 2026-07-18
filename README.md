# Shorty — selektor i cięcie fragmentów VODa

Statyczna aplikacja webowa do wybierania fragmentów z długiego VODa, edycji czasów
i cięcia klipów w przeglądarce (ffmpeg.wasm). Hostowana na **Cloudflare Workers with
Static Assets** — strona jest czysto statyczna, Worker budzi się tylko dla `/api/*`.

## Struktura

```
public/                # assety statyczne (serwowane bez uruchamiania Workera)
  index.html           # cały front (dawne shorty.html)
  transcribe-worker.js # Web Worker lokalnej transkrypcji (Transformers.js / Whisper)
  _headers             # COOP/COEP → cross-origin isolation dla ffmpeg core-mt / WORKERFS
src/
  index.js             # Worker: obsługuje tylko /api/* (health, transcribe proxy)
wrangler.toml          # konfiguracja; run_worker_first = ["/api/*"]
serve.py               # lokalny serwer z COOP/COEP do testów bez deployu
```

## Dane wejściowe (kandydaci)

Lista fragmentów NIE jest już wbita w kod. Wczytujesz ją z pliku JSON (przycisk
**↥ Wczytaj JSON**) w schemacie zgodnym z eksportem aplikacji, albo dodajesz fragmenty
ręcznie (**+ Dodaj fragment**). Akceptowany kształt (pola opcjonalne poza start/end):

```json
[{ "title": "...", "start": 3889, "end": 3960, "tier": "top",
   "hook": "...", "quote": "...", "why": "...", "filename": "short_01" }]
```

`start`/`end` mogą być w sekundach lub jako timecode (`HH:MM:SS`). Długość osi czasu
liczona jest z wczytanego wideo.

## Lokalna transkrypcja (w przeglądarce, prywatnie)

W oknie „Eksport i cięcie" jest panel **Transkrypcja**. Dla zaznaczonych fragmentów:
ffmpeg wycina audio 16 kHz mono (`-vn -ac 1 -ar 16000 -f f32le`), a **Transformers.js**
(Whisper przez ONNX Runtime Web) transkrybuje je lokalnie — audio nie opuszcza urządzenia.
Silnik wybierasz dwoma przyciskami **GPU (WebGPU) / CPU (WASM)** — przycisk GPU jest
wyłączony, gdy przeglądarka nie ma WebGPU (tooltip tłumaczy dlaczego). Model wybierasz w UI
(tiny/base/small/large-v3-turbo); pobiera się raz i jest cache'owany. Wynik: TXT / SRT / VTT
(timecody względem początku fragmentu). To alternatywa dla chmurowego `/api/transcribe`.

Ponieważ strona jest cross-origin isolated (COOP/COEP dla ffmpeg core-mt), pobieranie modeli
wprost z `huggingface.co` pada na CORS. Dlatego modele idą przez proxy Workera **`/api/hf/*`**
(same-origin) — Transformers.js ma ustawione `env.remoteHost` na nasz origin. Transkrypcja
działa więc tylko z uruchomionym Workerem (`wrangler dev` lub deploy), nie na gołym `serve.py`.

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
