/**
 * Category-axis helpers (MAIN world, no module system).  Exposed as window.__tfmAxis:
 *
 *   extendCategories(categories, count) -> string[]   labels that follow the given ones
 *   currentEpiWeek(date?)               -> "YYYYWW"   epidemiological week containing `date`
 *   detectLabelKind(categories, hint?)  -> 'epiweek' | 'month' | 'day' | 'year' | null
 *   periodStatus(label, kind?, today?)  -> 'past' | 'current' | 'future' | null
 *
 * Epidemiological weeks follow the MMWR / Taiwan CDC convention: weeks start on
 * Sunday and week 1 is the week that contains January 4 (so a year has 52 or 53 weeks).
 *
 * Supported label styles, detected from the label itself:
 *   YYYYWW                      epi year-week (e.g. "202653")
 *   YYYY-MM-DD / YYYY/MM/DD     daily dates (step inferred from the last two labels)
 *   YYYY-MM / YYYY/MM / YYYYMM  monthly
 *   YYYY                        yearly
 *   plain numbers               numeric step inferred from the last two labels
 * Anything else falls back to "+1", "+2", ...
 */
(function () {
  'use strict';

  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const utc = (y, m, d) => Date.UTC(y, m, d);

  /** Sunday that starts epi week 1 of `year`. */
  function week1Start(year) {
    const jan4 = new Date(utc(year, 0, 4));
    return new Date(jan4.getTime() - jan4.getUTCDay() * DAY);
  }

  /** {year, week} of the epi week containing `date` (UTC date parts are used). */
  function epiWeekOf(date) {
    const d = new Date(utc(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    let year = d.getUTCFullYear();
    if (d < week1Start(year)) year -= 1;
    else if (d >= week1Start(year + 1)) year += 1;
    const week = Math.floor((d - week1Start(year)) / (7 * DAY)) + 1;
    return { year, week };
  }

  function epiLabel(year, week) { return `${year}${pad(week)}`; }

  function currentEpiWeek(date) {
    const now = date || new Date();
    // Use local calendar date, expressed as UTC midnight, so the week matches the user's day.
    const local = new Date(utc(now.getFullYear(), now.getMonth(), now.getDate()));
    const { year, week } = epiWeekOf(local);
    return epiLabel(year, week);
  }

  function mmwrWeeksInYear(year) {
    return Math.round((week1Start(year + 1) - week1Start(year)) / (7 * DAY));
  }

  /**
   * Weeks in `year`: trust the existing labels when they show a 52 → next-year 01
   * transition, otherwise use the MMWR rule.  (A bare "YYYY53" label is NOT evidence:
   * NIDSS pre-generates the axis through week 53 every year.)
   */
  function weeksInYear(year, categories) {
    const set = new Set((categories || []).map(String));
    if (set.has(`${year}52`) && set.has(`${year + 1}01`) && !set.has(`${year}53`)) return 52;
    return mmwrWeeksInYear(year);
  }

  function nextEpiWeek(label, categories) {
    let year = Number(label.slice(0, 4));
    let week = Number(label.slice(4, 6));
    if (week < weeksInYear(year, categories)) week += 1;
    else { year += 1; week = 1; }
    return epiLabel(year, week);
  }

  const SIXDIGIT = /^\d{6}$/;
  const isEpiWeek = (s) => SIXDIGIT.test(s) && Number(s.slice(4)) >= 1 && Number(s.slice(4)) <= 53;
  const DAILY = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
  const MONTHLY = /^(\d{4})([-/.]?)(\d{2})$/;

  /**
   * Decides what a whole category axis denotes:  'epiweek' | 'month' | 'day' | 'year' | null.
   * "YYYYMM" and "YYYYWW" look alike, so six-digit labels are judged on the whole list:
   *   - any suffix above 12  → weeks
   *   - the axis title (hint) mentioning week/month decides otherwise
   *   - more than 12 labels that all stay within 01..12 can only be months
   *   - otherwise weeks (the more common NIDSS axis)
   */
  function detectLabelKind(categories, hint) {
    const labels = (categories || []).map(c => String(c).trim()).filter(Boolean);
    if (!labels.length) return null;
    const last = labels[labels.length - 1];
    if (DAILY.test(last)) return 'day';
    if (/^\d{4}$/.test(last)) return 'year';
    if (SIXDIGIT.test(last)) {
      const six = labels.filter(l => SIXDIGIT.test(l));
      const suffixes = six.map(l => Number(l.slice(4)));
      if (suffixes.some(w => w > 12)) return 'epiweek';
      const h = String(hint || '');
      if (/week|週|周/i.test(h)) return 'epiweek';
      if (/month|月/i.test(h)) return 'month';
      if (six.length > 12) return 'month';
      return 'epiweek';
    }
    const m = last.match(MONTHLY);
    if (m && m[2] && +m[3] >= 1 && +m[3] <= 12) return 'month';
    return null;
  }

  /**
   * Whether the period a label denotes is already complete.
   *   'past'    period ended before today
   *   'current' period contains today (data usually incomplete)
   *   'future'  period has not started
   *   null      label style not recognised
   * `kind` comes from detectLabelKind(); when omitted the label alone is judged.
   */
  function periodStatus(label, kind, today) {
    const s = String(label).trim();
    const now = today || new Date();
    const k = kind || detectLabelKind([s]);
    if (k === 'epiweek' && isEpiWeek(s)) {
      const cur = currentEpiWeek(now);
      return s < cur ? 'past' : s === cur ? 'current' : 'future';
    }
    if (k === 'day') {
      const m = s.match(DAILY);
      if (!m) return null;
      const t = new Date(utc(+m[1], +m[3] - 1, +m[4]));
      const d = new Date(utc(now.getFullYear(), now.getMonth(), now.getDate()));
      return t < d ? 'past' : t.getTime() === d.getTime() ? 'current' : 'future';
    }
    if (k === 'month') {
      const m = s.match(MONTHLY);
      if (!m || +m[3] < 1 || +m[3] > 12) return null;
      const v = +m[1] * 12 + (+m[3] - 1);
      const c = now.getFullYear() * 12 + now.getMonth();
      return v < c ? 'past' : v === c ? 'current' : 'future';
    }
    if (k === 'year' && /^\d{4}$/.test(s)) {
      const y = +s, c = now.getFullYear();
      return y < c ? 'past' : y === c ? 'current' : 'future';
    }
    return null;
  }

  function extendCategories(categories, count, kind) {
    const out = [];
    if (!categories || !categories.length) {
      for (let i = 1; i <= count; i++) out.push(`+${i}`);
      return out;
    }
    const last = String(categories[categories.length - 1]).trim();
    const prev = categories.length > 1 ? String(categories[categories.length - 2]).trim() : null;

    const k = kind || detectLabelKind(categories);
    if (k === 'month' && SIXDIGIT.test(last)) {
      let y = +last.slice(0, 4), mo = +last.slice(4);
      for (let i = 0; i < count; i++) {
        mo += 1; if (mo > 12) { mo = 1; y += 1; }
        out.push(`${y}${pad(mo)}`);
      }
      return out;
    }
    if (k === 'epiweek' && isEpiWeek(last)) {
      let cur = last;
      const all = categories.map(String);
      for (let i = 0; i < count; i++) { cur = nextEpiWeek(cur, all); out.push(cur); }
      return out;
    }

    let m = last.match(DAILY);
    if (m) {
      const sep = m[2];
      const d = new Date(utc(+m[1], +m[3] - 1, +m[4]));
      let stepDays = 1;
      const pm = prev && prev.match(DAILY);
      if (pm) {
        const diff = Math.round((d - new Date(utc(+pm[1], +pm[3] - 1, +pm[4]))) / DAY);
        if (diff > 0) stepDays = diff;
      }
      for (let i = 1; i <= count; i++) {
        const n = new Date(d.getTime() + i * stepDays * DAY);
        out.push(`${n.getUTCFullYear()}${sep}${pad(n.getUTCMonth() + 1)}${sep}${pad(n.getUTCDate())}`);
      }
      return out;
    }

    m = last.match(MONTHLY);
    if (m && +m[3] >= 1 && +m[3] <= 12) {
      let y = +m[1], mo = +m[3];
      for (let i = 0; i < count; i++) {
        mo += 1; if (mo > 12) { mo = 1; y += 1; }
        out.push(`${y}${m[2]}${pad(mo)}`);
      }
      return out;
    }

    if (/^\d{4}$/.test(last)) {
      for (let i = 1; i <= count; i++) out.push(String(+last + i));
      return out;
    }

    if (/^-?\d+(\.\d+)?$/.test(last)) {
      const step = prev && /^-?\d+(\.\d+)?$/.test(prev) ? Number(last) - Number(prev) : 1;
      for (let i = 1; i <= count; i++) out.push(String(Number(last) + i * (step || 1)));
      return out;
    }

    for (let i = 1; i <= count; i++) out.push(`+${i}`);
    return out;
  }

  window.__tfmAxis = { extendCategories, weeksInYear, nextEpiWeek, currentEpiWeek, epiWeekOf, periodStatus, detectLabelKind };
})();
