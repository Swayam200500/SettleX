const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Redis = require('ioredis');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const redis = new Redis(process.env.UPSTASH_REDIS_REST_URL);

router.get('/health', async (req, res) => {
  const healthStatus = {
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      database: 'UNKNOWN',
      redis: 'UNKNOWN'
    }
  };

  try {
    // Check Supabase connection
    const { error } = await supabase.from('settlements').select('id').limit(1);
    healthStatus.services.database = error ? 'DEGRADED' : 'HEALTHY';
  } catch (err) {
    healthStatus.services.database = 'UNREACHABLE';
  }

  try {
    // Check Redis connection
    const redisPing = await redis.ping();
    healthStatus.services.redis = redisPing === 'PONG' ? 'HEALTHY' : 'DEGRADED';
  } catch (err) {
    healthStatus.services.redis = 'UNREACHABLE';
  }

  const isHealthy = Object.values(healthStatus.services).every(status => status === 'HEALTHY');
  res.status(isHealthy ? 200 : 503).json(healthStatus);
});

module.exports = router;