(function() {
  'use strict';

  var PRICE_SEARCH_API = '/.netlify/functions/price-search';
  var priceCache = new Map();
  var openPanels = new Set();
  var fixtureDataCache = new Map();
  var batchSearchActive = false;

  function fmt(n) {
    if (n == null || isNaN(n)) return '--';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtFull(n) {
    if (n == null || isNaN(n)) return '--';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function getVerdictClass(v) {
    return { competitive:'competitive', savings_available:'savings', overpriced:'overpriced', no_data:'no-data' }[v] || 'no-data';
  }
  function getVerdictIcon(v) {
    return { competitive:'[OK]', savings_available:'[!]', overpriced:'[!!]', no_data:'[?]' }[v] || '[?]';
  }
  function getVerdictLabel(v, pct, saving) {
    if (v === 'competitive')       return 'Competitively priced -- at or below market rate';
    if (v === 'savings_available') return 'Better price found -- ' + pct + '% cheaper available' + (saving ? ' (save ' + fmt(saving) + ')' : '');
    if (v === 'overpriced')        return 'Significantly overpriced -- ' + pct + '% above best found';
    return 'No pricing data found for this product';
  }

  async function loadFixtureData() {
    if (!window.sbClient) return;
    try {
      var result = await window.sbClient.from('fixtures').select('*');
      var data = result.data || [];
      data.forEach(function(f) { fixtureDataCache.set(f.id, f); });
    } catch(e) { console.warn('Price search: could not load fixture data', e); }
  }

  async function loadCachedPriceResults() {
    if (!window.sbClient) return;
    try {
      var result = await window.sbClient
        .from('fixtures')
        .select('id, price_data, price_verdict, price_flagged')
        .not('price_data', 'is', null);
      var data = result.data || [];
      data.forEach(function(row) {
        if (row.price_data) priceCache.set(row.id, row.price_data);
      });
    } catch(e) { console.warn('Price search: could not load cached results', e); }
  }

  async function savePriceDataToSupabase(id, priceData) {
    if (!window.sbClient) return;
    try {
      await window.sbClient.from('fixtures').update({
        price_data: priceData,
        price_searched_at: priceData.searchedAt || new Date().toISOString(),
        price_verdict: priceData.verdict,
        price_best: priceData.bestPrice,
        price_flagged: false,
      }).eq('id', id);
    } catch(e) { console.warn('Could not save price data:', e); }
  }

  async function saveFlagToSupabase(id, flagged) {
    if (!window.sbClient) return;
    try {
      await window.sbClient.from('fixtures').update({ price_flagged: flagged }).eq('id', id);
    } catch(e) { console.warn('Could not save flag:', e); }
  }

  async function searchFixturePrice(id) {
    var fixture   = fixtureDataCache.get(id);
    var brand     = (fixture && fixture.brand) || '';
    var model     = (fixture && (fixture.model || fixture.product_name)) || '';
    var sku       = (fixture && (fixture.sku || fixture.product_code)) || '';
    var category  = (fixture && (fixture.category || fixture.room)) || '';
    var unitPrice = (fixture && fixture.unit_price) || null;
    var qty       = (fixture && fixture.qty) || 1;

    if (!brand && !model) {
      showToast('Add a brand and model to this fixture first', 'warning');
      return;
    }

    setSearchButtonState(id, 'searching');

    try {
      var response = await fetch(PRICE_SEARCH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: brand, model: model, sku: sku, category: category, unitPrice: unitPrice, qty: qty }),
      });
      if (!response.ok) throw new Error('Search failed: ' + response.status);
      var priceData = await response.json();
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
    var btn = document.getElementById('price-btn-' + id);
    if (!btn) return;
    btn.disabled = false;
    btn.className = 'btn-price-search';
    btn.style.borderColor = '';
    btn.style.color = '';

    if (state === 'searching') {
      btn.disabled = true;
      btn.classList.add('searching');
      btn.innerHTML = '<span class="price-search-spinner"></span> Searching...';
    } else if (state === 'has-results') {
      var hasSavings = priceData && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
      btn.classList.add(hasSavings ? 'has-savings' : 'has-results');
      var saving = priceData && (priceData.potentialSaving || priceData.savingPerUnit);
      btn.innerHTML = hasSavings ? 'flag Savings Found -- ' + fmt(saving) : 'OK Priced OK -- View';
      btn.onclick = (function(i) { return function(e) { e.stopPropagation(); togglePricePanel(i); }; })(id);
    } else if (state === 'error') {
      btn.style.borderColor = '#e05555';
      btn.style.color = '#e05555';
      btn.innerHTML = '! Search Failed -- Retry';
      btn.onclick = (function(i) { return function(e) { e.stopPropagation(); searchFixturePrice(i); }; })(id);
    } else {
      btn.innerHTML = 'Search Prices';
      btn.onclick = (function(i) { return function(e) { e.stopPropagation(); searchFixturePrice(i); }; })(id);
    }
  }

  function togglePricePanel(id) {
    var panel = document.getElementById('price-panel-' + id);
    if (!panel) return;
    var isHidden = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = isHidden ? 'block' : 'none';
    if (isHidden) openPanels.add(id); else openPanels.delete(id);
  }

  function renderPricePanel(id, priceData, fixture) {
    var row = document.querySelector('.fx-item[onclick*="' + id + '"]');
    if (!row) return;

    var panel = document.getElementById('price-panel-' + id);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'price-panel-' + id;
      panel.className = 'price-results-panel';
      row.after(panel);
    }

    var verdictClass = getVerdictClass(priceData.verdict);
    var verdictIcon  = getVerdictIcon(priceData.verdict);
    var pct          = Math.abs(priceData.priceDiffPct || 0);
    var saving       = priceData.potentialSaving || priceData.savingPerUnit;
    var qty          = (fixture && fixture.qty) || 1;
    var unitPrice    = fixture && (fixture.unit_price || fixture.unitPrice);
    var hasSavings   = saving && saving > 0 && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
    var searchedAt   = priceData.searchedAt
      ? new Date(priceData.searchedAt).toLocaleString('en-AU', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
      : '';

    var tableRows = '';
    if (unitPrice) {
      tableRows += '<tr class="your-quote">' +
        '<td><strong>Your Quote</strong> <span class="price-badge yours-badge">Current</span></td>' +
        '<td><span class="price-tag yours">' + fmtFull(unitPrice) + '</span></td>' +
        '<td>' + (qty > 1 ? '<span class="price-tag yours">' + fmt(unitPrice * qty) + '</span> <span class="price-note">(x' + qty + ')</span>' : '--') + '</td>' +
        '<td>--</td><td><span class="price-note">Quoted price</span></td></tr>';
    }

    var results = priceData.results || [];
    results.forEach(function(r, i) {
      var isBest   = i === 0 && r.price === priceData.bestPrice;
      var isHigh   = unitPrice && r.price > unitPrice * 1.1;
      var tagClass = isBest ? 'best' : isHigh ? 'high' : 'mid';
      tableRows += '<tr class="' + (isBest ? 'best-price' : '') + '">' +
        '<td><strong>' + r.supplier + '</strong>' + (isBest ? ' <span class="price-badge best-badge">Best Found</span>' : '') + '</td>' +
        '<td><span class="price-tag ' + tagClass + '">' + fmtFull(r.price) + '</span>' + (r.priceType ? ' <span class="price-note">(' + r.priceType + ')</span>' : '') + '</td>' +
        '<td>' + (r.price && qty > 1 ? '<span class="price-tag ' + tagClass + '">' + fmt(r.price * qty) + '</span> <span class="price-note">(x' + qty + ')</span>' : '--') + '</td>' +
        '<td>' + (r.url ? '<a class="price-link" href="' + r.url + '" target="_blank" rel="noopener">View -&gt;</a>' : '--') + '</td>' +
        '<td><span class="price-note">' + (r.note || '') + '</span></td></tr>';
    });

    if (!tableRows) {
      tableRows = '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted);font-style:italic;">No Australian pricing found</td></tr>';
    }

    var actionBtns = '';
    if (hasSavings) {
      actionBtns += '<button class="btn-flag-renegotiate" id="flag-btn-' + id + '" onclick="window.priceSearch.toggleFlag(\'' + id + '\', this)">Flag for Renegotiation</button>';
      if (priceData.bestPrice) {
        var sup = (priceData.bestSupplier || '').replace(/'/g, "\\'");
        actionBtns += '<button class="btn-use-best-price" onclick="window.priceSearch.updatePrice(\'' + id + '\',' + priceData.bestPrice + ',\'' + sup + '\')">Update to Best Price</button>';
      }
    }
    actionBtns += '<button style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:5px 10px;font-family:monospace;font-size:10px;border-radius:3px;cursor:pointer;" onclick="window.priceSearch.reSearch(\'' + id + '\')">Re-search</button>';
    if (searchedAt) actionBtns += '<span class="price-searched-at">Searched: ' + searchedAt + '</span>';

    panel.innerHTML =
      '<div class="price-results-header">' +
        '<div class="price-results-title">Price Lookup -- <em>' + (priceData.searchTerm || '') + '</em></div>' +
        '<button class="price-results-close" onclick="document.getElementById(\'price-panel-' + id + '\').style.display=\'none\'">X</button>' +
      '</div>' +
      '<div class="price-verdict ' + verdictClass + '">' +
        '<span class="price-verdict-icon">' + verdictIcon + '</span>' +
        '<span class="price-verdict-text">' + getVerdictLabel(priceData.verdict, pct, saving) + '</span>' +
        (hasSavings ? '<span class="price-verdict-saving">Save ' + fmt(saving) + ' on ' + qty + ' unit' + (qty > 1 ? 's' : '') + '</span>' : '') +
      '</div>' +
      (priceData.summary ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">' + priceData.summary + '</div>' : '') +
      (priceData.australianAvailability ? '<div style="font-size:10px;color:var(--text-dim,#4a4845);margin-bottom:8px;font-family:monospace;">AU Availability: ' + priceData.australianAvailability + '</div>' : '') +
      '<table class="price-table"><thead><tr><th>Supplier</th><th>Unit Price (AUD)</th><th>Total (x' + qty + ')</th><th>Link</th><th>Note</th></tr></thead>' +
      '<tbody>' + tableRows + '</tbody></table>' +
      '<div class="price-actions">' + actionBtns + '</div>';

    panel.style.display = 'block';
    openPanels.add(id);
  }

  function showPriceError(id, message) {
    var row = document.querySelector('.fx-item[onclick*="' + id + '"]');
    if (!row) return;
    var panel = document.getElementById('price-panel-' + id);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'price-panel-' + id;
      panel.className = 'price-results-panel';
      row.after(panel);
    }
    panel.innerHTML =
      '<div class="price-results-header">' +
        '<div class="price-results-title" style="color:#e05555">Search Failed</div>' +
        '<button class="price-results-close" onclick="this.closest(\'.price-results-panel\').style.display=\'none\'">X</button>' +
      '</div>' +
      '<div style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">' + message + '</div>' +
      '<button class="btn-price-search" onclick="window.priceSearch.search(\'' + id + '\')">Try Again</button>';
    panel.style.display = 'block';
  }

  async function toggleFlag(id, btn) {
    var flagged = !btn.classList.contains('flagged');
    btn.classList.toggle('flagged', flagged);
    btn.textContent = flagged ? 'Flagged for Renegotiation' : 'Flag for Renegotiation';
    await saveFlagToSupabase(id, flagged);
    showToast(flagged ? 'Flagged for renegotiation' : 'Flag removed', 'success');
  }

  async function updatePrice(id, bestPrice, bestSupplier) {
    if (!confirm('Update unit price to ' + fmtFull(bestPrice) + (bestSupplier ? ' from ' + bestSupplier : '') + '?')) return;
    if (!window.sbClient) return;
    try {
      var update = { unit_price: bestPrice };
      if (bestSupplier) update.supplier = bestSupplier;
      await window.sbClient.from('fixtures').update(update).eq('id', id);
      showToast('Price updated to ' + fmtFull(bestPrice), 'success');
      if (typeof renderFixtures === 'function') renderFixtures();
    } catch(e) { showToast('Could not update price: ' + e.message, 'error'); }
  }

  async function searchAllPrices() {
    if (batchSearchActive) return;
    var fixtures = [];
    fixtureDataCache.forEach(function(f) {
      if (f.brand || f.model || f.product_name) fixtures.push(f);
    });
    if (!fixtures.length) { showToast('No fixtures with brand/model to search', 'warning'); return; }

    batchSearchActive = true;
    var btn = document.getElementById('btn-search-all-prices');
    if (btn) btn.disabled = true;

    var done = 0;
    for (var i = 0; i < fixtures.length; i++) {
      var fixture = fixtures[i];
      var brand = fixture.brand || '';
      var model = fixture.model || fixture.product_name || '';
      if (!brand && !model) { done++; continue; }
      try {
        if (btn) btn.innerHTML = '<span class="price-search-spinner"></span> ' + done + ' / ' + fixtures.length + '...';
        var response = await fetch(PRICE_SEARCH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brand: brand, model: model, sku: fixture.sku || '', category: fixture.category || fixture.room || '', unitPrice: fixture.unit_price || null, qty: fixture.qty || 1 }),
        });
        if (response.ok) {
          var priceData = await response.json();
          priceCache.set(fixture.id, priceData);
          await savePriceDataToSupabase(fixture.id, priceData);
          setSearchButtonState(fixture.id, 'has-results', priceData);
        }
      } catch(e) { console.warn('Batch error for', fixture.id, e); }
      done++;
      await new Promise(function(r) { setTimeout(r, 1500); });
    }

    batchSearchActive = false;
    if (btn) { btn.disabled = false; btn.innerHTML = 'Search All Prices'; }
    showToast('Searched ' + done + ' fixtures', 'success');
  }

  function injectSearchButtons() {
    var rows = document.querySelectorAll('.fx-item');
    rows.forEach(function(row) {
      var onclickAttr = row.getAttribute('onclick') || '';
      var idMatch = onclickAttr.match(/openFixtureModal\(['"]([^'"]+)['"]\)/);
      if (!idMatch) return;
      var id = idMatch[1];
      if (document.getElementById('price-btn-' + id)) return;

      var fixture  = fixtureDataCache.get(id);
      var brand    = (fixture && fixture.brand) || '';
      var model    = (fixture && (fixture.model || fixture.product_name)) || '';
      var hasModel = !!(brand || model);

      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'padding:4px 16px 10px;';

      var btn = document.createElement('button');
      btn.id = 'price-btn-' + id;
      btn.className = 'btn-price-search';
      btn.disabled = !hasModel;
      btn.title = hasModel ? 'Search AU prices for ' + [brand, model].filter(Boolean).join(' ') : 'Add brand/model to enable price search';
      btn.innerHTML = 'Search Prices';
      btn.onclick = (function(i) { return function(e) { e.stopPropagation(); searchFixturePrice(i); }; })(id);

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
    var headerBtns = document.querySelector('#tab-fixtures > div > div:last-child');
    if (!headerBtns) return;
    var btn = document.createElement('button');
    btn.id = 'btn-search-all-prices';
    btn.className = 'btn-search-all-prices';
    btn.innerHTML = 'Search All Prices';
    btn.onclick = searchAllPrices;
    headerBtns.insertBefore(btn, headerBtns.firstChild);
  }

  function showToast(message, type) {
    type = type || 'success';
    var colors = { success:'#4caf7d', error:'#e05555', warning:'#e07f3a' };
    var toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:#1e2021;border:1px solid ' + (colors[type] || colors.success) + ';color:#e8e4de;padding:10px 16px;border-radius:4px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.4);font-family:monospace;';
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
    while (!window.sbClient && attempts < 20) {
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
