const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// Express Middleware
app.use(cors());
app.use(express.json());

// 1. Supabase Direct HTTP API Client (Bypasses IPv6/IPv4 network block issues)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// 2. PostgreSQL Connection Pool (Non-blocking retry)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Non-blocking database connection check
if (process.env.DATABASE_URL) {
  pool.connect()
    .then((client) => {
      console.log('[SettleX Engine] Connected directly to Supabase PostgreSQL');
      client.release();
    })
    .catch((err) => {
      console.warn('[DB Warning] PostgreSQL direct connection failed:', err.message);
      console.warn('[DB Warning] Server will continue running via HTTP fallback.');
    });
} else {
  console.log('[DB Info] No DATABASE_URL provided. Operating in HTTP API mode.');
}

// Institutional Spread Calculation (0.3% default)
const SPREAD_RATE = 0.003;

// --- API ROUTES ---

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    platform: 'SettleX B2B Cross-Border Settlement Engine',
    timestamp: new Date().toISOString()
  });
});

// Settlement Execution Endpoint
app.post('/api/settle', async (req, res) => {
  try {
    const { sourceCurrency, targetCurrency, amount, exchangeRate } = req.body;

    if (!sourceCurrency || !targetCurrency || !amount || !exchangeRate) {
      return res.status(400).json({ error: 'Missing required settlement parameters.' });
    }

    const grossAmount = parseFloat(amount);
    const rate = parseFloat(exchangeRate);
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

    // Attempt writing to Supabase via HTTP SDK first if configured
    if (supabase) {
      const { data, error } = await supabase
        .from('settlements')
        .insert([transactionRecord]);

      if (error) console.error('[Supabase HTTP Error]', error.message);
    } 
    // Fallback to PostgreSQL driver if DATABASE_URL is active
    else if (process.env.DATABASE_URL) {
      const query = `
        INSERT INTO settlements (source_currency, target_currency, source_amount, target_amount, spread_fee, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *;
      `;
      const values = [sourceCurrency, targetCurrency, grossAmount, netAmount, spreadAmount, 'COMPLETED'];
      await pool.query(query, values);
    }

    return res.json({
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
    console.error('[Settlement Processing Error]', error);
    return res.status(500).json({ error: 'Failed to process settlement transaction.' });
  }
});

// Serve frontend static files if running in combined mode
app.use(express.static('public'));

// Start Express Engine
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SettleX Engine] Server running on port ${PORT}`);
});