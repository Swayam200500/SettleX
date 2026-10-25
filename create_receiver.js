const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.BLINDPAY_API_KEY;
const INSTANCE_ID = process.env.BLINDPAY_INSTANCE_ID;
const BASE_URL = 'https://api.blindpay.com/v1';

async function setupTestReceiver() {
  try {
    console.log('1. Creating Receiver...');
    const receiverRes = await axios.post(
      `${BASE_URL}/instances/${INSTANCE_ID}/receivers`,
      {
        type: 'individual',
        email: 'test_user@settlex.com',
        first_name: 'John',
        last_name: 'Doe',
        customer_id: '123456789012345'
      },
      {
        headers: { Authorization: `Bearer ${API_KEY}` }
      }
    );

    const resPayload = receiverRes.data;
    
    // Safely extract from Array or Object
    let receiverId;
    if (Array.isArray(resPayload)) {
      receiverId = resPayload[0]?.id;
    } else if (Array.isArray(resPayload.data)) {
      receiverId = resPayload.data[0]?.id;
    } else {
      receiverId = resPayload.id || resPayload.data?.id || resPayload.receiver?.id;
    }

    if (!receiverId) {
      console.log('Full Receiver Payload:', JSON.stringify(resPayload, null, 2));
      throw new Error('Failed to extract receiver ID');
    }

    console.log('✅ Receiver Created! ID:', receiverId);

    console.log('2. Attaching Bank Account...');
    const bankRes = await axios.post(
      `${BASE_URL}/instances/${INSTANCE_ID}/receivers/${receiverId}/bank-accounts`,
      {
        type: 'checking',
        name: 'Test Business Account',
        account_number: '123456789012345',
        routing_number: '121000358',
        currency: 'USD'
      },
      {
        headers: { Authorization: `Bearer ${API_KEY}` }
      }
    );

    const bankPayload = bankRes.data;
    let bankAccountId;
    if (Array.isArray(bankPayload)) {
      bankAccountId = bankPayload[0]?.id;
    } else if (Array.isArray(bankPayload.data)) {
      bankAccountId = bankPayload.data[0]?.id;
    } else {
      bankAccountId = bankPayload.id || bankPayload.data?.id || bankPayload.bank_account?.id;
    }

    console.log('✅ Bank Account Created! ID:', bankAccountId);

    console.log('\n========================================');
    console.log('  PASTE THIS EXACT BODY INTO POSTMAN  ');
    console.log('========================================');
    console.log(JSON.stringify({
      customerId: receiverId,
      bankAccountId: bankAccountId,
      amount: 500,
      network: 'arbitrum_sepolia',
      token: 'USDB',
      currencyType: 'sender'
    }, null, 2));
    console.log('========================================\n');

  } catch (error) {
    console.error('Setup Failed Details:', error.message);
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
  }
}

setupTestReceiver();