const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

const WEBHOOK_SECRET = process.env.BAAS_WEBHOOK_SECRET || 'whsec_settlex_institutional_secret_99';

// Parse Redis connection
const redisConnection = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL, tls: {} }
  : { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT) || 6379 };

let dlqQueue = null;
try {
  dlqQueue = new Queue('webhook-dlq', { connection: redisConnection });
} catch (err) {
  console.warn('[DLQ Warning]: Queue initialization bypassed:', err.message);
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

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = hmac.update(JSON.stringify(req.body)).digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
    return next();
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

    if (dlqQueue) {
      try {
        await dlqQueue.add('retry-webhook', {
          payload: req.body,
          error: error.message,
          attemptedAt: new Date().toISOString()
        }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
      } catch (dlqErr) {
        console.warn('[DLQ Enqueue Failed]:', dlqErr.message);
      }
    }

    return res.status(200).json({ status: 'queued_for_retry', reason: error.message });
  }
});

module.exports = router;