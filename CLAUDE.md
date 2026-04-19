# SimpleTip — Developer Context

## What this is

SimpleTip is a one-click tipping abstraction layer. An embeddable web component (`<simple-tip>`) that sits on any website — the reader never leaves the page. Fund a wallet once, tip everywhere. Not a platform like Ko-fi or Patreon — it's infrastructure that works with any payout method.

Anyone can run a SimpleTip node. Each node handles payments with whatever methods work in their region. Payouts are published as LinkedClaims attestations on ATProto for verifiability.

## Architecture

- **Frontend:** Vanilla JS web component with Shadow DOM (`public/simpletip.js`). Zero dependencies. All other pages are plain HTML.
- **Backend:** Python 3.12 / FastAPI / uvicorn (`backend/app.py`). Single-file API.
- **Database:** PostgreSQL 15+ on VM 100 (10.0.0.100). Schema in `backend/schema.sql`.
- **Config:** Pydantic Settings from `backend/.env`. See `backend/.env.example` and `backend/config.py`.

## Key files

| File | What |
|------|------|
| `backend/app.py` | All API endpoints — wallets, tips, receivers, payouts, funding |
| `backend/schema.sql` | Full Postgres schema (15 tables) |
| `backend/config.py` | Pydantic Settings model — env var names must match field names |
| `backend/db.py` | asyncpg connection pool |
| `backend/encryption.py` | AES-256-GCM for payout method details |
| `backend/atproto_publisher.py` | Publish tip attestations to ATProto |
| `public/simpletip.js` | The embeddable web component (Shadow DOM) |
| `public/nav.js` | Shared navigation bar injected into all pages |
| `public/index.html` | Demo page with live widget examples |
| `public/setup.html` | Receiver registration flow |
| `public/dashboard.html` | Receiver dashboard (tips, payouts, embed codes) |
| `public/fund.html` | Wallet funding page |
| `public/login.html` | Sign in (Bluesky handle or email) |

## Money model

**Double-entry ledger.** Every money movement creates two `wallet_transactions` entries:
- Tip: debit donor wallet (type=`tip`, negative), credit receiver wallet (type=`tip_received`, positive)
- Funding: credit donor wallet (type=`fund`, positive)
- Payout: debit receiver wallet (type=`payout`, negative)

Every transaction row has `balance_after_cents` for audit trail.

**Wallets are universal.** Donors get wallets automatically on first tip. Receivers get wallets when they register through setup flow. A user can be both donor and receiver — their wallet balance can come from funding OR received tips, and they can use it to tip others.

**Receiver = payout capability.** The `receivers` table has a `wallet_id` FK. Only set during deliberate registration via `/setup.html`. Not every wallet holder is a receiver.

**Payout limits:** $10 minimum, $600/year cap per receiver (below 1099 threshold). Tracked by `sum(payouts)` where `initiated_at >= date_trunc('year', now())`. Stripe Connect receivers will bypass this (not yet implemented).

## Running locally

```bash
cd backend
source venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8046 --reload
```

The venv and DB are already set up on VM 200. See INSTALL.md for fresh setup.

## Deployment (VM 200)

- **systemd:** `tmp-simpletip-backend.service` — uvicorn on :8046
- **nginx:** `/etc/nginx/app-proxies/simpletip.conf` — proxies `/simpletip/api/` to :8046, serves `/simpletip/` static files from `public/`
- **DB:** `simpletip` on Postgres VM 100 (user: simpletip)
- **Demo URL:** https://demos.linkedtrust.us/simpletip/

## API prefix

All API routes are under `/api/`. The frontend JS uses `const API = '/simpletip/api'` — nginx strips the `/simpletip` prefix before proxying.

## Security

- Wallet auth: 64-char hex token in `Authorization: Bearer` header, stored in localStorage
- Payout method details encrypted at rest with AES-256-GCM (`backend/encryption.py`)
- Same-origin policy prevents cross-site token theft (widget runs in Shadow DOM but shares origin)
- Payout requests require Bearer token matching the receiver's linked wallet

## Don't

- Don't modify the core wallet/ledger transaction model without understanding the double-entry invariants
- Don't auto-create wallets for receivers — only donors get auto-wallets, receivers must register
- Don't store secrets in files that get committed (`.env` is in `.gitignore`)
- Don't use `SIMPLETIP_` prefix on env vars — Pydantic maps env var names directly to field names (e.g. `DATABASE_URL` not `SIMPLETIP_DATABASE_URL`)
