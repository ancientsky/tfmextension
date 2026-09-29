/**
 * Service worker: the only place that talks to the forecast API.
 * host_permissions in the manifest let us fetch cross-origin without CORS.
 */
const DEFAULTS = {
  apiUrl: 'http://localhost:7860',
  apiKey: '',
};
const WAKE_TIMEOUT_MS = 3 * 60 * 1000;   // how long to wait for a sleeping Space
const HEALTH_TIMEOUT_MS = 8000;
const FORECAST_TIMEOUT_MS = 120000;

const MSG = {
  zh: {
    loadFailed: (e) => `模型載入失敗：${e}`,
    loading: '模型載入中',
    timeout: '逾時',
    unreachable: '無法連線',
    notReady: (e) => `服務在 3 分鐘內沒有就緒（${e}）`,
  },
  en: {
    loadFailed: (e) => `Model failed to load: ${e}`,
    loading: 'model is loading',
    timeout: 'timed out',
    unreachable: 'unreachable',
    notReady: (e) => `Service was not ready within 3 minutes (${e})`,
  },
};

function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Polls /health until the model is ready. Returns {waited, health}. */
async function waitUntilReady(base, headers, t) {
  const started = Date.now();
  let lastErr = t.unreachable;
  while (Date.now() - started < WAKE_TIMEOUT_MS) {
    try {
      const r = await fetchWithTimeout(`${base}/health`, { headers }, HEALTH_TIMEOUT_MS);
      if (r.ok) {
        const h = await r.json();
        if (h.status === 'ok') return { waited: Date.now() - started, health: h };
        if (h.status === 'error') { const e = new Error(t.loadFailed(h.error)); e.fatal = true; throw e; }
        lastErr = t.loading;
      } else {
        lastErr = `HTTP ${r.status}`;
      }
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e.name === 'AbortError' ? t.timeout : e.message;
    }
    await sleep(4000);
  }
  throw new Error(t.notReady(lastErr));
}

async function forecast(msg) {
  const { apiUrl, apiKey } = await getSettings();
  const t = MSG[msg.lang === 'en' ? 'en' : 'zh'];
  const base = apiUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;

  const { waited } = await waitUntilReady(base, headers, t);

  const body = JSON.stringify({
    series: msg.series,
    horizon: msg.horizon,
    non_negative: msg.nonNegative !== false,
    quantiles: [0.1, 0.5, 0.9],
  });
  const r = await fetchWithTimeout(`${base}/forecast`, { method: 'POST', headers, body }, FORECAST_TIMEOUT_MS);
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (_) { /* keep */ }
    throw new Error(detail);
  }
  return { ok: true, waking: waited > 5000, data: await r.json() };
}

async function health() {
  const { apiUrl, apiKey } = await getSettings();
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  const r = await fetchWithTimeout(`${apiUrl.replace(/\/+$/, '')}/health`, { headers }, HEALTH_TIMEOUT_MS);
  return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const job = msg.type === 'forecast' ? forecast(msg)
            : msg.type === 'health' ? health()
            : Promise.reject(new Error(`unknown message ${msg.type}`));
  job.then(sendResponse, (err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true; // keep the channel open for the async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
