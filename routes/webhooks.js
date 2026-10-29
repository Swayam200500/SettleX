const express = require('express');
const router = express.Router();
const { Queue } = require('bullmq');
const { supabase } = require('../config/supabaseClient'); // Adjust relative path if needed

// Parse Redis connection for Upstash or local Redis
const redisConnection = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL, tls: {} }
  : { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT) || 6379 };

// Dead Letter Queue (DLQ) for failed webhooks / ledger reconciliations
const dlqQueue = new Queue('webhook-dlq', { connection: redisConnection });

// Endpoint: POST /api/baas/callback
router.post('/baas/callback', async (req, res) => {
  const { event_type, data } = req.body;

  try {
    console.log(`[Webhook Received] Event: ${event_type}`, data);

    switch (event_type) {
      case 'transfer.status_changed':
        if (data.status === 'completed') {
          // Update PostgreSQL double-entry ledger via Supabase
          const { error: dbError } = await supabase
            .from('settlements')
            .update({
              status: 'SETTLED',
              updated_at: new Date().toISOString()
            })
            .eq('proof_hash', data.id);

          if (dbError) {
            throw new Error(`Supabase Ledger Update Failed: ${dbError.message}`);
          }

          console.log(`[Ledger Updated] Transfer ${data.id} settled successfully.`);

        } else if (data.status === 'failed') {
          // Mark settlement as failed in Supabase
          await supabase
            .from('settlements')
            .update({
              status: 'FAILED',
              failure_reason: data.failure_reason || 'Rail transfer failed',
              updated_at: new Date().toISOString()
            })
            .eq('proof_hash', data.id);

          throw new Error(`Transfer ${data.id} failed on BaaS rails: ${data.failure_reason}`);
        }
        break;

      default:
        console.log(`Unhandled event type: ${event_type}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error(`[Webhook Failed] Adding to DLQ: ${error.message}`);

    // Push failed webhook payload to DLQ with exponential backoff
    await dlqQueue.add(
      'retry-webhook',
      {
        payload: req.body,
        error: error.message,
        attemptedAt: new Date().toISOString()
      },
      {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000 // Start retries at 5s delay
        }
      }
    );

    // Acknowledge receipt to BaaS provider so endpoint remains active
    return res.status(200).json({ status: 'queued_for_retry', reason: error.message });
  }
});

module.exports = router;