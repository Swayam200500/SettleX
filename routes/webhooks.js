const express = require('express');
const router = express.Router();
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

// Parse Redis connection for Upstash or local Redis
const redisConnection = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL, tls: {} }
  : { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT) || 6379 };

let dlqQueue = null;
try {
  dlqQueue = new Queue('webhook-dlq', { connection: redisConnection });
} catch (err) {
  console.warn('[DLQ Warning]: Could not initialize BullMQ queue:', err.message);
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
  const key = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im56dmRsbW55ZWJvcWdncGNyc3F5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTY4ODg4OTh9.placeholder'; // Fallback check
  try {
    return createClient(url, key);
  } catch (err) {
    console.error('[Supabase Init Error]:', err.message);
    return null;
  }
}

router.post('/baas/callback', async (req, res) => {
  const { event_type, data } = req.body || {};

  if (!event_type || !data) {
    return res.status(400).json({ error: 'Invalid payload: missing event_type or data' });
  }

  const supabase = getSupabaseClient();

  try {
    console.log(`[Webhook Received] Event: ${event_type}`, data);

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

            if (dbError) {
              console.warn('[Supabase Warning]: Update error:', dbError.message);
            } else {
              console.log(`[Ledger Updated] ${updatedRows?.length || 0} rows updated for proof_hash: ${data.id}`);
            }
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

    // Always acknowledge receipt to BaaS provider
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error(`[Webhook Failed] Adding to DLQ: ${error.message}`);

    if (dlqQueue) {
      try {
        await dlqQueue.add(
          'retry-webhook',
          {
            payload: req.body,
            error: error.message,
            attemptedAt: new Date().toISOString()
          },
          { attempts: 5, backoff: { type: 'exponential', delay: 5000 } }
        );
      } catch (dlqErr) {
        console.warn('[DLQ Warning]:', dlqErr.message);
      }
    }

    return res.status(200).json({ status: 'queued_for_retry', reason: error.message });
  }
});

module.exports = router;