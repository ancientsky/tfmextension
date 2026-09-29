/**
 * MAIN-world bridge: receives requests from the isolated-world UI script via
 * window.postMessage and answers with data pulled from the page's chart library.
 *
 * Request : { source: 'tfm-ui',     id, type, ...args }
 * Response: { source: 'tfm-bridge', id, ok, result | error }
 */
(function () {
  'use strict';
  if (window.__tfmBridgeInstalled) return;
  window.__tfmBridgeInstalled = true;

  function activeAdapter() {
    const adapters = window.__tfmAdapters || {};
    for (const key of Object.keys(adapters)) {
      try { if (adapters[key].detect()) return adapters[key]; } catch (_) { /* ignore */ }
    }
    return null;
  }

  const handlers = {
    ping() {
      const a = activeAdapter();
      return { adapter: a ? a.name : null };
    },
    list() {
      const a = activeAdapter();
      return { adapter: a ? a.name : null, charts: a ? a.list() : [] };
    },
    extract({ index, ignoreLast }) {
      const a = activeAdapter();
      if (!a) throw new Error('no supported chart library on this page');
      return a.extract(index, { ignoreLast });
    },
    apply({ index, payload }) {
      const a = activeAdapter();
      if (!a) throw new Error('no supported chart library on this page');
      return a.apply(index, payload);
    },
    revert({ index }) {
      const a = activeAdapter();
      if (!a) throw new Error('no supported chart library on this page');
      return a.revert(index);
    },
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'tfm-ui') return;
    const { id, type } = ev.data;
    const reply = (msg) => window.postMessage({ source: 'tfm-bridge', id, ...msg }, '*');
    try {
      const fn = handlers[type];
      if (!fn) throw new Error(`unknown request type ${type}`);
      reply({ ok: true, result: fn(ev.data) });
    } catch (err) {
      reply({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
})();
