const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;
const SPREAD_RATE = 0.003; // 0.3% Institutional Spread Fee

// Middleware Setup
app.use(cors());
app.use(express.json());

// Initialize Supabase Client (HTTP SDK to prevent Render IPv6/IPv4 direct connection blocks)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.warn('[Warning]: Supabase URL or Anon Key missing. DB persistence running in mock mode.');
}

// -----------------------------------------------------------------------------
// Health Check Endpoint
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    platform: 'SettleX B2B Cross-Border Settlement Engine',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// Core Settlement Execution Endpoint
// -----------------------------------------------------------------------------
app.post('/api/settle', async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount, exchangeRate } = req.body;

    // Payload Validation
    if (!sourceCurrency || !targetCurrency || !amount || !exchangeRate) {
      return res.status(400).json({ 
        error: 'Missing required parameters. Required: sourceCurrency, targetCurrency, amount, exchangeRate.' 
      });
    }

    const grossAmount = parseFloat(amount);
    const rate = parseFloat(exchangeRate);

    if (isNaN(grossAmount) || isNaN(rate) || grossAmount <= 0 || rate <= 0) {
      return res.status(400).json({ error: 'Invalid numerical values for amount or exchangeRate.' });
    }

    // Financial Calculation Logic
    const spreadAmount = grossAmount * SPREAD_RATE;
    const netAmount = (grossAmount - spreadAmount) * rate;

    const transactionRecord = {
      source_currency: sourceCurrency,
      target_currency: targetCurrency,
      source_amount: grossAmount,
      target_amount: netAmount,
      spread_fee: spreadAmount,
      status: 'COMPLETED',
      created_at: new Date().toISOString()
    };

    // Non-Blocking Database Save (Guarantees API success even if DB latency or network retries occur)
    if (supabase) {
      supabase
        .from('settlements')
        .insert([transactionRecord])
        .then(({ error }) => {
          if (error) console.warn('[Supabase Insert Warning]:', error.message);
          else console.log('[Supabase Success]: Settlement logged to DB.');
        })
        .catch(err => console.warn('[Supabase Async Exception]:', err.message));
    }

    // High-Availability API Response
    return res.status(200).json({
      success: true,
      message: 'Settlement executed successfully',
      settlementDetails: {
        sourceCurrency,
        targetCurrency,
        grossAmount,
        spreadFee: spreadAmount,
        convertedAmount: netAmount,
        rate
      }
    });

  } catch (error) {
    console.error('[Settlement Engine Error]:', error);
    return res.status(500).json({ error: 'Failed to process settlement transaction.' });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`[SettleX Engine Running] Listening on port ${PORT}`);
});