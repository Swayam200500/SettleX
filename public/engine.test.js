const request = require('supertest');
// Point to server.js in the root folder
const app = require('../server'); 

describe('SettleX Engine Automated Resilience Tests', () => {

  test('GET /api/health - Returns 200 OK & Active Cache Engine', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('online');
  });

  test('POST /api/settle - Rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/api/settle')
      .send({ sourceCurrency: 'USD', targetCurrency: 'EUR', amount: 1000 });
    
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/quote - Validates FX calculation & 0.75% fee', async () => {
    const res = await request(app)
      .get('/api/quote?sourceCurrency=USD&targetCurrency=EUR&amount=10000');

    expect(res.statusCode).toBe(200);
    expect(res.body.quote.spreadFee).toBe(75);
  });

  test('POST /api/settle - Verifies Idempotency Replay Guard', async () => {
    const testKey = `test_idempotency_${Date.now()}`;

    // Execution 1
    const res1 = await request(app)
      .post('/api/settle')
      .set('x-api-key', 'settlex_secret_key_123')
      .set('idempotency-key', testKey)
      .send({ sourceCurrency: 'USD', targetCurrency: 'EUR', amount: 5000 });

    expect(res1.statusCode).toBe(200);
    expect(res1.body.success).toBe(true);

    // Execution 2 (Replay)
    const res2 = await request(app)
      .post('/api/settle')
      .set('x-api-key', 'settlex_secret_key_123')
      .set('idempotency-key', testKey)
      .send({ sourceCurrency: 'USD', targetCurrency: 'EUR', amount: 5000 });

    expect(res2.statusCode).toBe(200);
    expect(res2.body.replayed).toBe(true);
  });

});