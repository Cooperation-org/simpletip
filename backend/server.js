/**
 * SimpleTip Backend
 *
 * Simple ledger + payment processing for tips.
 * Port: 8046
 *
 * Tables:
 *   authors — registered content creators with payout preferences
 *   wallets — reader accounts with balances
 *   tips    — every tip (funded or pending)
 *   funding — wallet top-ups
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const PORT = 8046;
const DB_PATH = path.join(__dirname, 'simpletip.db');

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
    stripe_session TEXT,
    status TEXT DEFAULT 'completed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (author_slug) REFERENCES authors(slug)
  );

  CREATE TABLE IF NOT EXISTS funding (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    wallet_id TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL DEFAULT 'stripe',
    stripe_session TEXT,
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
  res.json({ status: 'ok', authors: authorCount, tips: tipCount, wallets: walletCount });
});

// ── Author registration ─────────────────────────────────────

app.post('/api/author/register', (req, res) => {
  const { name, email, payoutMethod, payoutAddress } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });

  // Generate slug from name
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Check if slug exists, append number if so
  const existing = db.prepare('SELECT slug FROM authors WHERE slug = ?').get(slug);
  if (existing) {
    const count = db.prepare("SELECT count(*) as n FROM authors WHERE slug LIKE ?").get(slug + '%').n;
    slug = slug + '-' + (count + 1);
  }

  // Check if email exists
  const byEmail = db.prepare('SELECT * FROM authors WHERE email = ?').get(email);
  if (byEmail) {
    return res.json({ slug: byEmail.slug, name: byEmail.name, existing: true });
  }

  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO authors (id, slug, name, email, payout_method, payout_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, slug, name, email, payoutMethod || 'paypal', payoutAddress || '');

  res.json({ slug, name, id });
});

// Get author info (public)
app.get('/api/author/:slug', (req, res) => {
  const author = db.prepare('SELECT slug, name, total_received, created_at FROM authors WHERE slug = ?')
    .get(req.params.slug);
  if (!author) return res.status(404).json({ error: 'author not found' });

  const tipCount = db.prepare('SELECT count(*) as n FROM tips WHERE author_slug = ?').get(req.params.slug).n;
  res.json({ ...author, tipCount });
});

// ── Wallet ──────────────────────────────────────────────────

// Quick wallet creation (email only — magic link later)
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

// Get wallet balance
app.get('/api/wallet', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  res.json({
    balance: req.wallet.balance,
    totalFunded: req.wallet.total_funded,
    totalTipped: req.wallet.total_tipped,
    name: req.wallet.name,
  });
});

// ── Tipping ─────────────────────────────────────────────────

// Tip from wallet balance (one click!)
app.post('/api/tip', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });

  const { author, subject, amount, splitPct } = req.body;
  if (!author || !amount || amount <= 0) return res.status(400).json({ error: 'author and amount required' });

  // Check balance
  if (req.wallet.balance < amount) {
    return res.status(402).json({ error: 'insufficient_funds', balance: req.wallet.balance });
  }

  // Verify author exists
  const authorRow = db.prepare('SELECT * FROM authors WHERE slug = ?').get(author);
  if (!authorRow) return res.status(404).json({ error: 'author not found' });

  // Calculate split
  const pct = subject && splitPct != null ? splitPct : 100;
  const authorAmount = Math.round(amount * pct) / 100;
  const subjectAmount = subject ? Math.round(amount * (100 - pct)) / 100 : 0;

  // Execute in transaction
  const tipId = crypto.randomBytes(8).toString('hex');
  const exec = db.transaction(() => {
    // Debit wallet
    db.prepare('UPDATE wallets SET balance = balance - ?, total_tipped = total_tipped + ? WHERE id = ?')
      .run(amount, amount, req.wallet.id);

    // Credit author
    db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
      .run(authorAmount, author);

    // If subject is also a registered author, credit them too
    if (subject) {
      db.prepare('UPDATE authors SET total_received = total_received + ? WHERE slug = ?')
        .run(subjectAmount, subject);
    }

    // Record tip
    db.prepare(`
      INSERT INTO tips (id, wallet_id, author_slug, subject_slug, amount, author_amount, subject_amount, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'wallet')
    `).run(tipId, req.wallet.id, author, subject || null, amount, authorAmount, subjectAmount);
  });
  exec();

  // Get updated balance
  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);

  res.json({
    success: true,
    tipId,
    amount,
    authorAmount,
    subjectAmount,
    balance: updated.balance,
  });
});

// Anonymous tip via Stripe checkout (no wallet needed)
app.post('/api/tip/checkout', (req, res) => {
  const { author, authorName, subject, subjectName, amount, splitPct, returnUrl } = req.body;
  if (!author || !amount) return res.status(400).json({ error: 'author and amount required' });

  // For now: simulate Stripe checkout URL
  // In production: create a real Stripe Checkout Session
  // const session = await stripe.checkout.sessions.create({...})

  const sessionId = crypto.randomBytes(16).toString('hex');
  const tipDesc = subject
    ? `$${amount} tip split: ${authorName || author} + ${subjectName || subject}`
    : `$${amount} tip for ${authorName || author}`;

  // Store pending tip
  const tipId = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO tips (id, author_slug, subject_slug, amount, author_amount, subject_amount, source, stripe_session, status)
    VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, 'pending')
  `).run(
    tipId, author, subject || null, amount,
    subject && splitPct != null ? Math.round(amount * splitPct) / 100 : amount,
    subject && splitPct != null ? Math.round(amount * (100 - splitPct)) / 100 : 0,
    sessionId,
  );

  // For demo: return a simulated checkout page on our domain
  // In production: return Stripe's hosted checkout URL
  const checkoutUrl = `${returnUrl ? new URL(returnUrl).origin : ''}/simpletip/checkout.html?session=${sessionId}&amount=${amount}&author=${encodeURIComponent(authorName || author)}&tip=${tipId}`;

  res.json({ checkoutUrl, sessionId, tipId });
});

// Confirm a checkout (called by our checkout page or Stripe webhook)
app.post('/api/tip/confirm', (req, res) => {
  const { tipId, sessionId } = req.body;

  const tip = db.prepare('SELECT * FROM tips WHERE id = ? AND stripe_session = ? AND status = ?')
    .get(tipId, sessionId, 'pending');
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

// Add funds to wallet (simulate for demo, Stripe in production)
app.post('/api/wallet/fund', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });

  const fundId = crypto.randomBytes(8).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE wallets SET balance = balance + ?, total_funded = total_funded + ? WHERE id = ?')
      .run(amount, amount, req.wallet.id);
    db.prepare("INSERT INTO funding (id, wallet_id, amount, method, status) VALUES (?, ?, ?, 'demo', 'completed')")
      .run(fundId, req.wallet.id, amount);
  })();

  const updated = db.prepare('SELECT balance FROM wallets WHERE id = ?').get(req.wallet.id);
  res.json({ success: true, balance: updated.balance });
});

// Get tip history for a wallet
app.get('/api/wallet/tips', (req, res) => {
  if (!req.wallet) return res.status(401).json({ error: 'not authenticated' });
  const tips = db.prepare(`
    SELECT t.*, a.name as author_name
    FROM tips t
    LEFT JOIN authors a ON t.author_slug = a.slug
    WHERE t.wallet_id = ?
    ORDER BY t.created_at DESC
    LIMIT 50
  `).all(req.wallet.id);
  res.json(tips);
});

// ── Leaderboard / public stats ──────────────────────────────

app.get('/api/stats', (req, res) => {
  const totalTips = db.prepare("SELECT count(*) as n, sum(amount) as total FROM tips WHERE status = 'completed'").get();
  const topAuthors = db.prepare(`
    SELECT slug, name, total_received, (SELECT count(*) FROM tips WHERE author_slug = authors.slug) as tip_count
    FROM authors WHERE total_received > 0
    ORDER BY total_received DESC LIMIT 10
  `).all();
  res.json({
    totalTips: totalTips.n,
    totalAmount: totalTips.total || 0,
    topAuthors,
  });
});

// ── Start ────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SimpleTip backend on http://127.0.0.1:${PORT}`);
});
