const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  payoutId: { type: String, required: true, unique: true },
  receiverId: { type: String, required: true },
  bankAccountId: { type: String, required: true },
  amountUsd: { type: Number, required: true },
  feeUsd: { type: Number, required: true },
  status: { type: String, default: 'COMPLETED' },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);