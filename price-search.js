(function() {
  'use strict';

  const PRICE_SEARCH_API = '/.netlify/functions/price-search';
  const priceCache = new Map();
  const openPanels = new Set();
  const fixtureDataCache = new Map();
  let batchSearchActive = false;

  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtFull(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function getVerdictClass(v) {
    return { competitive:'competitive', savings_available:'savings', overpriced:'overpriced', no_data:'no-data' }[v] || 'no-data';
  }
  function getVerdictIcon(v) {
    return { competitive:'✓', savings_available:'⚠', overpriced:'↑', no_data:'?' }[v] || '?';
  }
  function getVerdictLabel(v, pct, saving) {
    if (v === 'competitive')       return 'Competitively priced — at or below market rate';
    if (v === 'savings_available') return 'Better price found — ' + pct + '% cheaper available' + (saving ? ' (save ' + fmt(saving) + ')' : '');
    if (v === 'overpriced')        return 'Significantly overpriced — ' + pct + '% above best found';
    return 'No pricing data found for this product';
  }

  async function loadFixtureData() {
    if (!window.sb) return;
    try {
      const { data } = await window.sb.from('fixtures').select('*');
      (data || []).forEach(f => fixtureDataCache.set(f.id, f));
    } catch(e) { console.warn('Price search: could not load fixture data', e); }
  }

  async function loadCachedPriceResults() {
    if (!window.sb) return;
    try {
      const { data } = await window.sb
        .from('fixtures')
        .select('id, price_data, price_verdict, price_flagged')
        .not('price_data', 'is', null);
      (data || []).forEach(row => {
        if (row.price_data) priceCache.set(row.id, row.price_data);
      });
    } catch(e) { console.warn('Price search: could not load cached results', e); }
  }

  async function savePriceDataToSupabase(id, priceData) {
    if (!window.sb) return;
    try {
      await window.sb.from('fixtures').update({
        price_data: priceData,
        price_searched_at: priceData.searchedAt || new Date().toISOString(),
        price_verdict: priceData.verdict,
        price_best: priceData.bestPrice,
        price_flagged: false,
      }).eq('id', id);
    } catch(e) { console.warn('Could not save price data:', e); }
  }

  async function saveFlagToSupabase(id, flagged) {
    if (!window.sb) return;
    try {
      await window.sb.from('fixtures').update({ price_flagged: flagged }).eq('id', id);
    } catch(e) { console.warn('Could not save flag:', e); }
  }

  async function searchFixturePrice(id) {
    const fixture  = fixtureDataCache.get(id);
    const brand    = fixture?.brand || '';
    const model    = fixture?.model || fixture?.product_name || '';
    const sku      = fixture?.sku || fixture?.product_code || '';
    const category = fixture?.category || fixture?.room || '';
    const unitPrice= fixture?.unit_price || null;
    const qty      = fixture?.qty || 1;

    if (!brand && !model) {
      showToast('Add a brand and model to this fixture first', 'warning');
      return;
    }

    setSearchButtonState(id, 'searching');

    try {
      const response = await fetch(PRICE_SEARCH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand, model, sku, category, unitPrice, qty }),
      });
      if (!response.ok) throw new Error('Search failed: ' + response.status);
      const priceData = await response.json();
      if (priceData.error && !priceData.results) throw new Error(priceData.error);

      priceCache.set(id, priceData);
      await savePriceDataToSupabase(id, priceData);
      setSearchButtonState(id, 'has-results', priceData);
      renderPricePanel(id, priceData, fixture);

    } catch(err) {
      console.error('Price search error:', err);
      setSearchButtonState(id, 'error');
      showPriceError(id, err.message);
    }
  }

  function setSearchButtonState(id, state, priceData) {
    const btn = document.getElementById('price-btn-' + id);
    if (!btn) return;
    btn.disabled = false;
    btn.className = 'btn-price-search';
    btn.style.borderColor = '';
    btn.style.color = '';

    if (state === 'searching') {
      btn.disabled = true;
      btn.classList.add('searching');
      btn.innerHTML = '<span class="price-search-spinner"></span> Searching\u2026';
    } else if (state === 'has-results') {
      const hasSavings = priceData && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
      btn.classList.add(hasSavings ? 'has-savings' : 'has-results');
      const saving = priceData?.potentialSaving || priceData?.savingPerUnit;
      btn.innerHTML = hasSavings ? '\u2691 Savings Found \u2014 ' + fmt(saving) : '\u2713 Priced OK \u2014 View';
      btn.onclick = (e) => { e.stopPropagation(); togglePricePanel(id); };
    } else if (state === 'error') {
      btn.style.borderColor = '#e05555';
      btn.style.color = '#e05555';
      btn.innerHTML = '\u26a0 Search Failed \u2014 Retry';
      btn.onclick = (e) => { e.stopPropagation(); searchFixturePrice(id); };
    } else {
      btn.innerHTML = '\uD83D\uDD0D Search Prices';
      btn.onclick = (e) => { e.stopPropagation(); searchFixturePrice(id); };
    }
  }

  function togglePricePanel(id) {
    const panel = document.getElementById('price-panel-' + id);
    if (!panel) return;
    const isHidden = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) openPanels.add(id); else openPanels.delete(id);
  }

  function renderPricePanel(id, priceData, fixture) {
    const row = document.querySelector('.fx-item[onclick*="' + id + '"]');
    if (!row) return;

    let panel = document.getElementById('price-panel-' + id);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'price-panel-' + id;
      panel.className = 'price-results-panel';
      row.after(panel);
    }

    const verdictClass = getVerdictClass(priceData.verdict);
    const verdictIcon  = getVerdictIcon(priceData.verdict);
    const pct     = Math.abs(priceData.priceDiffPct || 0);
    const saving  = priceData.potentialSaving || priceData.savingPerUnit;
    const qty     = fixture?.qty || 1;
    const unitPrice = fixture?.unit_price || fixture?.unitPrice;
    const hasSavings = saving && saving > 0 && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
    const searchedAt = priceData.searchedAt
      ? new Date(priceData.searchedAt).toLocaleString('en-AU', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
      : '';

    let tableRows = '';
    if (unitPrice) {
      tableRows += '<tr class="your-quote"><td><strong>Your Quote</strong> <span class="price-badge yours-badge">Current</span></td>' +
        '<td><span class="price-tag yours">' + fmtFull(unitPrice) + '</span></td>' +
        '<td>' + (qty > 1 ? '<span class="price-tag yours">' + fmt(unitPrice * qty) + '</span> <span class="price-note">(\xd7' + qty + ')</span>' : '\u2014') + '</td>' +
        '<td>\u2014</td><td><span class="price-note">Quoted price</span></td></tr>';
    }

    (priceData.results || []).forEach(function(r, i) {
      const isBest = i === 0 && r.price === priceData.bestPrice;
      const isHigh = unitPrice && r.price > unitPrice * 1.1;
      const tagClass = isBest ? 'best' : isHigh ? 'high' : 'mid';
      tableRows += '<tr class="' + (isBest ? 'best-price' : '') + '">' +
        '<td><strong>' + r.supplier + '</strong>' + (isBest ? ' <span class="price-badge best-badge">Best Found</span>' : '') + '</td>' +
        '<td><span class="price-tag ' + tagClass + '">' + fmtFull(r.price) + '</span>' + (r.priceType ? ' <span class="price-note">(' + r.priceType + ')</span>' : '') + '</td>' +
        '<td>' + (r.price && qty > 1 ? '<span class="price-tag ' + tagClass + '">' + fmt(r.price * qty) + '</span> <span class="price-note">(\xd7' + qty + ')</span>' : '\u2014') + '</td>' +
        '<td>' + (r.url ? '<a class="price-link" href="' + r.url + '" target="_blank" rel="noopener">View \u2192</a>' : '\u2014') + '</td>' +
        '<td><span class="price-note">' + (r.note || '') + '</span></td></tr>';
    });

    if (!tableRows) {
      tableRows = '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted);font-style:italic;">No Australian pricing found</td></tr>';
    }

    panel.innerHTML =
      '<div class="price-results-header">' +
        '<div class="price-results-title">\uD83D\uDD0D Price Lookup \u2014 <em>' + (priceData.searchTerm || '') + '</em></div>' +
        '<button class="price-results-close" onclick="document.getElementById(\'price-panel-' + id + '\').style.display=\'none\'">\xd7</button>' +
      '</div>' +
      '<div class="price-verdict ' + verdictClass + '">' +
        '<span class="price-verdict-icon">' + verdictIcon + '</span>' +
        '<span class="price-verdict-text">' + getVerdictLabel(priceData.verdict, pct, saving) + '</span>' +
        (hasSavings ? '<span class="price-verdict-saving">Save ' + fmt(saving) + ' on ' + qty + ' unit' + (qty > 1 ? 's' : '') + '</span>' : '') +
      '</div>' +
      (priceData.summary ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">' + priceData.summary + '</div>' : '') +
      (priceData.australianAvailability ? '<div style="font-size:10px;color:var(--text-dim,#4a4845);margin-bottom:8px;font-family:monospace;">AU Availability: ' + priceData.australianAvailability + '</div>' : '') +
      '<table class="price-table"><thead><tr><th>Supplier</th><th>Unit Price (AUD)</th><th>Total (\xd7' + qty + ')</th><th>Link</th><th>Note</th></tr></thead>' +
      '<tbody>' + tableRows + '</tbody></table>' +
      '<div class="price-actions">' +
        (hasSavings ?
          '<button class="btn-flag-renegotiate" id="flag-btn-' + id + '" onclick="window.priceSearch.toggleFlag(\'' + id + '\', this)">\u2691 Flag for Renegotiation</button>' +
          (priceData.bestPrice ? '<button class="btn-use-best-price" onclick="window.priceSearch.updatePrice(\'' + id + '\',' + priceData.bestPrice + ',\'' + (priceData.bestSupplier||'').replace(/'/g,"\\'") + '\')">\u2193 Update to Best Price</button>' : '')
        : '') +
        '<button style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:5px 10px;font-family:monospace;font-size:10px;border-radius:3px;cursor:pointer;" onclick="window.priceSearch.reSearch(\'' + id + '\')">\u21ba Re-search</button>' +
        (searchedAt ? '<span class="price-searched-at">Searched: ' + searchedAt + '</span>' : '') +
      '</div>';

    panel.style.display = 'block';
    openPanels.add(id);
  }

  function showPriceError(id, message) {
    const row = document.querySelector('.fx-item[onclick*="' + id + '"]');
    if (!row) return;
    let panel = document.getElementById('price-panel-' + id);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'price-panel-' + id;
      panel.className = 'price-results-panel';
      row.after(panel);
    }
    panel.innerHTML =
      '<div class="price-results-header">' +
        '<div class="price-results-title" style="color:#e05555">\u26a0 Search Failed</div>' +
        '<button class="price-results-close" onclick="this.closest(\'.price-results-panel\').style.display=\'none\'">\xd7</button>' +
      '</div>' +
      '<div style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">' + message + '</div>' +
      '<button class="btn-price-search" onclick="window.priceSearch.search(\'' + id + '\')">\u21ba Try Again</button>';
    panel.style.display = 'block';
  }

  async function toggleFlag(id, btn) {
    const flagged = !btn.classList.contains('flagged');
    btn.classList.toggle('flagged', flagged);
    btn.textContent = flagged ? '\u2713 Flagged for Renegotiation' : '\u2691 Flag for Renegotiation';
    await saveFlagToSupabase(id, flagged);
    showToast(flagged ? 'Flagged for renegotiation' : 'Flag removed', 'success');
  }

  async function updatePrice(id, bestPrice, bestSupplier) {
    if (!confirm('Update unit price to ' + fmtFull(bestPrice) + (bestSupplier ? ' from ' + bestSupplier : '') + '?')) return;
    if (!window.sb) return;
    try {
      const update = { unit_price: bestPrice };
      if (bestSupplier) update.supplier = bestSupplier;
      await window.sb.from('fixtures').update(update).eq('id', id);
      showToast('Price updated to ' + fmtFull(bestPrice), 'success');
      if (typeof renderFixtures === 'function') renderFixtures();
    } catch(e) { showToast('Could not update price: ' + e.message, 'error'); }
  }

  async function searchAllPrices() {
    if (batchSearchActive) return;
    const fixtures = [...fixtureDataCache.values()].filter(f => f.brand || f.model || f.product_name);
    if (!fixtures.length) { showToast('No fixtures with brand/model to search', 'warning'); return; }

    batchSearchActive = true;
    const btn = document.getElementById('btn-search-all-prices');
    if (btn) { btn.disabled = true; }

    let done = 0;
    for (const fixture of fixtures) {
      const brand = fixture.brand || '';
      const model = fixture.model || fixture.product_name || '';
      if (!brand && !model) { done++; continue; }
      try {
        if (btn) btn.innerHTML = '<span class="price-search-spinner"></span> ' + done + ' / ' + fixtures.length + '\u2026';
        const response = await fetch(PRICE_SEARCH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand, model, sku: fixture.sku||'', category: fixture.category||fixture.room||'', unitPrice: fixture.unit_price||null, qty: fixture.qty||1 }),
        });
        if (response.ok) {
          const priceData = await response.json();
          priceCache.set(fixture.id, priceData);
          await savePriceDataToSupabase(fixture.id, priceData);
          setSearchButtonState(fixture.id, 'has-results', priceData);
        }
      } catch(e) { console.warn('Batch error for', fixture.id, e); }
      done++;
      await new Promise(r => setTimeout(r, 1500));
    }

    batchSearchActive = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '\u26a1 Search All Prices'; }
    showToast('Searched ' + done + ' fixtures', 'success');
  }

  function injectSearchButtons() {
    document.querySelectorAll('.fx-item').forEach(function(row) {
      const onclickAttr = row.getAttribute('onclick') || '';
      const idMatch = onclickAttr.match(/openFixtureModal\(['"]([^'"]+)['"]\)/);
      if (!idMatch) return;
      const id = idMatch[1];
      if (document.getElementById('price-btn-' + id)) return;

      const fixture  = fixtureDataCache.get(id);
      const brand    = fixture?.brand || '';
      const model    = fixture?.model || fixture?.product_name || '';
      const hasModel = !!(brand || model);

      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'padding:4px 16px 10px;';

      const btn = document.createElement('button');
      btn.id = 'price-btn-' + id;
      btn.className = 'btn-price-search';
      btn.disabled = !hasModel;
      btn.title = hasModel ? 'Search AU prices for ' + [brand, model].filter(Boolean).join(' ') : 'Add brand/model to enable price search';
      btn.innerHTML = '\uD83D\uDD0D Search Prices';
      btn.onclick = function(e) { e.stopPropagation(); searchFixturePrice(id); };

      if (priceCache.has(id)) setSearchButtonState(id, 'has-results', priceCache.get(id));

      wrapper.appendChild(btn);
      row.appendChild(wrapper);

      if (openPanels.has(id) && priceCache.has(id)) {
        renderPricePanel(id, priceCache.get(id), fixture);
      }
    });
  }

  function injectSearchAllButton() {
    if (document.getElementById('btn-search-all-prices')) return;
    const headerBtns = document.querySelector('#tab-fixtures > div > div:last-child');
    if (!headerBtns) return;
    const btn = document.createElement('button');
    btn.id = 'btn-search-all-prices';
    btn.className = 'btn-search-all-prices';
    btn.innerHTML = '\u26a1 Search All Prices';
    btn.onclick = searchAllPrices;
    headerBtns.insertBefore(btn, headerBtns.firstChild);
  }

  function showToast(message, type) {
    type = type || 'success';
    if (typeof window._showToast === 'function') return window._showToast(message, type);
    const colors = { success:'#4caf7d', error:'#e05555', warning:'#e07f3a' };
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#1e2021;border:1px solid ' + (colors[type]||colors.success) + ';color:#e8e4de;padding:10px 16px;border-radius:4px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-family:monospace;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 3000);
  }

  var observer = new MutationObserver(function() {
    var tab = document.getElementById('tab-fixtures');
    if (!tab || tab.style.display === 'none') return;
    injectSearchButtons();
    injectSearchAllButton();
  });

  async function init() {
    var attempts = 0;
    while (!window.sb && attempts < 20) {
      await new Promise(function(r) { setTimeout(r, 500); });
      attempts++;
    }
    await loadFixtureData();
    await loadCachedPriceResults();
    injectSearchButtons();
    injectSearchAllButton();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.priceSearch = {
    search:      searchFixturePrice,
    searchAll:   searchAllPrices,
    toggleFlag:  toggleFlag,
    updatePrice: updatePrice,
    reSearch:    searchFixturePrice,
    inject:      injectSearchButtons,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
