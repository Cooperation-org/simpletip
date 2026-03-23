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

// ATProto OAuth (conditional — needs HTTPS domain)
let oauthClient = null;
let NodeOAuthClient, SimpleStoreMemory;

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

  CREATE TABLE IF NOT EXISTS pledges (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    wallet_id TEXT NOT NULL,
    author_slug TEXT NOT NULL,
    subject_slug TEXT,
    amount REAL NOT NULL,
    author_amount REAL NOT NULL,
    subject_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    fulfilled_tip_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (wallet_id) REFERENCES wallets(id),
    FOREIGN KEY (author_slug) REFERENCES authors(slug)
  );

  CREATE INDEX IF NOT EXISTS idx_tips_author ON tips(author_slug);
  CREATE INDEX IF NOT EXISTS idx_tips_wallet ON tips(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_pledges_wallet ON pledges(wallet_id);
  CREATE INDEX IF NOT EXISTS idx_pledges_author ON pledges(author_slug);
`);

// Add DID and handle columns to wallets if not present
try { db.exec('ALTER TABLE wallets ADD COLUMN did TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE wallets ADD COLUMN handle TEXT'); } catch (e) {}

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
  const { email, name, googleIdToken } = req.body;

  // If Google ID token provided, verify and use email from it
  // (For now, trust the email from the frontend — in production, verify the token server-side)
  // If email provided, check for existing wallet
  if (email) {
    const existing = db.prepare('SELECT * FROM wallets WHERE email = ?').get(email);
    if (existing) {
      return res.json({ token: existing.token, balance: existing.balance, name: existing.name, email: existing.email, existing: true });
    }
  }

  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  // Anonymous wallets get a placeholder email (never null — allows linking later)
  const walletEmail = email || `anon-${id}@wallet.local`;
  db.prepare('INSERT INTO wallets (id, email, name, token) VALUES (?, ?, ?, ?)')
    .run(id, walletEmail, name || '', token);

  res.json({ token, balance: 0, name: name || '', email: email || null });
});

// Link an email/Google account to an existing wallet (for recovery)
app.post('/api/wallet/link', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Check if another wallet already has this email
  const other = db.prepare('SELECT id FROM wallets WHERE email = ? AND id != ?').get(email, req.wallet.id);
  if (other) {
    return res.status(409).json({ error: 'email already linked to another wallet' });
  }

  db.prepare('UPDATE wallets SET email = ?, name = CASE WHEN name = \'\' THEN ? ELSE name END WHERE id = ?')
    .run(email, name || '', req.wallet.id);
  res.json({ success: true, email });
});

// Recover wallet by email (returns token)
app.post('/api/wallet/recover', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const wallet = db.prepare('SELECT * FROM wallets WHERE email = ?').get(email);
  if (!wallet || wallet.email.endsWith('@wallet.local')) {
    return res.status(404).json({ error: 'no wallet found for this email' });
  }

  // In production: send magic link or verify Google token, don't just return token
  // For demo: return token directly
  res.json({ token: wallet.token, balance: wallet.balance, name: wallet.name, email: wallet.email });
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

// ── Pledges ─────────────────────────────────────────────────

// Create a pledge (no balance needed — just intent)
app.post('/api/pledge', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });

  const { author, subject, amount, splitPct } = req.body;
  if (!author || !amount || amount <= 0) return res.status(400).json({ error: 'author and amount required' });

  const pct = subject && splitPct != null ? splitPct : 100;
  const authorAmount = Math.round(amount * pct) / 100;
  const subjectAmount = subject ? Math.round(amount * (100 - pct)) / 100 : 0;

  const pledgeId = crypto.randomBytes(8).toString('hex');
  db.prepare("INSERT INTO pledges (id, wallet_id, author_slug, subject_slug, amount, author_amount, subject_amount) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(pledgeId, req.wallet.id, author, subject || null, amount, authorAmount, subjectAmount);

  // Return total pending pledges for this wallet
  const pending = db.prepare("SELECT count(*) as n, sum(amount) as total FROM pledges WHERE wallet_id = ? AND status = 'pending'")
    .get(req.wallet.id);

  res.json({ success: true, pledgeId, pendingCount: pending.n, pendingTotal: pending.total || 0 });
});

// Get pending pledges for the current wallet
app.get('/api/pledges', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const pledges = db.prepare(`
    SELECT p.*, a.name as author_name
    FROM pledges p LEFT JOIN authors a ON p.author_slug = a.slug
    WHERE p.wallet_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC
  `).all(req.wallet.id);
  const total = pledges.reduce((s, p) => s + p.amount, 0);
  res.json({ pledges, total });
});

// Fulfill all pending pledges (called after wallet is funded)
app.post('/api/pledges/fulfill', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });

  const pending = db.prepare("SELECT * FROM pledges WHERE wallet_id = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(req.wallet.id);

  if (pending.length === 0) return res.json({ fulfilled: 0 });

  const totalNeeded = pending.reduce((s, p) => s + p.amount, 0);
  if (req.wallet.balance < totalNeeded) {
    return res.status(402).json({
      error: 'insufficient_funds',
      balance: req.wallet.balance,
      needed: totalNeeded,
      pledgeCount: pending.length,
    });
  }

  let fulfilled = 0;
  db.transaction(() => {
    for (const p of pending) {
      if (req.wallet.balance < p.amount) break; // stop if can't cover next pledge

      const tipId = crypto.randomBytes(8).toString('hex');
      db.prepare("INSERT INTO tips (id, wallet_id, author_slug, subject_slug, amount, author_amount, subject_amount, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'pledge')")
        .run(tipId, req.wallet.id, p.author_slug, p.subject_slug, p.amount, p.author_amount, p.subject_amount);
      db.prepare('UPDATE wallets SET balance = balance - ?, total_tipped = total_tipped + ? WHERE id = ?')
        .run(p.amount, p.amount, req.wallet.id);
      db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
        .run(p.author_amount, p.author_slug);
      if (p.subject_slug) {
        db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
          .run(p.subject_amount, p.subject_slug);
      }
      db.prepare("UPDATE pledges SET status = 'fulfilled', fulfilled_tip_id = ? WHERE id = ?")
        .run(tipId, p.id);
      fulfilled++;
      // Update in-memory balance for loop
      req.wallet.balance -= p.amount;
    }
  })();

  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);
  res.json({ fulfilled, balance: updated.balance });
});

// ── Bluesky OAuth ───────────────────────────────────────────

// Serve client-metadata.json for ATProto OAuth
app.get('/client-metadata.json', (req, res) => {
  const nodeUrl = config.nodeUrl;
  res.json({
    client_id: `${nodeUrl}/client-metadata.json`,
    client_name: config.nodeName || 'SimpleTip',
    client_uri: nodeUrl,
    redirect_uris: [`${nodeUrl}/api/auth/bluesky/callback`],
    scope: 'atproto',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  });
});

// Initialize ATProto OAuth client (async, called at startup)
async function setupBlueskyOAuth() {
  try {
    const nodeUrl = config.nodeUrl;
    const isHttps = nodeUrl.startsWith('https://') && !nodeUrl.includes('localhost');
    if (!isHttps) {
      console.log('Bluesky OAuth: skipped (requires HTTPS domain)');
      return;
    }

    const { NodeOAuthClient: NOC } = await import('@atproto/oauth-client-node');
    const { SimpleStoreMemory: SSM } = await import('@atproto-labs/simple-store-memory');
    NodeOAuthClient = NOC;
    SimpleStoreMemory = SSM;

    const stateStore = new SimpleStoreMemory({ max: 100, ttl: 10 * 60 * 1000 });
    const sessionStore = new SimpleStoreMemory({ max: 100 });

    oauthClient = new NodeOAuthClient({
      clientMetadata: {
        client_id: `${nodeUrl}/client-metadata.json`,
        client_name: config.nodeName || 'SimpleTip',
        client_uri: nodeUrl,
        redirect_uris: [`${nodeUrl}/api/auth/bluesky/callback`],
        scope: 'atproto',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        dpop_bound_access_tokens: true,
      },
      stateStore,
      sessionStore,
    });

    console.log('Bluesky OAuth configured');
  } catch (err) {
    console.log('Bluesky OAuth setup failed:', err.message);
  }
}

// Start Bluesky OAuth flow
app.get('/api/auth/bluesky', async (req, res) => {
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'handle required' });

  if (!oauthClient) {
    return res.status(503).json({ error: 'Bluesky OAuth not available (needs HTTPS domain)' });
  }

  try {
    const url = await oauthClient.authorize(handle, {
      scope: 'atproto',
    });
    res.json({ url: url.toString() });
  } catch (err) {
    res.status(500).json({ error: 'OAuth failed', detail: err.message });
  }
});

// Bluesky OAuth callback
app.get('/api/auth/bluesky/callback', async (req, res) => {
  if (!oauthClient) return res.status(503).send('OAuth not available');

  try {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const { session } = await oauthClient.callback(params);
    const did = session.did;

    // Try to get profile for display name and handle
    let handle = did;
    let displayName = '';
    try {
      const agent = await oauthClient.restore(did);
      // Use the ATProto API to get profile
      const { BskyAgent } = await import('@atproto/api');
      const bsky = new BskyAgent({ service: 'https://public.api.bsky.app' });
      const profile = await bsky.getProfile({ actor: did });
      handle = profile.data.handle;
      displayName = profile.data.displayName || handle;
    } catch (e) {
      console.log('Could not fetch profile:', e.message);
    }

    // Find or create wallet for this DID
    let wallet = db.prepare('SELECT * FROM wallets WHERE did = ?').get(did);
    if (!wallet) {
      // Check if there's an anonymous wallet from this browser session (via state param)
      // For now, just create a new wallet
      const id = crypto.randomBytes(8).toString('hex');
      const token = crypto.randomBytes(32).toString('hex');
      const email = `${handle}@bsky.social`;
      db.prepare('INSERT INTO wallets (id, email, name, token, did, handle) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, displayName, token, did, handle);
      wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
    }

    // Redirect to login-success page with token (popup will postMessage to opener)
    const successUrl = `${config.nodeUrl}/login-success.html?token=${wallet.token}&name=${encodeURIComponent(wallet.name || handle)}&handle=${encodeURIComponent(handle)}&did=${encodeURIComponent(did)}&balance=${wallet.balance}`;
    res.redirect(successUrl);
  } catch (err) {
    console.error('Bluesky callback error:', err);
    res.redirect(`${config.nodeUrl}/login.html?error=${encodeURIComponent(err.message)}`);
  }
});

// Link Bluesky DID to existing wallet
app.post('/api/wallet/link-bluesky', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { did, handle } = req.body;
  if (!did) return res.status(400).json({ error: 'did required' });

  const other = db.prepare('SELECT id FROM wallets WHERE did = ? AND id != ?').get(did, req.wallet.id);
  if (other) {
    return res.status(409).json({ error: 'DID already linked to another wallet' });
  }

  db.prepare('UPDATE wallets SET did = ?, handle = ? WHERE id = ?')
    .run(did, handle || '', req.wallet.id);
  res.json({ success: true, did, handle });
});

// Auth status check (for widget to know if user is logged in)
app.get('/api/auth/status', (req, res) => {
  if (!req.wallet) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    balance: req.wallet.balance,
    name: req.wallet.name,
    handle: req.wallet.handle || null,
    did: req.wallet.did || null,
    hasFunds: req.wallet.balance > 0,
  });
});

// ── Author dashboard ────────────────────────────────────────

app.get('/api/author/:slug/dashboard', (req, res) => {
  const author = db.prepare('SELECT * FROM authors WHERE slug = ?').get(req.params.slug);
  if (!author) return res.status(404).json({ error: 'author not found' });

  const tips = db.prepare(`
    SELECT t.amount, t.author_amount, t.subject_amount, t.source, t.created_at,
           w.name as tipper_name, w.handle as tipper_handle
    FROM tips t LEFT JOIN wallets w ON t.wallet_id = w.id
    WHERE t.author_slug = ? AND t.status = 'completed'
    ORDER BY t.created_at DESC LIMIT 100
  `).all(req.params.slug);

  const pendingPledges = db.prepare(`
    SELECT p.amount, p.author_amount, p.created_at,
           w.name as pledger_name, w.handle as pledger_handle
    FROM pledges p LEFT JOIN wallets w ON p.wallet_id = w.id
    WHERE p.author_slug = ? AND p.status = 'pending'
    ORDER BY p.created_at DESC
  `).all(req.params.slug);

  const stats = db.prepare(`
    SELECT count(*) as tip_count, sum(author_amount) as total_received
    FROM tips WHERE author_slug = ? AND status = 'completed'
  `).get(req.params.slug);

  const pledgeStats = db.prepare(`
    SELECT count(*) as pledge_count, sum(amount) as total_pledged
    FROM pledges WHERE author_slug = ? AND status = 'pending'
  `).get(req.params.slug);

  res.json({
    author: { slug: author.slug, name: author.name, created_at: author.created_at },
    tips,
    pendingPledges,
    stats: {
      tipCount: stats.tip_count,
      totalReceived: stats.total_received || 0,
      pledgeCount: pledgeStats.pledge_count,
      totalPledged: pledgeStats.total_pledged || 0,
    },
  });
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

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`SimpleTip backend on http://127.0.0.1:${PORT}`);
  console.log(`Mode: ${config.demoMode ? 'DEMO' : 'LIVE'}`);
  const enabled = Object.entries(config.payments).filter(([, v]) => v.enabled).map(([k]) => k);
  console.log(`Payment methods: ${enabled.length ? enabled.join(', ') : 'none (demo mode — all simulated)'}`);
  await setupBlueskyOAuth();
});
