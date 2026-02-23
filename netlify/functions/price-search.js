// netlify/functions/price-search.js
// Searches Australian retail prices for a fixture/fitting using Claude + web search

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { brand, model, sku, category, unitPrice, qty } = body;

  if (!brand && !model) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brand or model required' }) };
  }

  const searchTerm = [brand, model, sku].filter(Boolean).join(' ');
  const userQuoteTotal = unitPrice && qty ? (parseFloat(unitPrice) * parseInt(qty)) : null;

  const prompt = `You are a price research assistant for an Australian construction project. 
Search for the current Australian retail price for this product:

**Product:** ${searchTerm}
**Category:** ${category || 'building fixture/fitting'}
${unitPrice ? `**Current quoted price (excl GST):** $${unitPrice} AUD per unit` : ''}
${qty ? `**Quantity needed:** ${qty}` : ''}

Search Australian retail and trade suppliers for this exact product or close equivalent. 
Focus on: Reece Plumbing, Tradelink, Bunnings, Beaumont Tiles, Harvey Norman, Winning Appliances, 
Beacon Lighting, Plumbing Plus, Reece, Tradelink, Mitre 10, Meir, ABI Interiors, 
and any specialist Australian suppliers.

Return a JSON object with this EXACT structure (no markdown, just raw JSON):
{
  "searchTerm": "${searchTerm}",
  "results": [
    {
      "supplier": "Supplier Name",
      "price": 299.00,
      "priceType": "RRP" or "Trade" or "Sale",
      "url": "https://...",
      "note": "Brief note e.g. 'In stock', 'Trade account required', 'Discontinued'"
    }
  ],
  "bestPrice": 249.00,
  "bestSupplier": "Supplier Name",
  "priceRange": { "min": 199, "max": 399 },
  "verdict": "competitive" or "savings_available" or "overpriced" or "no_data",
  "savingPerUnit": 50.00,
  "savingTotal": ${userQuoteTotal ? `${userQuoteTotal}` : 'null'},
  "summary": "One sentence summary of findings",
  "searchedAt": "${new Date().toISOString()}",
  "australianAvailability": "Widely available" or "Limited" or "Import only" or "Unknown"
}

If the exact model isn't found, search for the closest equivalent and note it.
If no Australian pricing is found at all, set verdict to "no_data" and explain in summary.
Return ONLY the JSON object, no other text.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: `API error ${response.status}`, detail: errText }),
      };
    }

    const data = await response.json();

    // Extract text from response (may be after tool_use blocks)
    let resultText = '';
    for (const block of data.content || []) {
      if (block.type === 'text') {
        resultText += block.text;
      }
    }

    // Parse JSON from response
    let priceData;
    try {
      // Strip any markdown code fences if present
      const cleaned = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      // Find the JSON object
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        priceData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      console.error('Parse error:', parseErr, 'Raw text:', resultText);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          error: 'Could not parse price data',
          verdict: 'no_data',
          summary: 'Search completed but results could not be parsed. Try again.',
          searchTerm,
          results: [],
        }),
      };
    }

    // Add comparison data if we have a quoted price
    if (unitPrice && priceData.bestPrice) {
      const quoted = parseFloat(unitPrice);
      const best = parseFloat(priceData.bestPrice);
      const diff = quoted - best;
      const pct = Math.round((diff / quoted) * 100);
      priceData.quotedPrice = quoted;
      priceData.priceDiffPct = pct;
      priceData.priceDiffAbs = diff;
      if (qty) {
        priceData.potentialSaving = diff * parseInt(qty);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(priceData),
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
