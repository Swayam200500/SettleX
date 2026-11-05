const axios = require('axios');

class BaaSAdapter {
  constructor(provider = 'bridge') {
    this.provider = provider;
    this.bridgeClient = axios.create({
      baseURL: process.env.BRIDGE_BASE_URL,
      headers: {
        'Api-Key': process.env.BRIDGE_API_KEY,
        'Content-Type': 'application/json'
      }
    });
  }

  // Get FX Quote (USD to INR)
  async getQuote(sourceAmount, sourceCurrency = 'USD', destinationCurrency = 'INR') {
    try {
      if (this.provider === 'bridge') {
        // Bridge Sandbox FX Quote endpoint
        const response = await this.bridgeClient.post('/quotes', {
          source_currency: sourceCurrency.toLowerCase(),
          destination_currency: destinationCurrency.toLowerCase(),
          amount: sourceAmount
        });
        
        return {
          quoteId: response.data.id,
          rate: response.data.exchange_rate,
          sourceAmount: response.data.source_amount,
          destinationAmount: response.data.destination_amount,
          expiresAt: response.data.expires_at
        };
      }
    } catch (error) {
      console.error('BaaS Quote Error:', error.response?.data || error.message);
      throw new Error('Failed to fetch FX quote from BaaS provider');
    }
  }

  // Trigger Payout
  async executePayout(transferData) {
    try {
      // Calculate 1.00% SettleX fee explicitly if not passed
      const feeAmount = transferData.settleXFee || (transferData.amount * 0.01);

      const response = await this.bridgeClient.post('/transfers', {
        amount: transferData.amount,
        on_behalf_of: transferData.clientId,
        developer_fee: feeAmount, // Your 1.00% take rate
        source: {
          currency: 'usd',
          payment_method: 'ach'
        },
        destination: {
          currency: 'inr',
          payment_method: 'imps',
          account_number: transferData.recipientAccount,
          ifsc_code: transferData.recipientIfsc
        }
      });

      return {
        transferId: response.data.id,
        status: response.data.status, // e.g., 'pending', 'processing'
        createdAt: response.data.created_at
      };
    } catch (error) {
      console.error('BaaS Payout Error:', error.response?.data || error.message);
      throw new Error('Failed to execute payout via BaaS provider');
    }
  }
}

module.exports = new BaaSAdapter();