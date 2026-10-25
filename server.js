const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;
const SPREAD_RATE = 0.003; // 0.3% Institutional Spread Fee

// Middleware
app.use(cors());
app.use(express.json());

// =============================================================================
// SUPABASE CONFIGURATION
// Replace 'YOUR_SUPABASE_PROJECT_REF' and 'YOUR_SUPABASE_ANON_KEY' below with 
// your actual keys from Supabase (Project Settings -> API)
// =============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_9R0OGxIy33Lunfd6tAPPBQ_Ys-XPl8q';

// Initialize Supabase HTTP Client
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
    const { sourceCurrency, targetCurrency, amount, exchangeRate } = req.body;

    // Payload validation
    if (!sourceCurrency || !targetCurrency || !amount || !exchangeRate) {
      return res.status(400).json({ 
        error: 'Missing required parameters. Required: sourceCurrency, targetCurrency, amount, exchangeRate.' 
      });
    }

    const grossAmount = parseFloat(amount);
    const rate = parseFloat(exchangeRate);

    if (isNaN(grossAmount) || isNaN(rate) || grossAmount <= 0 || rate <= 0) {
      return res.status(400).json({ error: 'Invalid numeric values provided.' });
    }

    // Settlement Calculations (0.3% Institutional Fee)
    const spreadAmount = grossAmount * SPREAD_RATE;
    const netAmount = (grossAmount - spreadAmount) * rate;

    // Async Database Insertion (Non-blocking: prevents API timeouts)
    if (supabase) {
      const transactionRecord = {
        source_currency: sourceCurrency,
        target_currency: targetCurrency,
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

    // Immediate High-Availability Response
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