/**
 * SimpleTip Backend
 *
 * Simple ledger + payment processing for tips.
 * Port: 8046
 *
 * Payment methods are configured via env vars (see config.js).
 * Only configured methods appear in the UI.
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');

const app = express();
app.use(cors({ origin: true, credentials: true }));

// Stripe webhook needs raw body — must come before express.json()
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.json());

const PORT = 8046;
const DB_PATH = path.join(__dirname, 'simpletip.db');

// ── Stripe (conditional) ────────────────────────────────────

let stripe = null;
if (config.payments.stripe.enabled) {
  stripe = require('stripe')(config.payments.stripe.secretKey);
  console.log('Stripe configured');
}

// ── Database ─────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    payout_method TEXT NOT NULL DEFAULT 'paypal',
    payout_address TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    total_received REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    email TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    token TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 0,
    total_funded REAL DEFAULT 0,
    total_tipped REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    wallet_id TEXT,
    author_slug TEXT NOT NULL,
    subject_slug TEXT,
    amount REAL NOT NULL,
    author_amount REAL NOT NULL,
    subject_amount REAL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'wallet',
    payment_session TEXT,
    status TEXT DEFAULT 'completed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (author_slug) REFERENCES authors(slug)
  );

  CREATE TABLE IF NOT EXISTS funding (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    wallet_id TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'demo',
    payment_session TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (wallet_id) REFERENCES wallets(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tips_author ON tips(author_slug);
  CREATE INDEX IF NOT EXISTS idx_tips_wallet ON tips(wallet_id);
`);

// ── Auth middleware ───────────────────────────────────────────

function authWallet(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.wallet = null;
    return next();
  }
  const token = authHeader.slice(7);
  req.wallet = db.prepare('SELECT * FROM wallets WHERE token = ?').get(token) || null;
  next();
}

app.use(authWallet);

// ── Routes ───────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  const authorCount = db.prepare('SELECT count(*) as n FROM authors').get().n;
  const tipCount = db.prepare('SELECT count(*) as n FROM tips').get().n;
  const walletCount = db.prepare('SELECT count(*) as n FROM wallets').get().n;
  res.json({
    status: 'ok',
    node: config.nodeName,
    demoMode: config.demoMode,
    authors: authorCount,
    tips: tipCount,
    wallets: walletCount,
  });
});

// Available payment methods (frontend calls this to know what to show)
app.get('/api/methods', (req, res) => {
  const methods = [];
  for (const [key, cfg] of Object.entries(config.payments)) {
    if (cfg.enabled || config.demoMode) {
      const m = { id: key, label: cfg.label, icon: cfg.icon };
      // Include public info for manual methods
      if (key === 'zelle' && cfg.address) m.address = cfg.address;
      if (key === 'cashapp' && cfg.tag) m.tag = cfg.tag;
      if (key === 'crypto' && cfg.address) { m.address = cfg.address; m.network = cfg.network; }
      if (key === 'paypal' && cfg.clientId) m.clientId = cfg.clientId;
      if (key === 'stripe' && cfg.publishableKey) m.publishableKey = cfg.publishableKey;
      methods.push(m);
    }
  }
  // In demo mode, show all methods as available
  if (config.demoMode && methods.length === 0) {
    methods.push(
      { id: 'stripe', label: 'Card / Apple Pay / Google Pay', icon: 'card' },
      { id: 'paypal', label: 'PayPal / Venmo', icon: 'paypal' },
      { id: 'zelle', label: 'Zelle', icon: 'zelle', address: 'demo@linkedtrust.us' },
      { id: 'cashapp', label: 'Cash App', icon: 'cashapp', tag: '$LinkedTrust' },
      { id: 'crypto', label: 'Crypto (USDT)', icon: 'crypto', address: '0xdemo...', network: 'USDT (Ethereum)' },
    );
  }
  res.json({ methods, demoMode: config.demoMode });
});

// ── Author registration ─────────────────────────────────────

app.post('/api/author/register', (req, res) => {
  const { name, email, payoutMethod, payoutAddress } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = db.prepare('SELECT slug FROM authors WHERE slug = ?').get(slug);
  if (existing) {
    const count = db.prepare("SELECT count(*) as n FROM authors WHERE slug LIKE ?").get(slug + '%').n;
    slug = slug + '-' + (count + 1);
  }

  const byEmail = db.prepare('SELECT * FROM authors WHERE email = ?').get(email);
  if (byEmail) {
    return res.json({ slug: byEmail.slug, name: byEmail.name, existing: true });
  }

  const id = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO authors (id, slug, name, email, payout_method, payout_address) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, slug, name, email, payoutMethod || 'paypal', payoutAddress || '');

  res.json({ slug, name, id });
});

app.get('/api/author/:slug', (req, res) => {
  const author = db.prepare('SELECT slug, name, total_received, created_at FROM authors WHERE slug = ?')
    .get(req.params.slug);
  if (!author) return res.status(404).json({ error: 'author not found' });
  const tipCount = db.prepare('SELECT count(*) as n FROM tips WHERE author_slug = ?').get(req.params.slug).n;
  res.json({ ...author, tipCount });
});

// ── Wallet ──────────────────────────────────────────────────

app.post('/api/wallet/create', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const existing = db.prepare('SELECT * FROM wallets WHERE email = ?').get(email);
  if (existing) {
    return res.json({ token: existing.token, balance: existing.balance, name: existing.name, existing: true });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO wallets (id, email, name, token) VALUES (?, ?, ?, ?)')
    .run(id, email, name || '', token);

  res.json({ token, balance: 0, name: name || '' });
});

app.get('/api/wallet', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  res.json({
    balance: req.wallet.balance,
    totalFunded: req.wallet.total_funded,
    totalTipped: req.wallet.total_tipped,
    name: req.wallet.name,
  });
});

// ── Fund wallet ─────────────────────────────────────────────

// Stripe: create checkout session for wallet funding
app.post('/api/wallet/fund/stripe', async (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });

  if (!stripe) {
    // Demo mode — just credit the wallet
    return demoFund(req, res, amount, 'stripe');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `SimpleTip wallet — add $${amount}` },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      metadata: { wallet_id: req.wallet.id, type: 'fund' },
      success_url: `${config.nodeUrl}/fund-success.html?amount=${amount}`,
      cancel_url: `${config.nodeUrl}/fund.html`,
    });

    const fundId = crypto.randomBytes(8).toString('hex');
    db.prepare("INSERT INTO funding (id, wallet_id, amount, method, payment_session, status) VALUES (?, ?, ?, 'stripe', ?, 'pending')")
      .run(fundId, req.wallet.id, amount, session.id);

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: 'Stripe session failed', detail: err.message });
  }
});

// PayPal: return client-side info for PayPal JS SDK
app.post('/api/wallet/fund/paypal', async (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });

  if (!config.payments.paypal.enabled) {
    return demoFund(req, res, amount, 'paypal');
  }

  // For PayPal, the frontend uses the PayPal JS SDK with our client ID.
  // We record a pending funding and confirm it via webhook or client callback.
  const fundId = crypto.randomBytes(8).toString('hex');
  db.prepare("INSERT INTO funding (id, wallet_id, amount, method, status) VALUES (?, ?, ?, 'paypal', 'pending')")
    .run(fundId, req.wallet.id, amount);

  res.json({
    fundId,
    clientId: config.payments.paypal.clientId,
    amount,
    mode: config.payments.paypal.mode,
  });
});

// PayPal: confirm after client-side capture
app.post('/api/wallet/fund/paypal/confirm', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { fundId, paypalOrderId } = req.body;

  const fund = db.prepare("SELECT * FROM funding WHERE id = ? AND wallet_id = ? AND status = 'pending'")
    .get(fundId, req.wallet.id);
  if (!fund) return res.status(404).json({ error: 'funding not found' });

  db.transaction(() => {
    db.prepare("UPDATE funding SET status = 'completed', payment_session = ? WHERE id = ?")
      .run(paypalOrderId, fundId);
    db.prepare('UPDATE wallets SET balance = balance + ?, total_funded = total_funded + ? WHERE id = ?')
      .run(fund.amount, fund.amount, req.wallet.id);
  })();

  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);
  res.json({ success: true, balance: updated.balance });
});

// Manual methods (Zelle, Cash App, crypto) — record pending, admin confirms later
app.post('/api/wallet/fund/manual', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { amount, method, reference } = req.body;
  if (!amount || !method) return res.status(400).json({ error: 'amount and method required' });

  if (config.demoMode) {
    return demoFund(req, res, amount, method);
  }

  const fundId = crypto.randomBytes(8).toString('hex');
  db.prepare("INSERT INTO funding (id, wallet_id, amount, method, payment_session, status) VALUES (?, ?, ?, ?, ?, 'pending_confirmation')")
    .run(fundId, req.wallet.id, amount, method, reference || '');

  res.json({
    fundId,
    status: 'pending_confirmation',
    message: `Send $${amount} via ${method}. We'll credit your wallet once we confirm receipt.`,
  });
});

// Demo funding — instant credit
function demoFund(req, res, amount, method) {
  const fundId = crypto.randomBytes(8).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ?, total_funded = total_funded + ? WHERE id = ?')
      .run(amount, amount, req.wallet.id);
    db.prepare("INSERT INTO funding (id, wallet_id, amount, method, status) VALUES (?, ?, ?, ?, 'completed')")
      .run(fundId, req.wallet.id, amount, method + '-demo');
  })();

  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);
  res.json({ success: true, balance: updated.balance, demo: true });
}

// Legacy endpoint for backwards compat with demo page
app.post('/api/wallet/fund', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });
  return demoFund(req, res, amount, 'demo');
});

// ── Tipping ─────────────────────────────────────────────────

// Tip from wallet balance (one click!)
app.post('/api/tip', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });

  const { author, subject, amount, splitPct } = req.body;
  if (!author || !amount || amount <= 0) return res.status(400).json({ error: 'author and amount required' });

  if (req.wallet.balance < amount) {
    return res.status(402).json({ error: 'insufficient_funds', balance: req.wallet.balance });
  }

  const authorRow = db.prepare('SELECT * FROM authors WHERE slug = ?').get(author);
  if (!authorRow) return res.status(404).json({ error: 'author not found' });

  const pct = subject && splitPct != null ? splitPct : 100;
  const authorAmount = Math.round(amount * pct) / 100;
  const subjectAmount = subject ? Math.round(amount * (100 - pct)) / 100 : 0;

  const tipId = crypto.randomBytes(8).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance - ?, total_tipped = total_tipped + ? WHERE id = ?')
      .run(amount, amount, req.wallet.id);
    db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
      .run(authorAmount, author);
    if (subject) {
      db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
        .run(subjectAmount, subject);
    }
    db.prepare("INSERT INTO tips (id, wallet_id, author_slug, subject_slug, amount, author_amount, subject_amount, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'wallet')")
      .run(tipId, req.wallet.id, author, subject || null, amount, authorAmount, subjectAmount);
  })();

  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);
  res.json({ success: true, tipId, amount, authorAmount, subjectAmount, balance: updated.balance });
});

// Anonymous tip via Stripe (no wallet)
app.post('/api/tip/checkout', async (req, res) => {
  const { author, authorName, subject, subjectName, amount, splitPct, returnUrl } = req.body;
  if (!author || !amount) return res.status(400).json({ error: 'author and amount required' });

  const pct = subject && splitPct != null ? splitPct : 100;
  const authorAmount = subject ? Math.round(amount * pct) / 100 : amount;
  const subjectAmount = subject ? Math.round(amount * (100 - pct)) / 100 : 0;

  const tipId = crypto.randomBytes(8).toString('hex');
  const sessionId = crypto.randomBytes(16).toString('hex');

  db.prepare("INSERT INTO tips (id, author_slug, subject_slug, amount, author_amount, subject_amount, source, payment_session, status) VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, 'pending')")
    .run(tipId, author, subject || null, amount, authorAmount, subjectAmount, sessionId);

  if (stripe) {
    try {
      const tipDesc = subject
        ? `Tip: ${authorName || author} + ${subjectName || subject}`
        : `Tip for ${authorName || author}`;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: tipDesc },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        }],
        metadata: { tip_id: tipId, type: 'tip' },
        success_url: `${config.nodeUrl}/tip-success.html?amount=${amount}&author=${encodeURIComponent(authorName || author)}`,
        cancel_url: returnUrl || config.nodeUrl,
      });

      // Update with real Stripe session ID
      db.prepare('UPDATE tips SET payment_session = ? WHERE id = ?').run(session.id, tipId);

      return res.json({ checkoutUrl: session.url, sessionId: session.id, tipId });
    } catch (err) {
      return res.status(500).json({ error: 'Stripe failed', detail: err.message });
    }
  }

  // Demo mode
  const origin = returnUrl ? new URL(returnUrl).origin : config.nodeUrl;
  const checkoutUrl = `${origin}/simpletip/checkout.html?session=${sessionId}&amount=${amount}&author=${encodeURIComponent(authorName || author)}&tip=${tipId}`;
  res.json({ checkoutUrl, sessionId, tipId });
});

// Confirm a checkout (demo mode or manual confirmation)
app.post('/api/tip/confirm', (req, res) => {
  const { tipId, sessionId } = req.body;
  const tip = db.prepare("SELECT * FROM tips WHERE id = ? AND payment_session = ? AND status = 'pending'")
    .get(tipId, sessionId);
  if (!tip) return res.status(404).json({ error: 'tip not found or already confirmed' });

  db.transaction(() => {
    db.prepare("UPDATE tips SET status = 'completed' WHERE id = ?").run(tipId);
    db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
      .run(tip.author_amount, tip.author_slug);
    if (tip.subject_slug) {
      db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
        .run(tip.subject_amount, tip.subject_slug);
    }
  })();

  res.json({ success: true });
});

// ── Stripe webhook ──────────────────────────────────────────

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(400).send('Stripe not configured');

  let event;
  try {
    if (config.payments.stripe.webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.payments.stripe.webhookSecret);
    } else {
      event = JSON.parse(req.body);
    }
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};

    if (meta.type === 'fund') {
      // Wallet funding
      const fund = db.prepare("SELECT * FROM funding WHERE payment_session = ? AND status = 'pending'")
        .get(session.id);
      if (fund) {
        db.transaction(() => {
          db.prepare("UPDATE funding SET status = 'completed' WHERE id = ?").run(fund.id);
          db.prepare('UPDATE wallets SET balance = balance + ?, total_funded = total_funded + ? WHERE id = ?')
            .run(fund.amount, fund.amount, fund.wallet_id);
        })();
      }
    } else if (meta.type === 'tip') {
      // Direct tip
      const tip = db.prepare("SELECT * FROM tips WHERE payment_session = ? AND status = 'pending'")
        .get(session.id);
      if (tip) {
        db.transaction(() => {
          db.prepare("UPDATE tips SET status = 'completed' WHERE id = ?").run(tip.id);
          db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
            .run(tip.author_amount, tip.author_slug);
          if (tip.subject_slug) {
            db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
              .run(tip.subject_amount, tip.subject_slug);
          }
        })();
      }
    }
  }

  res.json({ received: true });
}

// ── Wallet tips history ─────────────────────────────────────

app.get('/api/wallet/tips', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const tips = db.prepare(`
    SELECT t.*, a.name as author_name
    FROM tips t LEFT JOIN authors a ON t.author_slug = a.slug
    WHERE t.wallet_id = ? ORDER BY t.created_at DESC LIMIT 50
  `).all(req.wallet.id);
  res.json(tips);
});

// ── Stats ───────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const totalTips = db.prepare("SELECT count(*) as n, sum(amount) as total FROM tips WHERE status = 'completed'").get();
  const topAuthors = db.prepare(`
    SELECT slug, name, total_received, (SELECT count(*) FROM tips WHERE author_slug = authors.slug) as tip_count
    FROM authors WHERE total_received > 0 ORDER BY total_received DESC LIMIT 10
  `).all();
  res.json({ totalTips: totalTips.n, totalAmount: totalTips.total || 0, topAuthors });
});

// ── Admin: confirm manual funding ───────────────────────────

app.post('/api/admin/confirm-funding', (req, res) => {
  // TODO: add admin auth
  const { fundId } = req.body;
  const fund = db.prepare("SELECT * FROM funding WHERE id = ? AND status = 'pending_confirmation'").get(fundId);
  if (!fund) return res.status(404).json({ error: 'funding not found' });

  db.transaction(() => {
    db.prepare("UPDATE funding SET status = 'completed' WHERE id = ?").run(fundId);
    db.prepare('UPDATE wallets SET balance = balance + ?, total_funded = total_funded + ? WHERE id = ?')
      .run(fund.amount, fund.amount, fund.wallet_id);
  })();

  res.json({ success: true });
});

// ── Start ────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SimpleTip backend on http://127.0.0.1:${PORT}`);
  console.log(`Mode: ${config.demoMode ? 'DEMO' : 'LIVE'}`);
  const enabled = Object.entries(config.payments).filter(([, v]) => v.enabled).map(([k]) => k);
  console.log(`Payment methods: ${enabled.length ? enabled.join(', ') : 'none (demo mode — all simulated)'}`);
});
