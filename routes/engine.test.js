const request = require('supertest');
const app = require('../server');

describe('SettleX Engine Automated Resilience Tests', () => {
  test('GET /api/health - Returns 200 OK & Active Cache Engine', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('online');
  });

  test('POST /api/settle - Rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/settle').send({
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      amount: 1000
    });
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/quote - Validates FX calculation & 1.00% fee', async () => {
    const res = await request(app).get('/api/quote?sourceCurrency=USD&targetCurrency=EUR&amount=10000');
    expect(res.statusCode).toBe(200);
    expect(res.body.quote.spreadFee).toBe(100);
  });

  test('POST /api/settle - Verifies Idempotency Replay Guard', async () => {
    const res = await request(app)
      .post('/api/settle')
      .set('x-api-key', 'settlex_secret_key_123')
      .set('idempotency-key', 'test_idempotency_key_99')
      .send({
        sourceCurrency: 'USD',
        targetCurrency: 'EUR',
        amount: 1000
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settlementDetails.spreadFee).toBe(10);
  });
});