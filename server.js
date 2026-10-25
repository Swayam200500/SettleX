require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static dashboard files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 5000;
const API_KEY = process.env.SETTLEX_API_KEY || 'settlex_secret_key_123';

// PostgreSQL Connection Pool (Supabase SSL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Verify Database Connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('[DB Startup Error] Connection to Supabase PostgreSQL failed:', err.message);
    } else {
        console.log('[DB Connection] Connected to Supabase PostgreSQL.');
        release();
    }
});

// Middleware: API Key Authentication
const authenticateKey = (req, res, next) => {
    const authHeader = req.headers['x-api-key'];
    if (authHeader && authHeader === API_KEY) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing x-api-key header' });
    }
};

// -----------------------------------------------------------------------------
// REST API ENDPOINTS
// -----------------------------------------------------------------------------

// 1. Live Balances Endpoint
app.get('/api/v1/balances', authenticateKey, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT entity_name, currency, balance FROM accounts ORDER BY currency ASC');
        res.json({ success: true, accounts: rows });
    } catch (err) {
        console.error('[Fetch Balances Error]:', err.message);
        res.status(500).json({ error: 'Failed to fetch account balances', details: err.message });
    }
});

// 2. Settlement Execution Endpoint (Double-Entry ACID Transaction)
app.post('/api/v1/settle', authenticateKey, async (req, res) => {
    const { amount, sourceCurrency, targetCurrency } = req.body;
    
    if (!amount || !sourceCurrency || !targetCurrency) {
        return res.status(400).json({ error: 'Missing required parameters: amount, sourceCurrency, or targetCurrency' });
    }

    const rates = { EUR: 0.92, GBP: 0.79, INR: 83.25, CNY: 7.23, BRL: 5.05 };
    const rate = rates[targetCurrency] || 1.0;
    const fee = amount * 0.005; // 0.5% protocol fee
    const convertedAmount = (amount - fee) * rate;
    
    // Hash proof generation
    const txHash = '0x' + crypto.createHash('sha256')
        .update(`${Date.now()}_${amount}_${sourceCurrency}_${targetCurrency}`)
        .digest('hex');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Debit Source Account
        const debitRes = await client.query(
            `UPDATE accounts 
             SET balance = balance - $1 
             WHERE currency = $2 AND balance >= $1 
             RETURNING balance`,
            [amount, sourceCurrency]
        );

        if (debitRes.rowCount === 0) {
            throw new Error(`Insufficient funds or missing account for ${sourceCurrency}`);
        }

        // Credit Target Account
        const creditRes = await client.query(
            `UPDATE accounts 
             SET balance = balance + $1 
             WHERE currency = $2 
             RETURNING balance`,
            [convertedAmount, targetCurrency]
        );

        if (creditRes.rowCount === 0) {
            throw new Error(`Target account for ${targetCurrency} does not exist in database`);
        }

        // Insert Transaction Audit Log
        await client.query(
            `INSERT INTO transactions 
            (tx_hash, source_amount, source_currency, target_amount, target_currency, fee_amount, fx_rate, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [txHash, amount, sourceCurrency, convertedAmount.toFixed(2), targetCurrency, fee, rate, 'EXECUTED']
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            status: 'EXECUTED',
            settlement: {
                txHash,
                principalAmount: `${amount} ${sourceCurrency}`,
                settlexFee: `${fee} ${sourceCurrency}`,
                netConvertedPayout: `${convertedAmount.toFixed(2)} ${targetCurrency}`,
                appliedRate: rate,
                timestamp: new Date().toISOString()
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Settlement Error]:', err.message);
        res.status(500).json({ error: 'Settlement execution failed', details: err.message });
    } finally {
        client.release();
    }
});

// 3. Audit History Endpoint
app.get('/api/v1/history', authenticateKey, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT tx_hash, source_amount, source_currency, target_amount, target_currency, fee_amount, fx_rate, status, created_at FROM transactions ORDER BY created_at DESC LIMIT 10'
        );
        res.json({ success: true, transactions: rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch transaction history', details: err.message });
    }
});

// Serve UI Entry Point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server Engine
app.listen(PORT, () => {
    console.log(`[SettleX Engine] Server running at http://localhost:${PORT}`);
});