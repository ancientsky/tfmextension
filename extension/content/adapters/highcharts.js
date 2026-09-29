/**
 * Highcharts adapter (MAIN world).
 *
 * window.__tfmAdapters.highcharts = {
 *   name, detect(), list(), extract(chartIndex, opts), apply(chartIndex, payload), revert(chartIndex)
 * }
 *
 * "chartIndex" is the index inside Highcharts.charts (stable for the chart's lifetime).
 */
(function () {
  'use strict';

  const TFM_FLAG = 'tfmForecast';          // set on series options we add
  const ORIG_CATS = '__tfmOrigCategories';  // stored on the chart when we extend the axis
  const REFERENCE_NAME = /閾值|警戒|基準|基線|參考|threshold|baseline|alert|target|limit/i;

  function hc() { return window.Highcharts; }
  function axisHelper() { return window.__tfmAxis; }

  function detect() { return !!(hc() && Array.isArray(hc().charts)); }

  function liveCharts() {
    return hc().charts
      .map((c, i) => ({ chart: c, index: i }))
      .filter(({ chart }) => chart && chart.renderTo && chart.series && chart.xAxis && chart.xAxis.length);
  }

  function isPlottable(s) {
    if (!s || !s.options || s.options[TFM_FLAG]) return false;
    const t = s.type || 'line';
    return ['line', 'spline', 'area', 'areaspline', 'column', 'bar', 'scatter'].includes(t) && s.visible !== false;
  }

  function yValues(s) {
    // Highcharts <= 11 keeps processed arrays on the series; fall back to points.
    if (Array.isArray(s.yData) && s.yData.length) return s.yData.map(v => (v == null ? null : Number(v)));
    return (s.points || s.data || []).map(p => (p && p.y != null ? Number(p.y) : null));
  }
  function xValues(s) {
    if (Array.isArray(s.xData) && s.xData.length) return s.xData.slice();
    return (s.points || s.data || []).map(p => (p ? p.x : null));
  }

  /**
   * Reference lines (epidemic thresholds, alert levels, targets) are not data:
   * a dashed line with only a handful of distinct values, or a tell-tale name.
   */
  function referenceReason(s, ys) {
    const dash = String(s.options.dashStyle || 'Solid').toLowerCase();
    const finite = ys.filter(v => v != null && isFinite(v));
    const distinct = new Set(finite).size;
    if (REFERENCE_NAME.test(s.name || '')) return 'name';
    if (dash !== 'solid' && distinct <= 3) return 'dashedConstant';
    if (finite.length >= 8 && distinct === 1) return 'constant';
    return null;
  }

  function axisKind(chart) {
    const ax = chart.xAxis[0];
    if (ax.categories && ax.categories.length) return 'category';
    if (ax.options && ax.options.type === 'datetime') return 'datetime';
    return 'linear';
  }

  /** Title from the chart itself, else a short heading placed just before the container in the DOM. */
  function chartTitle(chart) {
    const t = chart.title && chart.title.textStr;
    if (t) return t;
    let node = chart.renderTo;
    for (let i = 0; i < 3 && node && node.parentElement; i++) {
      node = node.parentElement;
      const first = node.firstElementChild;
      if (first && first !== chart.renderTo && !first.contains(chart.renderTo)) {
        const text = (first.textContent || '').trim();
        if (text.length >= 2 && text.length <= 80) return text;
      }
    }
    const y = chart.yAxis && chart.yAxis[0] && chart.yAxis[0].options.title && chart.yAxis[0].options.title.text;
    return y || chart.renderTo.id || '';
  }

  function yAxisTitle(chart, s) {
    const ax = (s && s.yAxis) || (chart.yAxis && chart.yAxis[0]);
    return (ax && ax.options.title && ax.options.title.text) || '';
  }

  /** Summaries for the UI (no values). */
  function list() {
    return liveCharts().map(({ chart, index }) => ({
      index,
      containerId: chart.renderTo.id || null,
      title: chartTitle(chart),
      axis: axisKind(chart),
      seriesCount: chart.series.filter(s => isPlottable(s) && !referenceReason(s, yValues(s))).length,
      hasForecast: chart.series.some(s => s.options && s.options[TFM_FLAG]),
    }));
  }

  function getChart(index) {
    const chart = hc().charts[index];
    if (!chart || !chart.series) throw new Error(`chart ${index} no longer exists`);
    return chart;
  }

  /**
   * Index of the last category whose period is complete (status 'past'), or -1 when the
   * labels are not dated.  Everything after it is either the current (incomplete) period
   * or pre-generated future slots that sites like NIDSS fill with 0 / null.
   */
  function lastCompleteIndex(categories, kind) {
    const A = axisHelper();
    if (!A || !categories || !kind) return -1;
    const statuses = categories.map(c => A.periodStatus(c, kind));
    if (statuses.every(s => s === null)) return -1;
    let idx = -1;
    statuses.forEach((s, i) => { if (s === 'past') idx = i; });
    return idx;
  }

  function xAxisTitle(chart) {
    const ax = chart.xAxis && chart.xAxis[0];
    return (ax && ax.options.title && ax.options.title.text) || '';
  }

  /**
   * Returns the data the API needs plus what apply() needs to place the forecast.
   * opts.ignoreLast: drop that many additional trailing observed points.
   */
  function extract(index, opts) {
    const ignoreLast = Math.max(0, (opts && opts.ignoreLast) || 0);
    const chart = getChart(index);
    const kind = axisKind(chart);
    const categories = kind === 'category' ? chart.xAxis[0].categories.map(String) : null;
    const notes = [];
    const skipped = [];

    const labelKind = kind === 'category' && axisHelper() ? axisHelper().detectLabelKind(categories, xAxisTitle(chart)) : null;
    const completeIdx = kind === 'category' ? lastCompleteIndex(categories, labelKind) : -1;
    const dated = completeIdx >= 0;
    let excludedCurrent = null;
    let excludedFuture = null;

    const series = [];
    chart.series.forEach((s) => {
      if (!isPlottable(s)) return;
      const ys = yValues(s);
      const reason = referenceReason(s, ys);
      if (reason) { skipped.push({ name: s.name, reason }); return; }
      const xs = xValues(s);

      let last = ys.length - 1;
      while (last >= 0 && (ys[last] == null || !isFinite(ys[last]))) last--;

      if (dated && last > completeIdx) {
        // Points in the current or future periods carry data: remember what we drop.
        const A = axisHelper();
        for (let i = completeIdx + 1; i <= last; i++) {
          if (ys[i] == null) continue;
          const st = A.periodStatus(categories[i], labelKind);
          if (st === 'current' && !excludedCurrent) excludedCurrent = categories[i];
          if (st === 'future' && !excludedFuture) excludedFuture = categories[i];
        }
        last = completeIdx;
        while (last >= 0 && (ys[last] == null || !isFinite(ys[last]))) last--;
      }

      const cut = Math.max(-1, last - ignoreLast);
      if (cut < 0) return;
      series.push({
        seriesIndex: chart.series.indexOf(s),
        name: s.name,
        color: s.color,
        type: s.type,
        yAxis: s.options.yAxis || 0,
        unit: yAxisTitle(chart, s),
        values: ys.slice(0, cut + 1),         // context sent to the model
        forecastStart: cut + 1,               // point index where the forecast begins
        lastX: kind === 'category' ? cut : xs[cut],
        lastY: ys[cut],
        lastLabel: kind === 'category' ? categories[cut] : String(xs[cut]),
        xStep: kind !== 'category' && xs.length > 1 ? xs[xs.length - 1] - xs[xs.length - 2] : 1,
      });
    });

    // Series that are too short for the model or stopped long before the others are not forecast.
    const MIN_POINTS = 32;
    const latestStart = Math.max(0, ...series.map(s => s.forecastStart));
    const tooShort = [], stale = [];
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      if (s.values.length < MIN_POINTS) { tooShort.unshift(s.name); series.splice(i, 1); }
      else if (s.forecastStart < latestStart - 4) { stale.unshift(s.name); series.splice(i, 1); }
    }
    // Notes are structured; the UI layer renders them in the user's language.
    if (tooShort.length) notes.push({ code: 'tooShort', names: tooShort, min: MIN_POINTS });
    if (stale.length) notes.push({ code: 'stale', names: stale });
    if (excludedCurrent) notes.push({ code: 'currentPeriod', label: excludedCurrent, kind: labelKind });
    if (excludedFuture) notes.push({ code: 'futureFill', label: excludedFuture });
    if (ignoreLast > 0) notes.push({ code: 'ignoreLast', n: ignoreLast });
    skipped.forEach(k => notes.push({ code: 'reference', name: k.name, reason: k.reason }));

    return { index, title: chartTitle(chart), axis: kind, labelKind, categories, series, notes, skipped };
  }

  function ensureCategories(chart, needed, labelKind) {
    const ax = chart.xAxis[0];
    const cats = ax.categories.map(String);
    if (needed <= cats.length) return cats;
    if (!chart[ORIG_CATS]) chart[ORIG_CATS] = cats.slice();
    const extra = axisHelper().extendCategories(cats, needed - cats.length, labelKind);
    const next = cats.concat(extra);
    ax.setCategories(next, false);
    return next;
  }

  /**
   * payload = { extracted, results: [{point, quantiles:{"0.1":[],"0.5":[],"0.9":[]}}], horizon, showBand,
   *             text: { forecast, band } }   // localized suffixes for the added series names
   * Returns the x labels used for each series' forecast so the UI can describe it.
   */
  function apply(index, payload) {
    const chart = getChart(index);
    const { extracted, results, showBand } = payload;
    const horizon = payload.horizon;
    const text = Object.assign({ forecast: 'forecast', band: '10–90%' }, payload.text || {});
    const hasRange = !!(hc().seriesTypes && hc().seriesTypes.arearange);

    revert(index, false);

    let cats = null;
    if (extracted.axis === 'category') {
      const needed = Math.max(...extracted.series.map(s => s.forecastStart + horizon));
      cats = ensureCategories(chart, needed, extracted.labelKind);
    }

    const labels = [];
    extracted.series.forEach((meta, i) => {
      const res = results[i];
      if (!res) return;
      const src = chart.series[meta.seriesIndex];
      const color = (src && src.color) || meta.color;
      if (src && !src.options.id) src.options.id = `tfm-src-${index}-${meta.seriesIndex}`;
      const linkedTo = src ? src.options.id : undefined;

      const xAt = k => (extracted.axis === 'category'
        ? meta.forecastStart + k
        : meta.lastX + (k + 1) * meta.xStep);
      labels.push(res.point.map((_, k) => (cats ? cats[xAt(k)] : String(xAt(k)))));

      // Median: connect from the last observed point so the line is continuous.
      const median = [];
      if (meta.lastY != null) median.push([extracted.axis === 'category' ? meta.forecastStart - 1 : meta.lastX, meta.lastY]);
      res.point.forEach((v, k) => median.push([xAt(k), v]));

      chart.addSeries({
        [TFM_FLAG]: true,
        id: `tfm-fc-${index}-${meta.seriesIndex}`,
        name: `${meta.name} ${text.forecast}`,
        type: 'line',
        color,
        dashStyle: 'ShortDash',
        lineWidth: 2,
        marker: { enabled: true, radius: 2.5, symbol: 'circle' },
        yAxis: meta.yAxis,
        linkedTo,
        zIndex: 10,
        data: median,
      }, false);

      const lo = res.quantiles['0.1'], hi = res.quantiles['0.9'];
      if (showBand && lo && hi) {
        if (hasRange) {
          chart.addSeries({
            [TFM_FLAG]: true,
            name: `${meta.name} ${text.band}`,
            type: 'arearange',
            color,
            fillOpacity: 0.15,
            lineWidth: 0,
            marker: { enabled: false },
            enableMouseTracking: false,
            yAxis: meta.yAxis,
            linkedTo,
            zIndex: 5,
            data: lo.map((l, k) => [xAt(k), l, hi[k]]),
          }, false);
        } else {
          [lo, hi].forEach((arr, j) => chart.addSeries({
            [TFM_FLAG]: true,
            name: `${meta.name} ${j ? 'q90' : 'q10'}`,
            type: 'line',
            color,
            dashStyle: 'Dot',
            lineWidth: 1,
            opacity: 0.7,
            marker: { enabled: false },
            enableMouseTracking: false,
            yAxis: meta.yAxis,
            linkedTo,
            zIndex: 5,
            data: arr.map((v, k) => [xAt(k), v]),
          }, false));
        }
      }
    });

    chart.redraw();
    return { ok: true, seriesAdded: chart.series.filter(s => s.options[TFM_FLAG]).length, labels };
  }

  function revert(index, redraw = true) {
    const chart = getChart(index);
    chart.series.filter(s => s.options && s.options[TFM_FLAG]).forEach(s => s.remove(false));
    if (chart[ORIG_CATS]) {
      chart.xAxis[0].setCategories(chart[ORIG_CATS], false);
      delete chart[ORIG_CATS];
    }
    if (redraw) chart.redraw();
    return { ok: true };
  }

  window.__tfmAdapters = window.__tfmAdapters || {};
  window.__tfmAdapters.highcharts = { name: 'highcharts', detect, list, extract, apply, revert };
})();
