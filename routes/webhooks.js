const express = require('express');
const router = express.Router();
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nzvdlmnyeboqggpcrsqy.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Parse Redis connection for Upstash or local Redis
const redisConnection = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL, tls: {} }
  : { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT) || 6379 };

// Dead Letter Queue (DLQ) for failed webhooks / ledger reconciliations
const dlqQueue = new Queue('webhook-dlq', { connection: redisConnection });

/**
 * @openapi
 * /api/baas/callback:
 *   post:
 *     summary: BaaS Webhook Callback Handler
 *     description: Receives asynchronous status updates from payment rails and updates ledger state.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event_type: { type: string, example: "transfer.status_changed" }
 *               data:
 *                 type: object
 *                 properties:
 *                   id: { type: string, example: "0x2e92596bd8c3f060" }
 *                   status: { type: string, example: "completed" }
 *     responses:
 *       200:
 *         description: Webhook processed or queued for retry
 */
router.post('/baas/callback', async (req, res) => {
  const { event_type, data } = req.body || {};

  if (!event_type || !data) {
    return res.status(400).json({ error: 'Invalid payload: missing event_type or data' });
  }

  try {
    console.log(`[Webhook Received] Event: ${event_type}`, data);

    switch (event_type) {
      case 'transfer.status_changed':
        if (data.status === 'completed') {
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

    try {
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
            delay: 5000
          }
        }
      );
    } catch (dlqErr) {
      console.warn('[DLQ Enqueue Warning]:', dlqErr.message);
    }

    return res.status(200).json({ status: 'queued_for_retry', reason: error.message });
  }
});

module.exports = router;