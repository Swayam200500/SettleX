const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;
const SPREAD_RATE = 0.0075; // 0.75% B2B Institutional Spread Fee

// Middleware
app.use(cors());
app.use(express.json());

// =============================================================================
// SUPABASE CONFIGURATION
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_9R0OGxIy33Lunfd6tAPPBQ_Ys-XPl8q';

let supabase = null;
try {
  if (SUPABASE_URL && !SUPABASE_URL.includes('YOUR_SUPABASE_PROJECT_REF')) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Supabase]: HTTP Client initialized successfully.');
  } else {
    console.warn('[Supabase Warning]: Running with placeholder credentials. DB writes will be skipped.');
  }
} catch (err) {
  console.warn('[Supabase Init Exception]:', err.message);
}

// Helper: Fetch live market exchange rate if not provided by client
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

// -----------------------------------------------------------------------------
// 1. Health Check Endpoint
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  return res.status(200).json({
    status: 'online',
    platform: 'SettleX B2B Engine',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// 2. Core Settlement Execution Endpoint
// -----------------------------------------------------------------------------
app.post('/api/settle', async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount } = req.body;
    let { exchangeRate } = req.body;

    // Payload validation
    if (!sourceCurrency || !targetCurrency || !amount) {
      return res.status(400).json({ 
        error: 'Missing required parameters. Required: sourceCurrency, targetCurrency, amount.' 
      });
    }

    const grossAmount = parseFloat(amount);
    if (isNaN(grossAmount) || grossAmount <= 0) {
      return res.status(400).json({ error: 'Invalid transaction amount provided.' });
    }

    // Auto-fetch live market rate if exchangeRate was omitted
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
    }

    // High-Availability Immediate Response
    return res.status(200).json({
      success: true,
      message: 'Settlement executed successfully',
      settlementDetails: {
        sourceCurrency: sourceCurrency.toUpperCase(),
        targetCurrency: targetCurrency.toUpperCase(),
        grossAmount,
        spreadFee: spreadAmount,
        feePercentage: '0.75%',
        convertedAmount: netAmount,
        exchangeRateUsed: rate
      }
    });

  } catch (error) {
    console.error('[Settlement Route Error]:', error);
    return res.status(500).json({ error: 'Failed to process settlement transaction.' });
  }
});

// -----------------------------------------------------------------------------
// Start Express Server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[SettleX Engine Running] Port ${PORT}`);
});