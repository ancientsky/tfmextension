const DEFAULTS = { apiUrl: 'http://localhost:7860', apiKey: '', horizon: 8, ignoreLast: 0, showBand: true, uiLang: 'auto' };
const $ = (id) => document.getElementById(id);

const I18N = {
  zh: {
    title: 'TimesFM 趨勢預測', lang: '介面語言', langAuto: '自動（跟隨網頁語言）', langHint: 'NIDSS 英文版（網址含 /en/）會自動使用英文', apiUrl: 'API 網址',
    apiUrlHint: '本機：<code>http://localhost:7860</code>；Hugging Face Space：<code>https://&lt;user&gt;-&lt;space&gt;.hf.space</code>',
    apiKey: 'API Key（選填）', horizon: '預測期數（horizon）', horizonHint: '週資料建議 4 ~ 12',
    ignoreLast: '額外忽略最後 N 個觀測點', ignoreLastHint: '未滿週與未來預填區段會自動排除；這裡可再多略過幾期',
    showBand: '顯示 10% / 90% 分位數線', save: '儲存', test: '測試連線',
    saved: '已儲存', connecting: '連線中…', ready: (m, d) => `就緒：${m}（${d}）`,
    loading: '服務已連上，模型載入中（Space 冷啟動可能需要 1 ~ 3 分鐘）', svcError: (e) => `服務錯誤：${e}`,
    failed: (e) => `連線失敗：${e}`, noResp: '沒有回應',
  },
  en: {
    title: 'TimesFM Trend Forecast', lang: 'Interface language', langAuto: 'Auto (follow the page language)', langHint: 'The English NIDSS site (URL contains /en/) switches to English automatically', apiUrl: 'API URL',
    apiUrlHint: 'Local: <code>http://localhost:7860</code>; Hugging Face Space: <code>https://&lt;user&gt;-&lt;space&gt;.hf.space</code>',
    apiKey: 'API key (optional)', horizon: 'Forecast horizon (periods)', horizonHint: '4–12 is a good range for weekly data',
    ignoreLast: 'Additionally ignore the last N observations', ignoreLastHint: 'The incomplete current week and pre-filled future slots are excluded automatically; this skips a few more periods',
    showBand: 'Show 10% / 90% quantile lines', save: 'Save', test: 'Test connection',
    saved: 'Saved', connecting: 'Connecting…', ready: (m, d) => `Ready: ${m} (${d})`,
    loading: 'Connected; the model is still loading (a cold Space start can take 1–3 minutes)', svcError: (e) => `Service error: ${e}`,
    failed: (e) => `Connection failed: ${e}`, noResp: 'no response',
  },
};
let lang = 'zh';          // language of this options page
const T = () => I18N[lang];
const browserLang = () => ((chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : navigator.language) || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';

function applyLang() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key.endsWith('Hint')) el.innerHTML = T()[key]; else el.textContent = T()[key];
  });
  document.title = T().title;
}

function setStatus(text, kind = '') { const el = $('status'); el.textContent = text; el.className = kind; }

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('apiUrl').value = s.apiUrl;
  $('apiKey').value = s.apiKey;
  $('horizon').value = s.horizon;
  $('ignoreLast').value = s.ignoreLast;
  $('showBand').checked = !!s.showBand;
  $('lang').value = ['auto', 'zh', 'en'].includes(s.uiLang) ? s.uiLang : 'auto';
  lang = s.uiLang === 'zh' || s.uiLang === 'en' ? s.uiLang : browserLang();
  applyLang();
}

async function save() {
  const s = {
    apiUrl: $('apiUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.apiUrl,
    apiKey: $('apiKey').value.trim(),
    horizon: Math.min(64, Math.max(1, parseInt($('horizon').value, 10) || DEFAULTS.horizon)),
    ignoreLast: Math.max(0, parseInt($('ignoreLast').value, 10) || 0),
    showBand: $('showBand').checked,
    uiLang: $('lang').value,
  };
  await chrome.storage.sync.set(s);
  setStatus(T().saved, 'ok');
  return s;
}

async function test() {
  await save();
  setStatus(T().connecting);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'health' });
    if (!r || !r.ok) throw new Error((r && (r.error || `HTTP ${r.status}`)) || T().noResp);
    const h = r.data;
    setStatus(h.status === 'ok' ? T().ready(h.model, h.device)
      : h.status === 'loading' ? T().loading : T().svcError(h.error),
      h.status === 'error' ? 'error' : 'ok');
  } catch (e) {
    setStatus(T().failed(e.message), 'error');
  }
}

$('lang').addEventListener('change', () => {
  const v = $('lang').value;
  lang = v === 'zh' || v === 'en' ? v : browserLang();
  applyLang();
});
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
