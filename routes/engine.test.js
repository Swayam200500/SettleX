const request = require('supertest');
const app = require('../server');

describe('SettleX Engine Test Suite', () => {
  it('GET /api/health - returns online status', async () => {
    const res = await request(app).get('/api/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body.status).toEqual('online');
  });

  it('GET /api/quote - calculates 0.75% institutional fee accurately', async () => {
    const res = await request(app).get('/api/quote?sourceCurrency=USD&targetCurrency=EUR&amount=1000');
    expect(res.statusCode).toEqual(200);
    expect(res.body.quote.grossAmount).toEqual(1000);
    expect(res.body.quote.spreadFee).toEqual(7.5);
    expect(res.body.quote.feePercentage).toEqual('0.75%');
  });

  it('POST /api/settle - enforces API Key authentication', async () => {
    const res = await request(app).post('/api/settle').send({
      sourceCurrency: 'USD',
      targetCurrency: 'EUR',
      amount: 1000
    });
    expect(res.statusCode).toEqual(401);
  });

  it('POST /api/settle - processes transaction with valid API key', async () => {
    const res = await request(app)
      .post('/api/settle')
      .set('x-api-key', 'settlex_secret_key_123')
      .send({
        sourceCurrency: 'USD',
        targetCurrency: 'EUR',
        amount: 1000
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settlementDetails.spreadFee).toEqual(7.5);
    expect(res.body.settlementDetails.proofHash).toBeDefined();
  });
});