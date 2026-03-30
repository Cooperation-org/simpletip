-- SimpleTip Database Schema
-- Postgres 15+
-- Run: psql -h <host> -U simpletip -d simpletip -f schema.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- RECEIVERS (tip recipients — authors, subjects, orgs)
-- ============================================================
CREATE TABLE receivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    type TEXT NOT NULL DEFAULT 'individual',
    bio TEXT,
    avatar_url TEXT,
    wallet_id UUID REFERENCES wallets(id),
    payout_threshold_cents BIGINT DEFAULT 1000,
    total_received_cents BIGINT DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_receivers_email ON receivers(email);
CREATE INDEX idx_receivers_status ON receivers(status);

-- ============================================================
-- RECEIVER PAYOUT METHODS (encrypted details)
-- ============================================================
CREATE TABLE receiver_payout_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receiver_id UUID NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
    method_type TEXT NOT NULL,
    details_encrypted BYTEA NOT NULL,
    is_preferred BOOLEAN NOT NULL DEFAULT false,
    verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(receiver_id, method_type)
);

CREATE INDEX idx_payout_methods_receiver ON receiver_payout_methods(receiver_id);

-- ============================================================
-- ARTICLES (pages where widget is embedded, auto-created)
-- ============================================================
CREATE TABLE articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uri TEXT UNIQUE NOT NULL,
    title TEXT,
    site_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ARTICLE <-> RECEIVER links
-- ============================================================
CREATE TABLE article_receivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'author',
    default_split_pct INTEGER NOT NULL DEFAULT 50,
    UNIQUE(article_id, receiver_id)
);

CREATE INDEX idx_article_receivers_article ON article_receivers(article_id);
CREATE INDEX idx_article_receivers_receiver ON article_receivers(receiver_id);

-- ============================================================
-- WALLETS (tipper/donor accounts)
-- ============================================================
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT UNIQUE NOT NULL,
    balance_cents BIGINT NOT NULL DEFAULT 0,
    total_funded_cents BIGINT NOT NULL DEFAULT 0,
    total_tipped_cents BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- WALLET CONTACTS (all optional sender info)
-- ============================================================
CREATE TABLE wallet_contacts (
    wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
    email TEXT,
    name TEXT,
    phone TEXT,
    handle TEXT,
    did TEXT,
    display_name TEXT,
    anonymous BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_wallet_contacts_email ON wallet_contacts(email);
CREATE INDEX idx_wallet_contacts_did ON wallet_contacts(did);

-- ============================================================
-- WALLET TRANSACTIONS (full ledger — source of truth for balance)
-- ============================================================
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    type TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    balance_after_cents BIGINT NOT NULL,
    reference_id UUID,
    reference_type TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_tx_created ON wallet_transactions(created_at);
CREATE INDEX idx_wallet_tx_type ON wallet_transactions(type);

-- ============================================================
-- FUNDING (money into wallets)
-- ============================================================
CREATE TABLE funding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    amount_cents BIGINT NOT NULL,
    method TEXT NOT NULL,
    payment_provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_funding_wallet ON funding(wallet_id);
CREATE INDEX idx_funding_status ON funding(status);

-- ============================================================
-- TIPS (core transaction)
-- ============================================================
CREATE TABLE tips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES wallets(id),
    article_id UUID REFERENCES articles(id),
    page_url TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    comment TEXT,
    source TEXT NOT NULL DEFAULT 'wallet',
    payment_provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    atproto_uri TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tips_wallet ON tips(wallet_id);
CREATE INDEX idx_tips_article ON tips(article_id);
CREATE INDEX idx_tips_created ON tips(created_at);
CREATE INDEX idx_tips_status ON tips(status);

-- ============================================================
-- TIP SPLITS (how each tip divides among receivers)
-- ============================================================
CREATE TABLE tip_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tip_id UUID NOT NULL REFERENCES tips(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES receivers(id),
    amount_cents BIGINT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary'
);

CREATE INDEX idx_tip_splits_tip ON tip_splits(tip_id);
CREATE INDEX idx_tip_splits_receiver ON tip_splits(receiver_id);

-- ============================================================
-- PAYOUTS (money out to receivers)
-- ============================================================
CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receiver_id UUID NOT NULL REFERENCES receivers(id),
    payout_method_id UUID NOT NULL REFERENCES receiver_payout_methods(id),
    amount_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_reference TEXT,
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    atproto_uri TEXT
);

CREATE INDEX idx_payouts_receiver ON payouts(receiver_id);
CREATE INDEX idx_payouts_status ON payouts(status);

-- ============================================================
-- PLEDGES (intent to tip, fulfilled after funding)
-- ============================================================
CREATE TABLE pledges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    article_id UUID REFERENCES articles(id),
    page_url TEXT,
    amount_cents BIGINT NOT NULL,
    comment TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    fulfilled_tip_id UUID REFERENCES tips(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pledges_wallet ON pledges(wallet_id);
CREATE INDEX idx_pledges_status ON pledges(status);

-- ============================================================
-- PLEDGE SPLITS
-- ============================================================
CREATE TABLE pledge_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pledge_id UUID NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES receivers(id),
    amount_cents BIGINT NOT NULL,
    role TEXT NOT NULL DEFAULT 'primary'
);

CREATE INDEX idx_pledge_splits_pledge ON pledge_splits(pledge_id);
CREATE INDEX idx_pledge_splits_receiver ON pledge_splits(receiver_id);

-- ============================================================
-- ARTICLE EVENTS (impressions + interaction tracking)
-- ============================================================
CREATE TABLE article_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id UUID NOT NULL REFERENCES articles(id),
    event_type TEXT NOT NULL,
    wallet_id UUID REFERENCES wallets(id),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_article_events_article ON article_events(article_id);
CREATE INDEX idx_article_events_type ON article_events(event_type);
CREATE INDEX idx_article_events_created ON article_events(created_at);

-- ============================================================
-- ARTICLE STATS (daily rollup for dashboards)
-- ============================================================
CREATE TABLE article_stats_daily (
    article_id UUID NOT NULL REFERENCES articles(id),
    day DATE NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    unique_visitors INTEGER NOT NULL DEFAULT 0,
    tips_started INTEGER NOT NULL DEFAULT 0,
    tips_completed INTEGER NOT NULL DEFAULT 0,
    pledges INTEGER NOT NULL DEFAULT 0,
    total_tipped_cents BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY(article_id, day)
);
