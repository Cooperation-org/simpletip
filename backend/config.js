/**
 * SimpleTip Node Configuration
 *
 * Enable payment methods by providing credentials.
 * Only configured methods show up in the UI.
 * Uses env vars — set them in systemd unit or .env file.
 */

module.exports = {
  // Node identity
  nodeName: process.env.SIMPLETIP_NODE_NAME || 'SimpleTip by LinkedTrust',
  nodeUrl: process.env.SIMPLETIP_NODE_URL || 'https://demos.linkedtrust.us/simpletip',

  // Processing fee (percentage, 0 for nonprofit nodes)
  feePercent: parseFloat(process.env.SIMPLETIP_FEE_PCT || '0'),

  // Payment methods — each has an `enabled` flag derived from whether creds exist.
  // The /api/methods endpoint returns only enabled ones to the frontend.
  payments: {
    stripe: {
      enabled: !!process.env.STRIPE_SECRET_KEY,
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      label: 'Card / Apple Pay / Google Pay',
      icon: 'card',
      // Stripe handles: Visa, Mastercard, Amex, Apple Pay, Google Pay, ACH, SEPA, etc.
    },

    paypal: {
      enabled: !!process.env.PAYPAL_CLIENT_ID,
      clientId: process.env.PAYPAL_CLIENT_ID || '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
      mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' or 'live'
      label: 'PayPal / Venmo',
      icon: 'paypal',
    },

    zelle: {
      enabled: !!process.env.ZELLE_ADDRESS,
      address: process.env.ZELLE_ADDRESS || '', // email or phone
      label: 'Zelle',
      icon: 'zelle',
      // Manual: reader sends to this address, admin confirms receipt
    },

    mpesa: {
      enabled: !!process.env.CHIMONEY_API_KEY,
      chimoneyKey: process.env.CHIMONEY_API_KEY || '',
      label: 'M-Pesa',
      icon: 'mpesa',
    },

    cashapp: {
      enabled: !!process.env.CASHAPP_TAG,
      tag: process.env.CASHAPP_TAG || '',
      label: 'Cash App',
      icon: 'cashapp',
    },

    crypto: {
      enabled: !!process.env.CRYPTO_ADDRESS,
      address: process.env.CRYPTO_ADDRESS || '',
      network: process.env.CRYPTO_NETWORK || 'USDT (Ethereum)',
      label: 'Crypto (USDT)',
      icon: 'crypto',
      // Reader sends to this address, backend watches for tx or admin confirms
    },

    // ILP / Open Payments — if the node wants to support Interledger
    ilp: {
      enabled: !!process.env.ILP_WALLET_ADDRESS,
      walletAddress: process.env.ILP_WALLET_ADDRESS || '',
      label: 'Interledger',
      icon: 'ilp',
    },
  },

  // Demo mode — simulated payments (no real money)
  demoMode: process.env.SIMPLETIP_DEMO === '1'
    || (!process.env.STRIPE_SECRET_KEY && !process.env.PAYPAL_CLIENT_ID
      && !process.env.ZELLE_ADDRESS && !process.env.CRYPTO_ADDRESS),
};
