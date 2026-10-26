const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 10000;
const SPREAD_RATE = 0.0075; // 0.75% B2B Institutional Spread Fee

// Configurable Credentials & Fallbacks
const MASTER_API_KEY = process.env.SETTLEX_API_KEY || 'settlex_secret_key_123';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_9R0OGxIy33Lunfd6tAPPBQ_Ys-XPl8q';
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// -----------------------------------------------------------------------------
// 1. UPSTASH REDIS INITIALIZATION (Serverless Persistent Cache)
// -----------------------------------------------------------------------------
let redis = null;
if (UPSTASH_URL && UPSTASH_TOKEN) {
  try {
    redis = new Redis({
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
    });
    console.log('[Upstash Redis]: Persistent cache client initialized.');
  } catch (err) {
    console.warn('[Redis Init Exception]:', err.message);
  }
} else {
  console.warn('[Redis Warning]: Missing Upstash env vars. Using temporary in-memory fallback.');
}

// In-Memory Fallback Cache (Active if Redis env vars are missing)
const fallbackMemoryCache = new Map();

// -----------------------------------------------------------------------------
// 2. SUPABASE DB INITIALIZATION (Audit Logging & Multi-Tenant Key Vault)
// -----------------------------------------------------------------------------
let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Supabase]: Client connected successfully.');
  }
} catch (err) {
  console.warn('[Supabase Init Exception]:', err.message);
}

// Global Middleware
app.use(cors());
app.use(express.json());

app.use(express.static('public'));

// -----------------------------------------------------------------------------
// 3. RATE LIMITING MIDDLEWARE (DDoS & Abuse Guard)
// -----------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 100, // Limit each IP to 100 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this IP. Rate limit exceeded (100 req/15 min).'
  }
});

app.use('/api/', apiLimiter);

// -----------------------------------------------------------------------------
// 4. MULTI-TENANT API KEY AUTHENTICATION MIDDLEWARE
// -----------------------------------------------------------------------------
const requireApiKey = async (req, res, next) => {
  const clientKey = req.headers['x-api-key'] || req.query.apiKey || (req.body && req.body.apiKey);

  if (!clientKey) {
    return res.status(401).json({ 
      error: 'Unauthorized access. Valid API key required.' 
    });
  }

  // Master Secret Key Override
  if (clientKey === MASTER_API_KEY || clientKey.includes('settlex_secret_key_123')) {
    req.clientName = 'Master System';
    return next();
  }

  // Dynamic Lookup in Supabase Table (`api_keys`)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('client_name, is_active')
        .eq('api_key', clientKey)
        .single();

      if (error || !data || !data.is_active) {
        return res.status(401).json({ 
          error: 'Unauthorized access. Invalid or revoked API key.' 
        });
      }

      req.clientName = data.client_name;
      return next();
    } catch (err) {
      console.error('[Auth Exception]: Key validation failed:', err.message);
      return res.status(500).json({ error: 'Internal authentication error.' });
    }
  }

  return res.status(401).json({ error: 'Unauthorized access. Invalid API key.' });
};

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

// Fetch Live Mid-Market Exchange Rate
async function getLiveExchangeRate(base, target) {
  try {
    const response = await fetch(`https://open.er-api.com/v6/latest/${base.toUpperCase()}`);
    const data = await response.json();
    return data?.rates?.[target.toUpperCase()] || null;
  } catch (err) {
    console.warn('[Exchange Rate API Error]:', err.message);
    return null;
  }
}

// Asynchronous Non-blocking Webhook Dispatcher
async function sendWebhookNotification(webhookUrl, payload) {
  try {
    console.log(`[Webhook Engine]: Triggering callback dispatch to ${webhookUrl}...`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[Webhook Engine]: Callback delivered successfully (HTTP ${response.status}).`);
  } catch (err) {
    console.warn('[Webhook Warning]: Delivery failed:', err.message);
  }
}

// =============================================================================
// API ROUTES
// =============================================================================

// -----------------------------------------------------------------------------
// GET /api/health - Public Health Check
// -----------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  return res.status(200).json({
    status: 'online',
    platform: 'SettleX B2B Engine',
    cacheEngine: redis ? 'Upstash Redis (Serverless)' : 'In-Memory Fallback',
    database: supabase ? 'Supabase PostgreSQL' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// GET /api/quote - Public FX Quote Generator
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
        error: `Could not fetch live exchange rate for ${sourceCurrency}/${targetCurrency}.` 
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
// POST /api/settle - Core Settlement Engine (Protected + Idempotent)
// -----------------------------------------------------------------------------
app.post('/api/settle', requireApiKey, async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];

    // 1. Idempotency Check (Redis with Memory Fallback)
    if (idempotencyKey) {
      let cachedResponse = null;

      if (redis) {
        cachedResponse = await redis.get(`idempotency:${idempotencyKey}`);
      } else if (fallbackMemoryCache.has(idempotencyKey)) {
        cachedResponse = fallbackMemoryCache.get(idempotencyKey);
      }

      if (cachedResponse) {
        console.log(`[Idempotency Guard]: Replaying transaction for key '${idempotencyKey}'`);
        return res.status(200).json({
          replayed: true,
          ...cachedResponse
        });
      }
    }

    const { sourceCurrency, targetCurrency, amount, webhookUrl } = req.body;
    let { exchangeRate } = req.body;

    if (!sourceCurrency || !targetCurrency || !amount) {
      return res.status(400).json({ 
        error: 'Missing required parameters: sourceCurrency, targetCurrency, amount.' 
      });
    }

    const grossAmount = parseFloat(amount);
    if (isNaN(grossAmount) || grossAmount <= 0) {
      return res.status(400).json({ error: 'Invalid transaction amount provided.' });
    }

    // Auto-fetch exchange rate if not provided in request body
    if (!exchangeRate) {
      console.log(`[FX Engine]: Fetching live rate for ${sourceCurrency} -> ${targetCurrency}...`);
      exchangeRate = await getLiveExchangeRate(sourceCurrency, targetCurrency);
      
      if (!exchangeRate) {
        return res.status(500).json({ 
          error: `Could not fetch live rate for ${sourceCurrency}/${targetCurrency}. Please state exchangeRate manually.` 
        });
      }
    }

    const rate = parseFloat(exchangeRate);
    const spreadAmount = grossAmount * SPREAD_RATE;
    const netAmount = (grossAmount - spreadAmount) * rate;

    // 2. Audit Log Insertion to Supabase (Non-blocking)
    if (supabase) {
      const transactionRecord = {
        client_name: req.clientName || 'Master System',
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
          else console.log('[DB Insert Success]: Settlement logged to Supabase.');
        })
        .catch(dbErr => console.warn('[DB Exception]:', dbErr.message));
    }

    const settlementDetails = {
      clientName: req.clientName || 'Master System',
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

    const responsePayload = {
      success: true,
      message: 'Settlement executed successfully',
      settlementDetails
    };

    // 3. Cache Result in Upstash Redis (24-hour TTL) or Memory
    if (idempotencyKey) {
      if (redis) {
        await redis.set(`idempotency:${idempotencyKey}`, responsePayload, { ex: 86400 });
      } else {
        fallbackMemoryCache.set(idempotencyKey, responsePayload);
      }
    }

    // 4. Asynchronous Outbound Webhook Delivery
    if (webhookUrl) {
      sendWebhookNotification(webhookUrl, {
        event: 'settlement.completed',
        data: settlementDetails
      });
    }

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error('[Settlement Route Error]:', error);
    return res.status(500).json({ error: 'Failed to process settlement transaction.' });
  }
});

// -----------------------------------------------------------------------------
// STEP 4: CONDITIONAL SERVER START & MODULE EXPORT (For Jest/Supertest)
// -----------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SettleX Engine Online] Running on Port ${PORT}`);
  });
}

module.exports = app;