const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');

const WEBHOOK_SECRET = process.env.BAAS_WEBHOOK_SECRET || 'whsec_settlex_institutional_secret_99';

// Initialize Upstash Redis HTTP Client (Serverless Safe)
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch (err) {
    console.warn('[Webhook Upstash Init Error]:', err.message);
  }
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) return null;
  try {
    return createClient(url, key);
  } catch (err) {
    return null;
  }
}

// HMAC-SHA256 Signature Verification Guard
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-settlex-signature'];
  if (!signature) {
    if (process.env.NODE_ENV === 'production' && process.env.ENFORCE_WEBHOOK_SIG === 'true') {
      return res.status(401).json({ error: 'Missing x-settlex-signature header' });
    }
    return next();
  }

  try {
    const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const expectedDigest = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    const sigBuffer = Buffer.from(signature);
    const digestBuffer = Buffer.from(expectedDigest);

    if (sigBuffer.length === digestBuffer.length && crypto.timingSafeEqual(sigBuffer, digestBuffer)) {
      return next();
    }
  } catch (err) {
    console.warn('[Webhook Auth Warning]: Signature validation error:', err.message);
  }

  return res.status(403).json({ error: 'Invalid signature verification failed' });
}

router.post('/baas/callback', verifyWebhookSignature, async (req, res) => {
  const { event_type, data } = req.body || {};

  if (!event_type || !data) {
    return res.status(400).json({ error: 'Invalid payload: missing event_type or data' });
  }

  const supabase = getSupabaseClient();

  try {
    console.log(`[Webhook Validated] Event: ${event_type}`, data);

    switch (event_type) {
      case 'transfer.status_changed':
        if (data.status === 'completed') {
          if (supabase) {
            const { data: updatedRows, error: dbError } = await supabase
              .from('settlements')
              .update({
                status: 'SETTLED',
                updated_at: new Date().toISOString()
              })
              .eq('proof_hash', data.id)
              .select();

            if (dbError) console.warn('[Supabase Warning]: Update error:', dbError.message);
            else console.log(`[Ledger Updated] ${updatedRows?.length || 0} rows set to SETTLED`);
          }
        } else if (data.status === 'failed') {
          if (supabase) {
            await supabase
              .from('settlements')
              .update({
                status: 'FAILED',
                failure_reason: data.failure_reason || 'Rail transfer failed',
                updated_at: new Date().toISOString()
              })
              .eq('proof_hash', data.id)
              .select();
          }
        }
        break;

      default:
        console.log(`Unhandled event type: ${event_type}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error(`[Webhook Processing Error] Enqueueing DLQ: ${error.message}`);

    // Serverless-compatible DLQ logging via Upstash Redis List
    if (redis) {
      try {
        const dlqPayload = {
          payload: req.body,
          error: error.message,
          attemptedAt: new Date().toISOString()
        };
        await redis.lpush('webhook-dlq', JSON.stringify(dlqPayload));
        console.log('[DLQ Enqueued]: Successfully logged to Upstash DLQ queue.');
      } catch (dlqErr) {
        console.warn('[DLQ Enqueue Failed]:', dlqErr.message);
      }
    }

    return res.status(200).json({ status: 'queued_for_retry', reason: error.message });
  }
});

module.exports = router;