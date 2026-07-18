// Worker dla Shorty.
//
// Dzięki `run_worker_first = ["/api/*"]` w wrangler.toml ten Worker uruchamia się
// TYLKO dla ścieżek /api/*. Cała reszta (index.html, _headers, vendor/…) jest serwowana
// bezpośrednio przez platformę jako statyka — Worker się wtedy nie budzi, strona pozostaje
// czysto statyczna, a nagłówki COOP/COEP pochodzą z public/_headers.
//
// Endpointy:
//   GET  /api/health      — prosty ping (diagnostyka deployu)
//   POST /api/transcribe  — strumieniowy proxy do zewnętrznego API transkrypcji.
//                           Klucz API trzymany jest jako sekret Workera (env), nigdy w przeglądarce.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Worker widzi tylko /api/* (patrz run_worker_first). Gdyby jednak trafiło tu coś innego
    // — oddajemy to warstwie statycznej.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, ts: Date.now() });
    }

    if (url.pathname === '/api/transcribe') {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      }
      return handleTranscribe(request, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// Strumieniowy proxy do API transkrypcji.
//
// Przeglądarka wysyła tu audio wycięte z fragmentu (kilka–kilkanaście MB). request.body
// przekazujemy dalej jako ReadableStream — NIE buforujemy go w pamięci (limit Workera 128 MB).
//
// Cel określa env:
//   TRANSCRIBE_UPSTREAM_URL — pełny URL docelowego API (np. własny endpoint OVH WhisperX).
//                             Gdy nieustawiony, domyślnie OpenAI Whisper.
//   OPENAI_API_KEY          — sekret; wstawiany do nagłówka Authorization.
//   TRANSCRIBE_AUTH_HEADER  — (opcjonalnie) nazwa nagłówka autoryzacji, domyślnie "Authorization".
//   TRANSCRIBE_AUTH_PREFIX  — (opcjonalnie) prefiks wartości, domyślnie "Bearer ".
async function handleTranscribe(request, env) {
  const upstream = env.TRANSCRIBE_UPSTREAM_URL || 'https://api.openai.com/v1/audio/transcriptions';
  const apiKey = env.OPENAI_API_KEY || env.TRANSCRIBE_API_KEY;

  if (!apiKey) {
    return json({ error: 'missing_api_key', hint: 'Ustaw sekret: wrangler secret put OPENAI_API_KEY' }, 500);
  }

  const authHeader = env.TRANSCRIBE_AUTH_HEADER || 'Authorization';
  const authPrefix = env.TRANSCRIBE_AUTH_PREFIX ?? 'Bearer ';

  // Przekazujemy Content-Type (multipart/form-data z granicą albo audio/*) bez zmian,
  // żeby granica multipart się zgadzała. Body leci strumieniowo.
  const headers = new Headers();
  const ct = request.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  const cl = request.headers.get('Content-Length');
  if (cl) headers.set('Content-Length', cl);
  headers.set(authHeader, authPrefix + apiKey);

  const init = {
    method: 'POST',
    headers,
    body: request.body,
    // wymagane w Workers/undici do streamowania request body bez pełnego buforowania
    duplex: 'half',
  };

  let resp;
  try {
    resp = await fetch(upstream, init);
  } catch (err) {
    return json({ error: 'upstream_fetch_failed', message: String(err && err.message || err) }, 502);
  }

  // Odpowiedź (JSON transkrypcji) oddajemy do przeglądarki tak jak przyszła.
  const outHeaders = new Headers(resp.headers);
  outHeaders.delete('Transfer-Encoding');
  return new Response(resp.body, { status: resp.status, headers: outHeaders });
}

function json(obj, status = 200, extra) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (extra) Object.assign(headers, extra);
  return new Response(JSON.stringify(obj), { status, headers });
}
