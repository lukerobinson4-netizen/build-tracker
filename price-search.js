/* ═══════════════════════════════════════════════════════════════════
   FIXTURES PRICE SEARCH — JavaScript Module
   
   HOW TO INTEGRATE:
   1. Copy price-search.css content into your <style> tag
   2. Paste this entire script block just before </body> in index.html
   3. Add "⚡ Search All Prices" button to fixtures tab header (see Step 3 below)
   4. Deploy netlify/functions/price-search.js to your Netlify repo
   5. Set ANTHROPIC_API_KEY environment variable in Netlify dashboard
   
   This script hooks into the existing renderFixtures() function by
   patching fixture row HTML with search buttons, and storing 
   price lookup results in Supabase alongside fixture records.
   ═══════════════════════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────
  const PRICE_SEARCH_API = '/.netlify/functions/price-search';
  
  // In-memory cache for this session (also persisted to Supabase via price_data field)
  const priceCache = new Map();

  // Track which panels are open
  const openPanels = new Set();

  // Batch search state
  let batchSearchActive = false;

  // ─── UTILITY ──────────────────────────────────────────────────────
  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function fmtFull(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function getVerdictClass(verdict) {
    const map = {
      competitive: 'competitive',
      savings_available: 'savings',
      overpriced: 'overpriced',
      no_data: 'no-data',
    };
    return map[verdict] || 'no-data';
  }

  function getVerdictIcon(verdict) {
    const map = {
      competitive: '✓',
      savings_available: '⚠',
      overpriced: '↑',
      no_data: '?',
    };
    return map[verdict] || '?';
  }

  function getVerdictLabel(verdict, pct, saving) {
    if (verdict === 'competitive') return `Competitively priced — at or below market rate`;
    if (verdict === 'savings_available') return `Better price found — ${pct}% cheaper available${saving ? ` (save ${fmt(saving)})` : ''}`;
    if (verdict === 'overpriced') return `Significantly overpriced — ${pct}% above best found`;
    return 'No pricing data found for this product';
  }

  // ─── SEARCH FUNCTION ─────────────────────────────────────────────
  async function searchFixturePrice(fixtureId) {
    // Get fixture data from the DOM or Supabase
    const fixture = await getFixtureById(fixtureId);
    if (!fixture) {
      showToast('Fixture not found', 'error');
      return;
    }

    const brand = fixture.brand || fixture.make || '';
    const model = fixture.model || fixture.product_name || '';
    const sku   = fixture.sku || fixture.product_code || '';

    if (!brand && !model) {
      showToast('Add a brand/make and model before searching prices', 'warning');
      return;
    }

    // Update button state
    setSearchButtonState(fixtureId, 'searching');

    try {
      const response = await fetch(PRICE_SEARCH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand,
          model,
          sku,
          category: fixture.category || fixture.room || '',
          unitPrice: fixture.unit_price || fixture.unitPrice || null,
          qty: fixture.qty || fixture.quantity || 1,
        }),
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }

      const priceData = await response.json();

      if (priceData.error && !priceData.results) {
        throw new Error(priceData.error);
      }

      // Cache in memory
      priceCache.set(fixtureId, priceData);

      // Persist to Supabase if available
      await savePriceDataToSupabase(fixtureId, priceData);

      // Render results panel
      renderPricePanel(fixtureId, priceData, fixture);
      setSearchButtonState(fixtureId, 'has-results', priceData);

    } catch (err) {
      console.error('Price search error:', err);
      setSearchButtonState(fixtureId, 'error');
      showPriceError(fixtureId, err.message);
    }
  }

  // ─── GET FIXTURE DATA ─────────────────────────────────────────────
  async function getFixtureById(id) {
    // Try Supabase first
    if (window.supabaseClient) {
      try {
        const { data, error } = await window.supabaseClient
          .from('fixtures')
          .select('*')
          .eq('id', id)
          .single();
        if (!error && data) return data;
      } catch (e) {
        console.warn('Supabase fetch failed, using DOM fallback');
      }
    }

    // Fallback: parse from DOM row data attributes
    const row = document.querySelector(`[data-fixture-id="${id}"]`);
    if (row) {
      return {
        id,
        brand: row.dataset.brand || '',
        model: row.dataset.model || '',
        sku: row.dataset.sku || '',
        category: row.dataset.category || '',
        room: row.dataset.room || '',
        unit_price: parseFloat(row.dataset.unitPrice) || null,
        qty: parseInt(row.dataset.qty) || 1,
      };
    }
    return null;
  }

  // ─── SAVE PRICE DATA TO SUPABASE ─────────────────────────────────
  async function savePriceDataToSupabase(fixtureId, priceData) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient
        .from('fixtures')
        .update({
          price_data: priceData,
          price_searched_at: priceData.searchedAt || new Date().toISOString(),
          price_verdict: priceData.verdict,
          price_best: priceData.bestPrice,
          price_flagged: false, // reset flag on new search
        })
        .eq('id', fixtureId);
    } catch (e) {
      console.warn('Could not save price data to Supabase:', e);
    }
  }

  // ─── SAVE FLAG TO SUPABASE ────────────────────────────────────────
  async function saveFlagToSupabase(fixtureId, flagged) {
    if (!window.supabaseClient) return;
    try {
      await window.supabaseClient
        .from('fixtures')
        .update({ price_flagged: flagged })
        .eq('id', fixtureId);
    } catch (e) {
      console.warn('Could not save flag:', e);
    }
  }

  // ─── SET BUTTON STATE ─────────────────────────────────────────────
  function setSearchButtonState(id, state, priceData) {
    const btn = document.getElementById(`price-btn-${id}`);
    if (!btn) return;

    btn.disabled = false;
    btn.className = 'btn-price-search';

    if (state === 'searching') {
      btn.disabled = true;
      btn.classList.add('searching');
      btn.innerHTML = `<span class="price-search-spinner"></span> Searching…`;
    } else if (state === 'has-results') {
      const hasSavings = priceData && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
      btn.classList.add(hasSavings ? 'has-savings' : 'has-results');
      btn.innerHTML = hasSavings
        ? `⚑ Savings Found — ${fmt(priceData.potentialSaving || priceData.savingPerUnit)}`
        : `✓ Priced OK — View`;
      btn.onclick = () => togglePricePanel(id);
    } else if (state === 'error') {
      btn.style.borderColor = 'var(--red)';
      btn.style.color = 'var(--red)';
      btn.innerHTML = `⚠ Search Failed — Retry`;
      btn.onclick = () => searchFixturePrice(id);
    } else {
      // Default/reset
      btn.innerHTML = `🔍 Search Prices`;
      btn.onclick = () => searchFixturePrice(id);
    }
  }

  // ─── TOGGLE PANEL ─────────────────────────────────────────────────
  function togglePricePanel(id) {
    const panel = document.getElementById(`price-panel-${id}`);
    if (!panel) return;

    if (panel.style.display === 'none' || !panel.style.display) {
      panel.style.display = 'block';
      openPanels.add(id);
    } else {
      panel.style.display = 'none';
      openPanels.delete(id);
    }
  }

  // ─── RENDER PRICE PANEL ───────────────────────────────────────────
  function renderPricePanel(fixtureId, priceData, fixture) {
    const panelId = `price-panel-${fixtureId}`;
    let panel = document.getElementById(panelId);

    if (!panel) {
      // Create panel after the fixture row
      const row = document.querySelector(`[data-fixture-id="${fixtureId}"]`);
      if (!row) return;

      panel = document.createElement('div');
      panel.id = panelId;
      panel.className = 'price-results-panel';
      row.after(panel);
    }

    const verdictClass = getVerdictClass(priceData.verdict);
    const verdictIcon  = getVerdictIcon(priceData.verdict);
    const pct = priceData.priceDiffPct || 0;
    const saving = priceData.potentialSaving || priceData.savingPerUnit;
    const verdictLabel = getVerdictLabel(priceData.verdict, Math.abs(pct), saving);
    const qty = fixture?.qty || fixture?.quantity || 1;

    // Build results table rows
    let tableRows = '';

    // Your quote row (first)
    if (fixture?.unit_price || fixture?.unitPrice) {
      const qp = fixture.unit_price || fixture.unitPrice;
      tableRows += `
        <tr class="your-quote">
          <td>
            <strong>Your Quote</strong>
            <span class="price-badge yours-badge">Current</span>
          </td>
          <td><span class="price-tag yours">${fmtFull(qp)}</span></td>
          <td>${qty > 1 ? `<span class="price-tag yours">${fmt(qp * qty)}</span> <span class="price-note">(×${qty})</span>` : '—'}</td>
          <td>—</td>
          <td><span class="price-note">Builder/supplier quote</span></td>
        </tr>`;
    }

    // Market results
    const results = priceData.results || [];
    results.forEach((r, i) => {
      const isBest = i === 0 && r.price === priceData.bestPrice;
      const isHigh = fixture?.unit_price && r.price > (fixture.unit_price || fixture.unitPrice) * 1.1;
      const tagClass = isBest ? 'best' : isHigh ? 'high' : 'mid';
      const totalPrice = r.price && qty > 1 ? r.price * qty : null;

      tableRows += `
        <tr class="${isBest ? 'best-price' : ''}">
          <td>
            <strong>${r.supplier}</strong>
            ${isBest ? '<span class="price-badge best-badge">Best Found</span>' : ''}
          </td>
          <td><span class="price-tag ${tagClass}">${fmtFull(r.price)}</span>
            ${r.priceType ? `<span class="price-note"> (${r.priceType})</span>` : ''}
          </td>
          <td>${totalPrice ? `<span class="price-tag ${tagClass}">${fmt(totalPrice)}</span> <span class="price-note">(×${qty})</span>` : '—'}</td>
          <td>${r.url ? `<a class="price-link" href="${r.url}" target="_blank" rel="noopener">View →</a>` : '—'}</td>
          <td><span class="price-note">${r.note || ''}</span></td>
        </tr>`;
    });

    if (!tableRows && priceData.verdict === 'no_data') {
      tableRows = `<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted);font-style:italic;">No Australian pricing found for this product</td></tr>`;
    }

    const hasSavings = saving && saving > 0 && (priceData.verdict === 'savings_available' || priceData.verdict === 'overpriced');
    const searchedAt = priceData.searchedAt ? new Date(priceData.searchedAt).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

    panel.innerHTML = `
      <div class="price-results-header">
        <div class="price-results-title">🔍 Price Lookup — <em>${priceData.searchTerm || ''}</em></div>
        <button class="price-results-close" onclick="document.getElementById('${panelId}').style.display='none'">×</button>
      </div>

      <div class="price-verdict ${verdictClass}">
        <span class="price-verdict-icon">${verdictIcon}</span>
        <span class="price-verdict-text">${verdictLabel}</span>
        ${hasSavings ? `<span class="price-verdict-saving">Save ${fmt(saving)} on ${qty} unit${qty > 1 ? 's' : ''}</span>` : ''}
      </div>

      ${priceData.summary ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;">${priceData.summary}</div>` : ''}
      ${priceData.australianAvailability ? `<div style="font-size:10px;color:var(--text-dim);margin-bottom:8px;font-family:var(--mono);">AU Availability: ${priceData.australianAvailability}</div>` : ''}

      <table class="price-table">
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Unit Price (AUD)</th>
            <th>Total (×${qty})</th>
            <th>Link</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div class="price-actions">
        ${hasSavings ? `
          <button class="btn-flag-renegotiate" id="flag-btn-${fixtureId}" 
            onclick="window.priceSearch.toggleFlag('${fixtureId}', this)">
            ⚑ Flag for Renegotiation
          </button>
          ${priceData.bestPrice ? `
            <button class="btn-use-best-price"
              onclick="window.priceSearch.updatePrice('${fixtureId}', ${priceData.bestPrice}, '${priceData.bestSupplier || ''}')">
              ↓ Update to Best Price
            </button>
          ` : ''}
        ` : ''}
        <button style="background:none;border:1px solid var(--border);color:var(--text-muted);padding:5px 10px;font-family:var(--mono);font-size:10px;border-radius:3px;cursor:pointer;"
          onclick="window.priceSearch.reSearch('${fixtureId}')">
          ↺ Re-search
        </button>
        ${searchedAt ? `<span class="price-searched-at">Searched: ${searchedAt}</span>` : ''}
      </div>
    `;

    panel.style.display = 'block';
    openPanels.add(fixtureId);
  }

  // ─── SHOW ERROR ───────────────────────────────────────────────────
  function showPriceError(fixtureId, message) {
    const panelId = `price-panel-${fixtureId}`;
    let panel = document.getElementById(panelId);
    if (!panel) {
      const row = document.querySelector(`[data-fixture-id="${fixtureId}"]`);
      if (!row) return;
      panel = document.createElement('div');
      panel.id = panelId;
      panel.className = 'price-results-panel';
      row.after(panel);
    }
    panel.innerHTML = `
      <div class="price-results-header">
        <div class="price-results-title" style="color:var(--red)">⚠ Search Failed</div>
        <button class="price-results-close" onclick="this.closest('.price-results-panel').style.display='none'">×</button>
      </div>
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">${message}</div>
      <button class="btn-price-search" onclick="window.priceSearch.search('${fixtureId}')">↺ Try Again</button>
    `;
    panel.style.display = 'block';
  }

  // ─── TOGGLE FLAG ──────────────────────────────────────────────────
  async function toggleFlag(fixtureId, btn) {
    const isFlagged = btn.classList.contains('flagged');
    const newFlagged = !isFlagged;

    btn.classList.toggle('flagged', newFlagged);
    btn.textContent = newFlagged ? '✓ Flagged for Renegotiation' : '⚑ Flag for Renegotiation';

    await saveFlagToSupabase(fixtureId, newFlagged);

    // Update the row badge
    const row = document.querySelector(`[data-fixture-id="${fixtureId}"]`);
    if (row) {
      const badge = row.querySelector('.fixture-flagged-badge');
      if (newFlagged && !badge) {
        const nameCell = row.querySelector('td:first-child');
        if (nameCell) nameCell.insertAdjacentHTML('beforeend', `<span class="fixture-flagged-badge">⚑ Renegotiate</span>`);
      } else if (!newFlagged && badge) {
        badge.remove();
      }
    }

    updateSavingsSummary();
    showToast(newFlagged ? 'Flagged for renegotiation' : 'Flag removed', 'success');
  }

  // ─── UPDATE PRICE ─────────────────────────────────────────────────
  async function updatePrice(fixtureId, bestPrice, bestSupplier) {
    if (!confirm(`Update unit price to ${fmtFull(bestPrice)} (from ${bestSupplier || 'best found price'})?`)) return;

    if (window.supabaseClient) {
      try {
        await window.supabaseClient
          .from('fixtures')
          .update({
            unit_price: bestPrice,
            supplier: bestSupplier || undefined,
          })
          .eq('id', fixtureId);

        showToast(`Price updated to ${fmtFull(bestPrice)}`, 'success');

        // Refresh the fixtures view if the function exists
        if (typeof window.renderFixtures === 'function') {
          window.renderFixtures();
        } else if (typeof window.loadFixtures === 'function') {
          window.loadFixtures();
        }
      } catch (e) {
        showToast('Could not update price: ' + e.message, 'error');
      }
    }
  }

  // ─── BATCH SEARCH ALL ─────────────────────────────────────────────
  async function searchAllPrices() {
    if (batchSearchActive) return;

    // Get all fixtures with brand/model set
    let fixtures = [];
    if (window.supabaseClient) {
      try {
        const { data } = await window.supabaseClient
          .from('fixtures')
          .select('*')
          .or('brand.neq.,model.neq.,product_name.neq.');
        fixtures = (data || []).filter(f => f.brand || f.model || f.product_name);
      } catch (e) {
        showToast('Could not load fixtures', 'error');
        return;
      }
    }

    if (!fixtures.length) {
      showToast('No fixtures with brand/model to search', 'warning');
      return;
    }

    const btn = document.getElementById('btn-search-all-prices');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="price-search-spinner"></span> Searching 0 / ${fixtures.length}…`;
    }

    // Show progress bar
    showProgressBar(fixtures.length);

    batchSearchActive = true;
    let done = 0;
    const errors = [];

    for (const fixture of fixtures) {
      try {
        const brand = fixture.brand || '';
        const model = fixture.model || fixture.product_name || '';
        if (!brand && !model) { done++; continue; }

        const response = await fetch(PRICE_SEARCH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brand,
            model,
            sku: fixture.sku || fixture.product_code || '',
            category: fixture.category || fixture.room || '',
            unitPrice: fixture.unit_price || null,
            qty: fixture.qty || 1,
          }),
        });

        if (response.ok) {
          const priceData = await response.json();
          priceCache.set(fixture.id, priceData);
          await savePriceDataToSupabase(fixture.id, priceData);
          setSearchButtonState(fixture.id, 'has-results', priceData);
        } else {
          errors.push(fixture.id);
        }
      } catch (e) {
        errors.push(fixture.id);
      }

      done++;
      updateProgressBar(done, fixtures.length);

      if (btn) {
        btn.innerHTML = `<span class="price-search-spinner"></span> Searching ${done} / ${fixtures.length}…`;
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 1500));
    }

    batchSearchActive = false;
    hideProgressBar();

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `⚡ Search All Prices`;
    }

    updateSavingsSummary();

    const msg = errors.length
      ? `Searched ${done - errors.length}/${fixtures.length} — ${errors.length} failed`
      : `All ${fixtures.length} items searched`;
    showToast(msg, errors.length ? 'warning' : 'success');
  }

  // ─── PROGRESS BAR ─────────────────────────────────────────────────
  function showProgressBar(total) {
    let bar = document.getElementById('price-search-progress');
    if (!bar) {
      const container = document.querySelector('#tab-fixtures .section') || document.querySelector('#fixtures-container');
      if (!container) return;
      bar = document.createElement('div');
      bar.id = 'price-search-progress';
      bar.className = 'search-progress-bar';
      bar.innerHTML = '<div class="search-progress-fill" style="width:0%"></div>';
      container.prepend(bar);
    }
    bar.style.display = 'block';
  }

  function updateProgressBar(done, total) {
    const fill = document.querySelector('#price-search-progress .search-progress-fill');
    if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
  }

  function hideProgressBar() {
    const bar = document.getElementById('price-search-progress');
    if (bar) bar.style.display = 'none';
  }

  // ─── SAVINGS SUMMARY ──────────────────────────────────────────────
  function updateSavingsSummary() {
    // Calculate total potential savings across all cached results
    let totalSavings = 0;
    let itemsWithSavings = 0;
    let itemsSearched = 0;

    priceCache.forEach((data) => {
      itemsSearched++;
      if (data.potentialSaving && data.potentialSaving > 0) {
        totalSavings += data.potentialSaving;
        itemsWithSavings++;
      }
    });

    if (!itemsSearched) return;

    let summary = document.getElementById('price-savings-summary');
    const container = document.querySelector('#tab-fixtures > .main') ||
                      document.querySelector('.fixtures-header') ||
                      document.getElementById('fixtures-list');

    if (!summary && container) {
      summary = document.createElement('div');
      summary.id = 'price-savings-summary';
      summary.className = 'price-savings-summary';
      container.prepend(summary);
    }

    if (summary) {
      summary.innerHTML = `
        <div class="sum-item">
          <span class="sum-label">Items Searched</span>
          <span class="sum-value" style="color:var(--blue)">${itemsSearched}</span>
        </div>
        <div class="sum-item">
          <span class="sum-label">Savings Available</span>
          <span class="sum-value">${fmt(totalSavings)}</span>
        </div>
        <div class="sum-item">
          <span class="sum-label">Items to Renegotiate</span>
          <span class="sum-value">${itemsWithSavings}</span>
        </div>
        <div style="margin-left:auto;font-size:11px;color:var(--text-muted);">
          Based on best Australian retail prices found
        </div>
      `;
    }
  }

  // ─── INJECT SEARCH BUTTONS INTO FIXTURE ROWS ─────────────────────
  // This patches into the existing renderFixtures output.
  // Call this after renderFixtures() runs.
  function injectSearchButtons() {
    // Find all fixture rows (adapt selector to match your actual HTML)
    const rows = document.querySelectorAll('.fixture-row, [data-fixture-id]');

    rows.forEach(row => {
      const id = row.dataset.fixtureId || row.getAttribute('data-id');
      if (!id) return;

      // Skip if button already added
      if (document.getElementById(`price-btn-${id}`)) return;

      const brand = row.dataset.brand || '';
      const model = row.dataset.model || row.dataset.productName || '';
      const hasModel = !!(brand || model);

      // Create button
      const btnCell = document.createElement('td');
      const btn = document.createElement('button');
      btn.id = `price-btn-${id}`;
      btn.className = 'btn-price-search';
      btn.disabled = !hasModel;
      btn.title = hasModel ? `Search Australian prices for ${[brand, model].filter(Boolean).join(' ')}` : 'Add brand/model to enable price search';
      btn.innerHTML = '🔍 Search Prices';
      btn.onclick = () => searchFixturePrice(id);

      // Restore cached result button state if available
      if (priceCache.has(id)) {
        setSearchButtonState(id, 'has-results', priceCache.get(id));
      }

      btnCell.appendChild(btn);
      row.appendChild(btnCell);

      // Restore open panels
      if (openPanels.has(id) && priceCache.has(id)) {
        const fixture = { unit_price: parseFloat(row.dataset.unitPrice), qty: parseInt(row.dataset.qty) || 1 };
        renderPricePanel(id, priceCache.get(id), fixture);
      }
    });
  }

  // ─── INJECT "SEARCH ALL" BUTTON INTO FIXTURES HEADER ─────────────
  function injectSearchAllButton() {
    // Find the fixtures tab header buttons area
    const headerArea = document.querySelector(
      '#tab-fixtures .section-header > div, ' +
      '.fixtures-header-actions, ' +
      '[data-fixtures-header]'
    );
    if (!headerArea || document.getElementById('btn-search-all-prices')) return;

    const btn = document.createElement('button');
    btn.id = 'btn-search-all-prices';
    btn.className = 'btn-search-all-prices';
    btn.innerHTML = '⚡ Search All Prices';
    btn.onclick = searchAllPrices;
    headerArea.insertBefore(btn, headerArea.firstChild);
  }

  // ─── LOAD CACHED RESULTS FROM SUPABASE ON STARTUP ────────────────
  async function loadCachedPriceResults() {
    if (!window.supabaseClient) return;
    try {
      const { data } = await window.supabaseClient
        .from('fixtures')
        .select('id, price_data, price_verdict, price_flagged')
        .not('price_data', 'is', null);

      (data || []).forEach(row => {
        if (row.price_data) {
          priceCache.set(row.id, row.price_data);
        }
      });
    } catch (e) {
      console.warn('Could not load cached price results:', e);
    }
  }

  // ─── TOAST NOTIFICATION ───────────────────────────────────────────
  function showToast(message, type = 'success') {
    // Use existing toast if available
    if (typeof window.showToast === 'function' && window.showToast !== showToast) {
      return window.showToast(message, type);
    }

    const toast = document.createElement('div');
    const colors = { success: '#4caf7d', error: '#e05555', warning: '#e07f3a' };
    toast.style.cssText = `
      position:fixed;bottom:20px;right:20px;z-index:9999;
      background:#1e2021;border:1px solid ${colors[type] || colors.success};
      color:#e8e4de;padding:10px 16px;border-radius:4px;font-size:13px;
      box-shadow:0 4px 12px rgba(0,0,0,0.4);font-family:var(--mono);
      animation:slideDown 0.2s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── OBSERVE DOM CHANGES (re-inject after re-renders) ────────────
  const observer = new MutationObserver((mutations) => {
    const fixturesVisible = document.querySelector('#tab-fixtures, .fixtures-section');
    if (!fixturesVisible) return;

    let shouldInject = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        shouldInject = true;
        break;
      }
    }
    if (shouldInject) {
      setTimeout(() => {
        injectSearchButtons();
        injectSearchAllButton();
      }, 100);
    }
  });

  // ─── INIT ─────────────────────────────────────────────────────────
  async function init() {
    // Load cached results from Supabase
    await loadCachedPriceResults();

    // Initial injection attempt
    injectSearchButtons();
    injectSearchAllButton();

    // Watch for DOM changes (when fixtures tab is activated / re-rendered)
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────
  window.priceSearch = {
    search:       searchFixturePrice,
    searchAll:    searchAllPrices,
    toggleFlag:   toggleFlag,
    updatePrice:  updatePrice,
    reSearch:     (id) => searchFixturePrice(id),
    inject:       injectSearchButtons,
  };

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
