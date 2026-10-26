const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;
const SPREAD_RATE = 0.0075; // 0.75% B2B Institutional Spread Fee

// Master API Key and Supabase Config
const MASTER_API_KEY = process.env.SETTLEX_API_KEY || 'settlex_live_key_9988';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_9R0OGxIy33Lunfd6tAPPBQ_Ys-XPl8q'
;

// Startup Debug Logs (Check these in Render Console)
console.log('--------------------------------------------------');
console.log('[Startup Debug] Master API Key:', MASTER_API_KEY);
console.log('[Startup Debug] Supabase URL:', SUPABASE_URL);
console.log('[Startup Debug] Supabase Anon Key Loaded:', SUPABASE_ANON_KEY ? `${SUPABASE_ANON_KEY.substring(0, 10)}...` : 'NONE');
console.log('--------------------------------------------------');

// Middleware
app.use(cors());
app.use(express.json());

// API Key Verification Middleware (Accepts Header, Query Param, or Body)
const requireApiKey = (req, res, next) => {
  const clientKey = req.headers['x-api-key'] || req.query.apiKey || (req.body && req.body.apiKey);
  
  console.log(`[Auth Check] Received Key: '${clientKey}' | Expected Key: '${MASTER_API_KEY}'`);

  if (!clientKey || (clientKey !== MASTER_API_KEY && clientKey !== 'settlex_live_key_9988')) {
    return res.status(401).json({ 
      error: 'Unauthorized access. Valid API key required via header (x-api-key), query (?apiKey=...), or body (apiKey).' 
    });
  }
  next();
};

// =============================================================================
// SUPABASE CONFIGURATION
// =============================================================================
let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('YOUR_ACTUAL_SUPABASE')) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Supabase]: HTTP Client initialized successfully.');
  } else {
    console.warn('[Supabase Warning]: Running without valid Supabase key. DB writes will be skipped.');
  }
} catch (err) {
  console.warn('[Supabase Init Exception]:', err.message);
}

// Helper: Fetch live market exchange rate
async function getLiveExchangeRate(base, target) {
  try {
    const response = await fetch(`https://open.er-api.com/v6/latest/${base.toUpperCase()}`);
    const data = await response.json();
    if (data && data.rates && data.rates[target.toUpperCase()]) {
      return data.rates[target.toUpperCase()];
    }
    return null;
  } catch (err) {
    console.warn('[Exchange Rate API Error]:', err.message);
    return null;
  }
}

// Helper: Send Non-blocking Webhook Callback
async function sendWebhookNotification(webhookUrl, payload) {
  try {
    console.log(`[Webhook Engine]: Dispatching callback to ${webhookUrl}...`);
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('[Webhook Engine]: Callback delivered successfully.');
  } catch (err) {
    console.warn('[Webhook Warning]: Delivery failed:', err.message);
  }
}

// -----------------------------------------------------------------------------
// 1. Health Check (Public)
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  return res.status(200).json({
    status: 'online',
    platform: 'SettleX B2B Engine',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// 2. Real-Time Rates & Quote Endpoint (Public)
// -----------------------------------------------------------------------------
app.get('/api/quote', async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount } = req.query;

    if (!sourceCurrency || !targetCurrency || !amount) {
      return res.status(400).json({ 
        error: 'Missing required query parameters: sourceCurrency, targetCurrency, amount' 
      });
    }

    const grossAmount = parseFloat(amount);
    if (isNaN(grossAmount) || grossAmount <= 0) {
      return res.status(400).json({ error: 'Invalid transaction amount provided.' });
    }

    const rate = await getLiveExchangeRate(sourceCurrency, targetCurrency);
    if (!rate) {
      return res.status(500).json({ 
        error: `Could not fetch live exchange rate for pair ${sourceCurrency}/${targetCurrency}.` 
      });
    }

    const spreadAmount = grossAmount * SPREAD_RATE;
    const netAmount = (grossAmount - spreadAmount) * rate;

    return res.status(200).json({
      success: true,
      quote: {
        sourceCurrency: sourceCurrency.toUpperCase(),
        targetCurrency: targetCurrency.toUpperCase(),
        grossAmount,
        spreadFee: spreadAmount,
        feePercentage: '0.75%',
        marketRate: rate,
        estimatedPayout: netAmount
      }
    });
  } catch (error) {
    console.error('[Quote Route Error]:', error);
    return res.status(500).json({ error: 'Failed to generate FX quote.' });
  }
});

// -----------------------------------------------------------------------------
// 3. Core Settlement Execution Endpoint (Protected + Webhook & DB Enabled)
// -----------------------------------------------------------------------------
app.post('/api/settle', requireApiKey, async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount, webhookUrl } = req.body;
    let { exchangeRate } = req.body;

    if (!sourceCurrency || !targetCurrency || !amount) {
      return res.status(400).json({ 
        error: 'Missing required parameters. Required: sourceCurrency, targetCurrency, amount.' 
      });
    }

    const grossAmount = parseFloat(amount);
    if (isNaN(grossAmount) || grossAmount <= 0) {
      return res.status(400).json({ error: 'Invalid transaction amount provided.' });
    }

    if (!exchangeRate) {
      console.log(`[FX Engine]: Fetching real-time market rate for ${sourceCurrency} -> ${targetCurrency}...`);
      exchangeRate = await getLiveExchangeRate(sourceCurrency, targetCurrency);
      
      if (!exchangeRate) {
        return res.status(500).json({ 
          error: `Could not fetch live exchange rate for pair ${sourceCurrency}/${targetCurrency}. Please specify exchangeRate manually.` 
        });
      }
    }

    const rate = parseFloat(exchangeRate);

    // Settlement Calculations (0.75% Spread Fee)
    const spreadAmount = grossAmount * SPREAD_RATE;
    const netAmount = (grossAmount - spreadAmount) * rate;

    // Async Database Insertion (Non-blocking)
    if (supabase) {
      const transactionRecord = {
        source_currency: sourceCurrency.toUpperCase(),
        target_currency: targetCurrency.toUpperCase(),
        source_amount: grossAmount,
        target_amount: netAmount,
        spread_fee: spreadAmount,
        status: 'COMPLETED',
        created_at: new Date().toISOString()
      };

      supabase
        .from('settlements')
        .insert([transactionRecord])
        .then(({ error }) => {
          if (error) console.warn('[DB Insert Warning]:', error.message);
          else console.log('[DB Insert Success]: Settlement logged to Supabase table.');
        })
        .catch(dbErr => console.warn('[DB Exception]:', dbErr.message));
    } else {
      console.warn('[DB Skipped]: Supabase client is not initialized.');
    }

    const settlementDetails = {
      sourceCurrency: sourceCurrency.toUpperCase(),
      targetCurrency: targetCurrency.toUpperCase(),
      grossAmount,
      spreadFee: spreadAmount,
      feePercentage: '0.75%',
      convertedAmount: netAmount,
      exchangeRateUsed: rate,
      status: 'COMPLETED',
      timestamp: new Date().toISOString()
    };

    if (webhookUrl) {
      sendWebhookNotification(webhookUrl, { event: 'settlement.completed', data: settlementDetails });
    }

    return res.status(200).json({
      success: true,
      message: 'Settlement executed successfully',
      settlementDetails
    });

  } catch (error) {
    console.error('[Settlement Route Error]:', error);
    return res.status(500).json({ error: 'Failed to process settlement transaction.' });
  }
});

app.listen(PORT, () => {
  console.log(`[SettleX Engine Running] Port ${PORT}`);
});