/**
 * Isolated-world UI script.
 *  - asks the MAIN-world bridge which charts exist
 *  - places a compact toolbar (預測 / 還原 / 中·EN) on the chart's title row and a text summary below the chart
 *  - forwards forecast requests to the background service worker
 */
(function () {
  'use strict';
  if (window.__tfmUiInstalled) return;
  window.__tfmUiInstalled = true;

  const DEFAULTS = { horizon: 8, ignoreLast: 0, showBand: true, uiLang: 'auto' };  // uiLang replaces the old 'lang' key
  let seq = 0;
  const pending = new Map();

  // ------------------------------------------------------------------- i18n
  const I18N = {
    zh: {
      run: '預測', running: '預測中', revert: '還原',
      runTitle: '用 TimesFM 預測這張圖', revertTitle: '移除預測線與摘要',
      forecast: '預測', band: '10–90%',
      summaryTitle: 'TimesFM 預測摘要', horizon: (n) => `未來 ${n} 期`,
      last: '最後觀測', next: '下一期', nth: (n) => `第 ${n} 期`, peak: '預測峰值',
      up: (p) => `上升 +${p}%`, down: (p) => `下降 ${p}%`, flat: (p) => `持平 ${p}%`, fromZero: '由零上升', flatZero: '持平',
      range: (lo, hi) => `10–90%：${lo} ~ ${hi}`, rangeShort: (lo, hi) => `${lo} ~ ${hi}`,
      showAll: (n) => `顯示全部 ${n} 條序列`, showLess: '只顯示前 3 條',
      disclaimer: (n) => `趨勢為第 ${n} 期中位數相對最後觀測值的變化；括號內為 10% ~ 90% 分位數區間。零樣本統計預測，僅供參考。`,
      stat: (s, h, ms) => `${s} 條序列 × ${h} 期 · ${ms} ms`,
      reading: '讀取圖表資料', calling: '呼叫 TimesFM', waking: '服務喚醒中',
      errNoSeries: '這張圖沒有可預測的序列', errOnlyRef: '這張圖只有參考線，沒有可預測的序列', errNoBg: '背景服務沒有回應',
      note: {
        tooShort: (n) => `已略過資料不足 ${n.min} 點的序列：${n.names.join('、')}`,
        stale: (n) => `已略過近期沒有資料的序列：${n.names.join('、')}`,
        currentPeriod: (n) => `已排除尚未結束的${({ epiweek: '週', month: '月份', day: '日期', year: '年度' })[n.kind] || '期間'} ${n.label}`,
        futureFill: (n) => `已略過 ${n.label} 起的未來預填區段`,
        ignoreLast: (n) => `依設定忽略最後 ${n.n} 個觀測點`,
        reference: (n) => `已略過參考線「${n.name}」（${({ name: '名稱為參考線', dashedConstant: '虛線且數值固定', constant: '數值固定' })[n.reason] || n.reason}）`,
      },
    },
    en: {
      run: 'Forecast', running: 'Forecasting', revert: 'Reset',
      runTitle: 'Forecast this chart with TimesFM', revertTitle: 'Remove forecast lines and summary',
      forecast: 'forecast', band: '10–90%',
      summaryTitle: 'TimesFM forecast summary', horizon: (n) => `next ${n} periods`,
      last: 'Last observed', next: 'Next period', nth: (n) => `Period ${n}`, peak: 'Forecast peak',
      up: (p) => `Up +${p}%`, down: (p) => `Down ${p}%`, flat: (p) => `Flat ${p}%`, fromZero: 'Up from zero', flatZero: 'Flat',
      range: (lo, hi) => `10–90%: ${lo} ~ ${hi}`, rangeShort: (lo, hi) => `${lo} ~ ${hi}`,
      showAll: (n) => `Show all ${n} series`, showLess: 'Show first 3 only',
      disclaimer: (n) => `Trend compares the period-${n} median with the last observed value; parentheses show the 10%–90% quantile range. Zero-shot statistical forecast, for reference only.`,
      stat: (s, h, ms) => `${s} series × ${h} periods · ${ms} ms`,
      reading: 'Reading chart data', calling: 'Calling TimesFM', waking: 'Waking up the service',
      errNoSeries: 'No forecastable series in this chart', errOnlyRef: 'This chart only has reference lines', errNoBg: 'No response from the background service',
      note: {
        tooShort: (n) => `Skipped series with fewer than ${n.min} points: ${n.names.join(', ')}`,
        stale: (n) => `Skipped series without recent data: ${n.names.join(', ')}`,
        currentPeriod: (n) => `Excluded the incomplete current ${({ epiweek: 'week', month: 'month', day: 'day', year: 'year' })[n.kind] || 'period'} ${n.label}`,
        futureFill: (n) => `Ignored pre-filled future slots from ${n.label}`,
        ignoreLast: (n) => `Ignored the last ${n.n} observation(s) as configured`,
        reference: (n) => `Skipped reference line “${n.name}” (${({ name: 'name indicates a reference line', dashedConstant: 'dashed and constant', constant: 'constant value' })[n.reason] || n.reason})`,
      },
    },
  };
  let T = I18N.zh;
  let currentLang = 'zh';

  /**
   * Page language: NIDSS serves its English version under /en/…; other sites are judged by
   * <html lang> and, failing that, by the browser UI language.
   */
  function detectPageLang() {
    if (/^\/en(\/|$)/i.test(location.pathname)) return 'en';
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (htmlLang.startsWith('zh')) return 'zh';
    if (htmlLang.startsWith('en')) return 'en';
    if (/^\/(zh|tw|zh-tw)(\/|$)/i.test(location.pathname)) return 'zh';
    // No declared language (NIDSS's Chinese site): judge by how much of the visible text is CJK.
    const sample = `${document.title} ${(document.body && document.body.innerText || '').slice(0, 3000)}`.replace(/\s+/g, '');
    if (sample.length >= 20) {
      const cjk = (sample.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
      if (cjk / sample.length >= 0.15) return 'zh';
      if (cjk / sample.length <= 0.02) return 'en';
    }
    const ui = (chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : navigator.language || '').toLowerCase();
    return ui.startsWith('zh') ? 'zh' : 'en';
  }
  function resolveLang(setting) {
    return setting === 'zh' || setting === 'en' ? setting : detectPageLang();
  }

  // ---------------------------------------------------------------- bridge RPC
  function bridge(type, args = {}) {
    return new Promise((resolve, reject) => {
      const id = `tfm-${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge timeout')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: 'tfm-ui', id, type, ...args }, '*');
    });
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'tfm-bridge') return;
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    clearTimeout(p.timer);
    ev.data.ok ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.error));
  });

  function getSettings() {
    return new Promise((resolve) => chrome.storage.sync.get(DEFAULTS, resolve));
  }

  function setLang(lang) {
    currentLang = lang === 'en' ? 'en' : 'zh';
    T = I18N[currentLang];
    document.querySelectorAll('.tfm-toolbar').forEach(applyToolbarText);
    document.querySelectorAll('.tfm-summary').forEach((box) => {
      if (box.__tfmRender) box.__tfmRender();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.uiLang) setLang(resolveLang(changes.uiLang.newValue));
  });

  // ------------------------------------------------------------ number format
  const LOCALE = () => (currentLang === 'en' ? 'en-US' : 'zh-TW');
  function fmt(v, integerLike) {
    if (v == null || !isFinite(v)) return '–';
    if (integerLike) return Math.round(v).toLocaleString(LOCALE());
    return Number(v).toLocaleString(LOCALE(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** Builds the per-series description shown under the chart. */
  function summarize(meta, res, labels) {
    const pts = res.point;
    const h = pts.length;
    // Counts in the hundreds or more read best as integers; small counts and rates keep two decimals.
    const observed = meta.values.filter(v => v != null);
    const integerLike = observed.every(Number.isInteger) && Math.max(...observed) >= 100;
    const q10 = res.quantiles['0.1'] || [], q90 = res.quantiles['0.9'] || [];
    let peakIdx = 0;
    pts.forEach((v, i) => { if (v > pts[peakIdx]) peakIdx = i; });
    const last = meta.lastY;
    const end = pts[h - 1];
    let pct = null;
    if (last != null && last !== 0) pct = ((end - last) / Math.abs(last)) * 100;
    let trend, cls;
    if (pct == null) { trend = last === 0 && end > 0 ? T.fromZero : T.flatZero; cls = 'flat'; }
    else if (pct >= 5) { trend = T.up(pct.toFixed(1)); cls = 'up'; }
    else if (pct <= -5) { trend = T.down(pct.toFixed(1)); cls = 'down'; }
    else { trend = T.flat(`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}`); cls = 'flat'; }
    const f = (v) => fmt(v, integerLike);
    return {
      name: meta.name,
      color: meta.color,
      unit: meta.unit || '',
      last: `${meta.lastLabel}: ${f(last)}`,
      next: `${labels[0]}: ${f(pts[0])} (${T.range(f(q10[0]), f(q90[0]))})`,
      end: `${labels[h - 1]}: ${f(end)} (${T.rangeShort(f(q10[h - 1]), f(q90[h - 1]))})`,
      peak: `${labels[peakIdx]}: ${f(pts[peakIdx])}`,
      trend, cls,
    };
  }

  function noteText(n) {
    const f = T.note[n.code];
    return f ? f(n) : JSON.stringify(n);
  }

  // ----------------------------------------------------------------- toolbar UI
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const ICON_RUN = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 12.5 6 7.5l3 3 5.5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 4.5h3.5V8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_REVERT = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.5 3.5 3 7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7h6a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function applyToolbarText(bar) {
    const run = bar.querySelector('.tfm-run');
    const revert = bar.querySelector('.tfm-revert');
    run.title = T.runTitle;
    run.querySelector('.tfm-label').textContent = run.classList.contains('busy') ? T.running : T.run;
    revert.title = `${T.revert} – ${T.revertTitle}`;
    revert.setAttribute('aria-label', T.revert);
    revert.querySelector('.tfm-label').textContent = T.revert;
  }

  /** The element that holds the chart's title: the card's first child when it is not the chart itself. */
  function titleRowFor(container) {
    const card = container.parentElement;
    const first = card && card.firstElementChild;
    if (first && first !== container && !first.contains(container)) return first;
    return null;
  }

  function positionToolbar(bar, container) {
    const card = container.parentElement;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const title = titleRowFor(container);
    if (title) {
      // Align with the first line of the title (long titles may wrap once the toolbar reserves space).
      const cs = getComputedStyle(title);
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || title.offsetHeight;
      const padTop = parseFloat(cs.paddingTop) || 0;
      const top = title.offsetTop + padTop + Math.max(0, (Math.min(lineH, title.offsetHeight) - bar.offsetHeight) / 2);
      bar.style.top = `${Math.round(top)}px`;
      // keep long titles from running underneath the buttons
      if (!title.__tfmPadded) {
        title.style.paddingRight = `${bar.offsetWidth + 16}px`;
        title.style.boxSizing = 'border-box';
        title.__tfmPadded = true;
      }
    } else {
      bar.style.top = '8px';
    }
  }

  function toolbarFor(container, chart) {
    const card = container.parentElement;
    let bar = card.querySelector(':scope > .tfm-toolbar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'tfm-toolbar';
    bar.innerHTML = `
      <button class="tfm-btn tfm-run"><span class="tfm-icon">${ICON_RUN}</span><span class="tfm-spinner"></span><span class="tfm-label"></span></button>
      <button class="tfm-btn tfm-revert tfm-icon-only" hidden><span class="tfm-icon">${ICON_REVERT}</span><span class="tfm-label tfm-sr"></span></button>`;
    card.appendChild(bar);
    bar.__tfmContainer = container;
    applyToolbarText(bar);
    positionToolbar(bar, container);

    bar.querySelector('.tfm-run').addEventListener('click', (e) => { e.stopPropagation(); runForecast(chart.index, container, bar); });
    bar.querySelector('.tfm-revert').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await bridge('revert', { index: chart.index });
        removeSummary(container);
        bar.querySelector('.tfm-revert').hidden = true;
      } catch (err) { showError(container, err.message); }
    });
    return bar;
  }

  function setBusy(bar, busy, label) {
    const run = bar.querySelector('.tfm-run');
    run.disabled = busy;
    run.classList.toggle('busy', busy);
    run.querySelector('.tfm-label').textContent = busy ? (label || T.running) : T.run;
  }

  function removeSummary(container) {
    const next = container.nextElementSibling;
    if (next && next.classList && (next.classList.contains('tfm-summary') || next.classList.contains('tfm-error'))) next.remove();
  }

  function showError(container, message) {
    removeSummary(container);
    const box = document.createElement('div');
    box.className = 'tfm-error';
    box.textContent = `⚠ ${message}`;
    container.parentNode.insertBefore(box, container.nextSibling);
  }

  function renderSummary(container, extracted, resp, labels, settings) {
    removeSummary(container);
    const box = document.createElement('div');
    box.className = 'tfm-summary';
    let expanded = false;

    const render = () => {
      const rows = extracted.series.map((meta, i) => summarize(meta, resp.results[i], labels[i]));
      const many = rows.length > 3;
      const unit = rows[0] && rows[0].unit ? ` (${esc(rows[0].unit)})` : '';
      const arrow = (cls) => (cls === 'up' ? '▲' : cls === 'down' ? '▼' : '►');
      box.innerHTML = `
        <div class="tfm-summary-head">
          <span>🔮 ${T.summaryTitle}${unit}｜${T.horizon(settings.horizon)}</span>
          <span class="tfm-summary-meta">${T.stat(rows.length, settings.horizon, resp.elapsed_ms)} · ${esc(resp.model.replace(/^google\//, ''))} · ${esc(resp.device)}</span>
        </div>
        ${rows.map((r, i) => `
        <div class="tfm-row" ${many && i >= 3 && !expanded ? 'hidden' : ''}>
          <div class="tfm-row-head">
            <span class="tfm-dot" style="background:${esc(r.color || '#999')}"></span><b>${esc(r.name)}</b>
            <span class="tfm-badge ${r.cls}">${arrow(r.cls)} ${esc(r.trend)}</span>
          </div>
          <div class="tfm-row-body">
            <span><i>${T.last}</i>${esc(r.last)}</span>
            <span><i>${T.next}</i>${esc(r.next)}</span>
            <span><i>${T.nth(settings.horizon)}</i>${esc(r.end)}</span>
            <span><i>${T.peak}</i>${esc(r.peak)}</span>
          </div>
        </div>`).join('')}
        ${many ? `<button class="tfm-link tfm-toggle">${expanded ? T.showLess : T.showAll(rows.length)}</button>` : ''}
        ${extracted.notes.length ? `<div class="tfm-notes">${extracted.notes.map(n => `<span>⚠ ${esc(noteText(n))}</span>`).join('')}</div>` : ''}
        <div class="tfm-disclaimer">${T.disclaimer(settings.horizon)}</div>`;
      const toggle = box.querySelector('.tfm-toggle');
      if (toggle) toggle.addEventListener('click', () => { expanded = !expanded; render(); });
    };
    box.__tfmRender = render;
    render();
    container.parentNode.insertBefore(box, container.nextSibling);
  }

  async function runForecast(index, container, bar) {
    setBusy(bar, true, T.reading);
    try {
      const settings = await getSettings();
      const extracted = await bridge('extract', { index, ignoreLast: settings.ignoreLast });
      if (!extracted.series.length) throw new Error(extracted.skipped.length ? T.errOnlyRef : T.errNoSeries);

      setBusy(bar, true, T.calling);
      const resp = await chrome.runtime.sendMessage({
        type: 'forecast',
        series: extracted.series.map(s => s.values),
        horizon: settings.horizon,
        nonNegative: true,
        lang: currentLang,
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || T.errNoBg);

      const applied = await bridge('apply', {
        index,
        payload: {
          extracted, results: resp.data.results, horizon: settings.horizon, showBand: settings.showBand,
          text: { forecast: T.forecast, band: T.band },
        },
      });
      renderSummary(container, extracted, resp.data, applied.labels, settings);
      bar.querySelector('.tfm-revert').hidden = false;
    } catch (err) {
      showError(container, err.message || String(err));
    } finally {
      setBusy(bar, false);
    }
  }

  // ----------------------------------------------------------------- scanning
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const { charts } = await bridge('list');
      for (const chart of charts) {
        const container = chart.containerId && document.getElementById(chart.containerId);
        if (!container || chart.seriesCount === 0 || !container.parentElement) continue;
        toolbarFor(container, chart);
      }
    } catch (_) {
      /* bridge not ready yet – next scan will retry */
    } finally {
      scanning = false;
    }
  }

  let timer = null;
  const scheduleScan = () => { clearTimeout(timer); timer = setTimeout(scan, 600); };
  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.tfm-toolbar').forEach((bar) => {
      if (bar.__tfmContainer && bar.__tfmContainer.isConnected) positionToolbar(bar, bar.__tfmContainer);
    });
  });

  getSettings().then((s) => { setLang(resolveLang(s.uiLang)); scan(); });
  setTimeout(scan, 1500);
  setTimeout(scan, 4000);
})();
