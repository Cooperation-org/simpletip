# SimpleTip — Installation Guide

Run your own SimpleTip tipping node. This guide covers everything from database setup to production deployment.

## Requirements

- **Python** 3.11+ (3.12 recommended)
- **PostgreSQL** 15+ with `pgcrypto` extension
- **Stripe account** (for real payments — optional for demo mode)
- **Reverse proxy** (nginx, Caddy, or similar — for HTTPS)

## 1. Database Setup

Create a Postgres database and user:

```sql
-- Run as a Postgres superuser
CREATE USER simpletip WITH PASSWORD 'your-secure-password';
CREATE DATABASE simpletip OWNER simpletip;
```

Apply the schema:

```bash
psql -h <host> -U simpletip -d simpletip -f backend/schema.sql
```

This creates all 15 tables (receivers, wallets, tips, etc.) with indexes.

## 2. Generate Encryption Key

Payout method details (bank accounts, crypto addresses, phone numbers) are encrypted at rest using AES-256-GCM. Generate a key:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Save this key securely. If you lose it, encrypted payout details become unrecoverable.

## 3. Backend Setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Environment Variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | `postgres://simpletip:pass@host:5432/simpletip` |
| `ENCRYPTION_KEY` | Yes | 64-char hex string from step 2 |
| `PORT` | No | Backend port (default: 8046) |
| `SIMPLETIP_NODE_URL` | No | Public URL of your node |
| `SIMPLETIP_NODE_NAME` | No | Display name (default: `SimpleTip by LinkedTrust`) |
| `DEMO_MODE` | No | Set to `true` to force demo mode even with Stripe keys |
| `STRIPE_SECRET_KEY` | No | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_PUBLISHABLE_KEY` | No | Stripe publishable key (`pk_test_...` or `pk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signing secret (`whsec_...`) |

**Demo mode**: If no Stripe keys are configured (or `DEMO_MODE=true`), the backend runs in demo mode — all payments are simulated. Good for development and testing.

### Run locally

```bash
source venv/bin/activate
uvicorn app:app --host 0.0.0.0 --port 8046
```

Or with auto-reload for development:

```bash
uvicorn app:app --host 0.0.0.0 --port 8046 --reload
```

## 4. Stripe Configuration (for real payments)

1. Create a Stripe account at https://stripe.com
2. Get your API keys from the Stripe Dashboard → Developers → API keys
3. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`
4. Set up a webhook endpoint:
   - URL: `https://your-domain.com/api/webhook/stripe`
   - Events: `checkout.session.completed`
   - Copy the signing secret to `STRIPE_WEBHOOK_SECRET`

Test mode keys (`sk_test_...`) work with test card numbers. Switch to live keys when ready.

## 5. Reverse Proxy (nginx)

Example nginx config for path-prefix deployment:

```nginx
location /simpletip/ {
    proxy_pass http://127.0.0.1:8046/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Or for a dedicated domain:

```nginx
server {
    listen 80;
    server_name tips.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8046;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 6. systemd Service

Create `/etc/systemd/system/simpletip.service`:

```ini
[Unit]
Description=SimpleTip tipping backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/simpletip/backend
ExecStart=/path/to/simpletip/backend/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8046
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/simpletip/backend/.env
# Or set directly:
# Environment=DATABASE_URL=postgres://simpletip:pass@localhost:5432/simpletip
# Environment=ENCRYPTION_KEY=<your-key>
# Environment=SIMPLETIP_NODE_URL=https://tips.yourdomain.com
# Environment=SIMPLETIP_NODE_NAME=Your Node Name
# Environment=STRIPE_SECRET_KEY=sk_live_...
# Environment=STRIPE_PUBLISHABLE_KEY=pk_live_...
# Environment=STRIPE_WEBHOOK_SECRET=whsec_...

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable simpletip
sudo systemctl start simpletip
```

## 7. Embed the Widget

Once your node is running and you've registered receivers via the setup page or API:

```html
<script src="https://tips.yourdomain.com/simpletip.js"></script>
<simple-tip
  receiver="receiver-slug"
  receiver-name="Receiver Name">
</simple-tip>
```

Split tips between two receivers:

```html
<simple-tip
  receiver="author-slug"
  receiver-name="Author Name"
  subject="subject-slug"
  subject-label="Subject Name">
</simple-tip>
```

## API Quick Reference

### Register a receiver
```bash
curl -X POST https://your-node/api/receiver/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane Doe","email":"jane@example.com","type":"individual"}'
```

### Add payout method
```bash
curl -X POST https://your-node/api/receiver/jane-doe/payout-method \
  -H 'Content-Type: application/json' \
  -d '{"methodType":"paypal","details":{"paypal_email":"jane@example.com"}}'
```

Available method types: `ach`, `zelle`, `venmo`, `paypal`, `moneygram`, `mpesa`, `usdt_eth`, `tether`

### Check health
```bash
curl https://your-node/api/health
```

## Security Notes

- **Encryption key**: Back it up. Losing it = losing access to all stored payout details.
- **Database**: Use a strong password. Restrict network access to the backend host only.
- **Stripe webhook**: Always set `STRIPE_WEBHOOK_SECRET` in production to verify webhook signatures.
- **HTTPS**: Required for production. Stripe won't work without it.
- **Admin endpoints**: `/api/admin/*` currently have no auth — add authentication before production use.
- **Production deployment**: Run on an isolated VM/server. Financial data should not share infrastructure with other applications.

## Payout Method Fields

Each method type requires specific fields in the `details` object:

| Method | Fields |
|--------|--------|
| `ach` | `routing_number`, `account_number`, `account_holder_name`, `bank_name` |
| `zelle` | `email_or_phone` |
| `venmo` | `venmo_handle` |
| `paypal` | `paypal_email` |
| `moneygram` | `full_name`, `country`, `city`, `phone` |
| `mpesa` | `phone_number`, `country_code` |
| `usdt_eth` | `eth_address` |
| `tether` | `address`, `network` |
