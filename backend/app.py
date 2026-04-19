"""
SimpleTip Backend — FastAPI

Port: 8046
"""

import asyncio
import logging
import secrets
from contextlib import asynccontextmanager
from typing import Optional
from urllib.parse import urlparse

import stripe as stripe_lib
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db
import encryption
import atproto_oauth
from config import settings

log = logging.getLogger("simpletip")

# ── Stripe setup ─────────────────────────────────────────────

if settings.stripe_enabled:
    stripe_lib.api_key = settings.stripe_secret_key


# ── Lifespan ─────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    mode = "DEMO" if settings.is_demo else "LIVE"
    print(f"SimpleTip backend started — {mode} mode")
    print(f"DB: {settings.database_url.split('@')[-1] if '@' in settings.database_url else 'configured'}")
    yield
    await db.close_pool()


app = FastAPI(title="SimpleTip", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ──────────────────────────────────────────────────

def canonicalize_uri(url: str) -> str:
    try:
        p = urlparse(url)
        path = p.path.rstrip("/") or "/"
        return f"{p.scheme}://{p.netloc}{path}"
    except Exception:
        return url


async def get_wallet(authorization: Optional[str] = None):
    """Extract wallet from Bearer token. Returns None if not authenticated."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    return await db.fetch_one("SELECT * FROM wallets WHERE token = $1", token)


def cents_to_dollars(c) -> float:
    return int(c) / 100


async def _publish_tip_safe(tip_id):
    """Fire-and-forget ATProto publish — never raises."""
    try:
        from atproto_publisher import publish_tip
        async with db.pool.acquire() as conn:
            await publish_tip(tip_id, conn)
    except Exception:
        log.exception("ATProto publish failed for tip %s (non-fatal)", tip_id)


# ── Pydantic models ──────────────────────────────────────────

class ReceiverRegister(BaseModel):
    name: str
    email: str
    type: str = "individual"
    bio: str | None = None
    wallet_token: str | None = None

class PayoutMethodAdd(BaseModel):
    method_type: str
    details: dict

class WalletCreate(BaseModel):
    email: str | None = None
    name: str | None = None

class WalletContact(BaseModel):
    email: str | None = None
    name: str | None = None
    phone: str | None = None
    handle: str | None = None
    display_name: str | None = None
    anonymous: bool | None = None

class FundRequest(BaseModel):
    amount: float
    method: str | None = None

class TipSplit(BaseModel):
    slug: str
    pct: int
    role: str = "primary"

class TipRequest(BaseModel):
    receivers: list[TipSplit]
    amount: float
    comment: str | None = None
    page_url: str

class PledgeRequest(BaseModel):
    receivers: list[TipSplit]
    amount: float
    comment: str | None = None
    page_url: str | None = None

class WidgetLoad(BaseModel):
    page_url: str
    page_title: str | None = None
    site_name: str | None = None
    receivers: list[str]

class RecoverRequest(BaseModel):
    email: str

class TipConfirm(BaseModel):
    tip_id: str

class AdminConfirmFunding(BaseModel):
    fund_id: str

class AdminConfirmPayout(BaseModel):
    payout_id: str
    provider_reference: str | None = None


# ── Health ───────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    receivers = await db.fetch_val("SELECT count(*) FROM receivers")
    tips = await db.fetch_val("SELECT count(*) FROM tips")
    wallets = await db.fetch_val("SELECT count(*) FROM wallets")
    return {
        "status": "ok",
        "node": settings.node_name,
        "demoMode": settings.is_demo,
        "receivers": receivers,
        "tips": tips,
        "wallets": wallets,
    }


# ── Payment methods ──────────────────────────────────────────

@app.get("/api/methods")
async def get_methods():
    methods = []
    if settings.stripe_enabled or settings.is_demo:
        m = {"id": "stripe", "label": "Card / Apple Pay / Google Pay", "icon": "card"}
        if settings.stripe_publishable_key:
            m["publishableKey"] = settings.stripe_publishable_key
        methods.append(m)
    if settings.is_demo and not methods:
        methods = [
            {"id": "stripe", "label": "Card / Apple Pay / Google Pay", "icon": "card"},
            {"id": "paypal", "label": "PayPal / Venmo", "icon": "paypal"},
            {"id": "zelle", "label": "Zelle", "icon": "zelle"},
        ]
    return {"methods": methods, "demoMode": settings.is_demo}


# ── Receiver registration ───────────────────────────────────

PAYOUT_METHOD_FIELDS = {
    "ach": ["routing_number", "account_number", "account_holder_name", "bank_name", "street_address"],
    "zelle": ["email_or_phone"],
    "venmo": ["venmo_handle"],
    "paypal": ["paypal_email"],
    "moneygram": ["full_name", "country", "city", "phone"],
    "mpesa": ["phone_number", "country_code"],
    "usdt_eth": ["eth_address"],
    "tether": ["address", "network"],
}


@app.post("/api/receiver/register")
async def register_receiver(body: ReceiverRegister, authorization: Optional[str] = Header(None)):
    import re
    slug = re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-")

    existing = await db.fetch_one("SELECT slug, name, wallet_id FROM receivers WHERE email = $1", body.email)
    if existing:
        # If receiver exists but has no wallet, link one now
        if not existing["wallet_id"]:
            wallet = await get_wallet(authorization)
            if wallet:
                await db.execute("UPDATE receivers SET wallet_id = $1 WHERE email = $2", wallet["id"], body.email)
        return {"slug": existing["slug"], "name": existing["name"], "existing": True}

    slug_check = await db.fetch_one("SELECT slug FROM receivers WHERE slug = $1", slug)
    if slug_check:
        count = await db.fetch_val("SELECT count(*) FROM receivers WHERE slug LIKE $1", slug + "%")
        slug = f"{slug}-{count + 1}"

    # Link to existing wallet or create one
    wallet = await get_wallet(authorization)
    wallet_id = wallet["id"] if wallet else None
    if not wallet_id:
        # Create a wallet for this receiver
        token = secrets.token_hex(32)
        async with db.pool.acquire() as conn:
            async with conn.transaction():
                w = await conn.fetchrow("INSERT INTO wallets (token) VALUES ($1) RETURNING id, token", token)
                wallet_id = w["id"]
                await conn.execute(
                    "INSERT INTO wallet_contacts (wallet_id, email, name, display_name) VALUES ($1, $2, $3, $4)",
                    wallet_id, body.email, body.name, body.name,
                )

    row = await db.fetch_one(
        "INSERT INTO receivers (slug, name, email, type, bio, wallet_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, slug, name",
        slug, body.name, body.email, body.type, body.bio, wallet_id,
    )
    return dict(row)


@app.get("/api/receiver/{slug}")
async def get_receiver(slug: str):
    r = await db.fetch_one(
        "SELECT slug, name, type, bio, avatar_url, total_received_cents, created_at "
        "FROM receivers WHERE slug = $1 AND status = 'active'",
        slug,
    )
    if not r:
        raise HTTPException(404, "receiver not found")
    tip_count = await db.fetch_val(
        "SELECT count(*) FROM tip_splits WHERE receiver_id = (SELECT id FROM receivers WHERE slug = $1)",
        slug,
    )
    return {**dict(r), "tipCount": tip_count}


# ── Receiver payout methods ─────────────────────────────────

@app.post("/api/receiver/{slug}/payout-method")
async def add_payout_method(slug: str, body: PayoutMethodAdd):
    allowed = PAYOUT_METHOD_FIELDS.get(body.method_type)
    if not allowed:
        raise HTTPException(400, f"unknown method: {body.method_type}. allowed: {list(PAYOUT_METHOD_FIELDS)}")

    missing = [f for f in allowed if not body.details.get(f)]
    if missing:
        raise HTTPException(400, f"missing fields: {missing}")

    receiver = await db.fetch_one("SELECT id FROM receivers WHERE slug = $1", slug)
    if not receiver:
        raise HTTPException(404, "receiver not found")

    receiver_id = receiver["id"]
    encrypted = encryption.encrypt(body.details)

    existing = await db.fetch_one(
        "SELECT id FROM receiver_payout_methods WHERE receiver_id = $1 AND method_type = $2",
        receiver_id, body.method_type,
    )

    if existing:
        await db.execute(
            "UPDATE receiver_payout_methods SET details_encrypted = $1 WHERE id = $2",
            encrypted, existing["id"],
        )
        return {"id": str(existing["id"]), "methodType": body.method_type, "updated": True}

    count = await db.fetch_val(
        "SELECT count(*) FROM receiver_payout_methods WHERE receiver_id = $1",
        receiver_id,
    )
    is_first = count == 0

    row = await db.fetch_one(
        "INSERT INTO receiver_payout_methods (receiver_id, method_type, details_encrypted, is_preferred) "
        "VALUES ($1, $2, $3, $4) RETURNING id",
        receiver_id, body.method_type, encrypted, is_first,
    )
    return {"id": str(row["id"]), "methodType": body.method_type, "isPreferred": is_first}


@app.get("/api/receiver/{slug}/payout-methods")
async def list_payout_methods(slug: str):
    rows = await db.fetch_all(
        "SELECT m.id, m.method_type, m.is_preferred, m.verified, m.details_encrypted, m.created_at "
        "FROM receiver_payout_methods m JOIN receivers r ON r.id = m.receiver_id "
        "WHERE r.slug = $1 ORDER BY m.is_preferred DESC, m.created_at",
        slug,
    )
    return [
        {
            "id": str(r["id"]),
            "methodType": r["method_type"],
            "isPreferred": r["is_preferred"],
            "verified": r["verified"],
            "maskedDetails": encryption.masked_details(r["details_encrypted"]),
            "createdAt": r["created_at"].isoformat(),
        }
        for r in rows
    ]


# ── Widget load ──────────────────────────────────────────────

@app.post("/api/widget/load")
async def widget_load(body: WidgetLoad, authorization: Optional[str] = Header(None)):
    if not body.receivers:
        raise HTTPException(400, "receivers[] required")

    # Validate receivers exist and have payout methods
    placeholders = ", ".join(f"${i+1}" for i in range(len(body.receivers)))
    rows = await db.fetch_all(
        f"SELECT r.id, r.slug, r.name, r.avatar_url, "
        f"(SELECT count(*) FROM receiver_payout_methods WHERE receiver_id = r.id) AS method_count "
        f"FROM receivers r WHERE r.slug IN ({placeholders}) AND r.status = 'active'",
        *body.receivers,
    )

    found_slugs = {r["slug"] for r in rows}
    missing = [s for s in body.receivers if s not in found_slugs]
    if missing:
        raise HTTPException(404, f"unknown receivers: {missing}")

    no_payout = [r["slug"] for r in rows if r["method_count"] == 0]
    if no_payout:
        raise HTTPException(400, f"receivers without payout methods: {no_payout}")

    uri = canonicalize_uri(body.page_url)

    # Auto-create article
    article = await db.fetch_one("SELECT id FROM articles WHERE uri = $1", uri)
    if not article:
        article = await db.fetch_one(
            "INSERT INTO articles (uri, title, site_name) VALUES ($1, $2, $3) RETURNING id",
            uri, body.page_title, body.site_name,
        )
    article_id = article["id"]

    # Link receivers
    for i, r in enumerate(rows):
        role = "author" if i == 0 else "subject"
        split_pct = 100 if len(rows) == 1 else (50 if i == 0 else 50 // (len(rows) - 1))
        await db.execute(
            "INSERT INTO article_receivers (article_id, receiver_id, role, default_split_pct) "
            "VALUES ($1, $2, $3, $4) ON CONFLICT (article_id, receiver_id) DO NOTHING",
            article_id, r["id"], role, split_pct,
        )

    # Record impression
    wallet = await get_wallet(authorization)
    wallet_id = wallet["id"] if wallet else None
    await db.execute(
        "INSERT INTO article_events (article_id, event_type, wallet_id, metadata) "
        "VALUES ($1, 'impression', $2, $3)",
        article_id, wallet_id, "{}",
    )

    receiver_info = [{"slug": r["slug"], "name": r["name"], "avatarUrl": r["avatar_url"]} for r in rows]
    wallet_status = (
        {"authenticated": True, "balance": int(wallet["balance_cents"]), "hasFunds": wallet["balance_cents"] > 0}
        if wallet
        else {"authenticated": False}
    )

    return {"articleId": str(article_id), "receivers": receiver_info, "wallet": wallet_status}


# ── Wallet ───────────────────────────────────────────────────

@app.post("/api/wallet/create")
async def create_wallet(body: WalletCreate):
    if body.email:
        existing = await db.fetch_one(
            "SELECT w.token, w.balance_cents, wc.email, wc.name, wc.display_name "
            "FROM wallets w LEFT JOIN wallet_contacts wc ON wc.wallet_id = w.id "
            "WHERE wc.email = $1",
            body.email,
        )
        if existing:
            return {
                "token": existing["token"],
                "balance": int(existing["balance_cents"]),
                "name": existing["display_name"] or existing["name"] or "",
                "email": existing["email"],
                "existing": True,
            }

    token = secrets.token_hex(32)

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            wallet = await conn.fetchrow(
                "INSERT INTO wallets (token) VALUES ($1) RETURNING id, token, balance_cents",
                token,
            )
            if body.email or body.name:
                await conn.execute(
                    "INSERT INTO wallet_contacts (wallet_id, email, name, display_name) VALUES ($1, $2, $3, $4)",
                    wallet["id"], body.email, body.name, body.name,
                )

    return {"token": token, "balance": 0, "name": body.name or "", "email": body.email}


@app.get("/api/wallet")
async def get_wallet_info(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    contact = await db.fetch_one("SELECT * FROM wallet_contacts WHERE wallet_id = $1", wallet["id"])
    c = dict(contact) if contact else {}

    return {
        "balance": int(wallet["balance_cents"]),
        "totalFunded": int(wallet["total_funded_cents"]),
        "totalTipped": int(wallet["total_tipped_cents"]),
        "name": c.get("display_name") or c.get("name") or "",
        "email": c.get("email"),
        "handle": c.get("handle"),
        "did": c.get("did"),
        "anonymous": c.get("anonymous", False),
    }


@app.post("/api/wallet/contact")
async def update_wallet_contact(body: WalletContact, authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    await db.execute(
        "INSERT INTO wallet_contacts (wallet_id, email, name, phone, handle, display_name, anonymous) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "ON CONFLICT (wallet_id) DO UPDATE SET "
        "email = COALESCE(NULLIF($2, ''), wallet_contacts.email), "
        "name = COALESCE(NULLIF($3, ''), wallet_contacts.name), "
        "phone = COALESCE(NULLIF($4, ''), wallet_contacts.phone), "
        "handle = COALESCE(NULLIF($5, ''), wallet_contacts.handle), "
        "display_name = COALESCE(NULLIF($6, ''), wallet_contacts.display_name), "
        "anonymous = COALESCE($7, wallet_contacts.anonymous)",
        wallet["id"], body.email, body.name, body.phone, body.handle, body.display_name, body.anonymous,
    )
    return {"success": True}


@app.get("/api/wallet/history")
async def wallet_history(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    rows = await db.fetch_all(
        "SELECT id, type, amount_cents, balance_after_cents, description, created_at "
        "FROM wallet_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 100",
        wallet["id"],
    )
    return [
        {
            "id": str(r["id"]),
            "type": r["type"],
            "amount_cents": int(r["amount_cents"]),
            "balance_after_cents": int(r["balance_after_cents"]),
            "description": r["description"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


@app.post("/api/wallet/recover")
async def recover_wallet(body: RecoverRequest):
    row = await db.fetch_one(
        "SELECT w.token, w.balance_cents, wc.name, wc.display_name, wc.email "
        "FROM wallets w JOIN wallet_contacts wc ON wc.wallet_id = w.id WHERE wc.email = $1",
        body.email,
    )
    if not row:
        raise HTTPException(404, "no wallet found for this email")
    return {
        "token": row["token"],
        "balance": int(row["balance_cents"]),
        "name": row["display_name"] or row["name"],
        "email": row["email"],
    }


@app.get("/api/auth/status")
async def auth_status(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        return {"authenticated": False}

    contact = await db.fetch_one(
        "SELECT name, display_name, handle, did FROM wallet_contacts WHERE wallet_id = $1",
        wallet["id"],
    )
    c = dict(contact) if contact else {}
    return {
        "authenticated": True,
        "balance": int(wallet["balance_cents"]),
        "name": c.get("display_name") or c.get("name") or "",
        "handle": c.get("handle"),
        "did": c.get("did"),
        "hasFunds": wallet["balance_cents"] > 0,
    }


# ── Fund wallet ──────────────────────────────────────────────

@app.post("/api/wallet/fund/stripe")
async def fund_stripe(body: FundRequest, authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")
    if body.amount <= 0:
        raise HTTPException(400, "amount must be positive")

    amount_cents = round(body.amount * 100)

    if settings.is_demo or not settings.stripe_enabled:
        return await _demo_fund(wallet, amount_cents, "stripe")

    session = stripe_lib.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"SimpleTip wallet — add ${body.amount}"},
                "unit_amount": amount_cents,
            },
            "quantity": 1,
        }],
        metadata={"wallet_id": str(wallet["id"]), "type": "fund"},
        success_url=f"{settings.node_url}/fund-success.html?amount={body.amount}",
        cancel_url=f"{settings.node_url}/fund.html",
    )

    await db.execute(
        "INSERT INTO funding (wallet_id, amount_cents, method, payment_provider_id, status) "
        "VALUES ($1, $2, 'stripe', $3, 'pending')",
        wallet["id"], amount_cents, session.id,
    )

    return {"checkoutUrl": session.url, "sessionId": session.id}


@app.post("/api/wallet/fund")
async def fund_generic(body: FundRequest, authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")
    if body.amount <= 0:
        raise HTTPException(400, "amount must be positive")

    amount_cents = round(body.amount * 100)

    if settings.is_demo:
        return await _demo_fund(wallet, amount_cents, body.method or "demo")

    row = await db.fetch_one(
        "INSERT INTO funding (wallet_id, amount_cents, method, status) "
        "VALUES ($1, $2, $3, 'pending_confirmation') RETURNING id",
        wallet["id"], amount_cents, body.method or "manual",
    )
    return {
        "fundId": str(row["id"]),
        "status": "pending_confirmation",
        "message": f"Send ${body.amount} via {body.method}. We'll credit your wallet once confirmed.",
    }


async def _demo_fund(wallet, amount_cents: int, method: str):
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE wallets SET balance_cents = balance_cents + $1, total_funded_cents = total_funded_cents + $1 WHERE id = $2",
                amount_cents, wallet["id"],
            )
            fund = await conn.fetchrow(
                "INSERT INTO funding (wallet_id, amount_cents, method, status, completed_at) "
                "VALUES ($1, $2, $3, 'completed', now()) RETURNING id",
                wallet["id"], amount_cents, method + "-demo",
            )
            new_balance = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", wallet["id"])
            await conn.execute(
                "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                "VALUES ($1, 'topup', $2, $3, $4, 'funding', $5)",
                wallet["id"], amount_cents, new_balance, fund["id"], f"Demo {method} top-up",
            )

    return {"success": True, "balance": int(new_balance), "demo": True}


# ── Tipping ──────────────────────────────────────────────────

@app.post("/api/tip")
async def tip(body: TipRequest, authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    amount_cents = round(body.amount * 100)

    if wallet["balance_cents"] < amount_cents:
        raise HTTPException(402, f"insufficient_funds: balance={wallet['balance_cents']}")

    total_pct = sum(r.pct for r in body.receivers)
    if total_pct != 100:
        raise HTTPException(400, f"split percentages must sum to 100, got {total_pct}")

    uri = canonicalize_uri(body.page_url)

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            article = await conn.fetchrow("SELECT id FROM articles WHERE uri = $1", uri)
            article_id = article["id"] if article else None

            tip_row = await conn.fetchrow(
                "INSERT INTO tips (wallet_id, article_id, page_url, amount_cents, comment, source, status) "
                "VALUES ($1, $2, $3, $4, $5, 'wallet', 'completed') RETURNING id",
                wallet["id"], article_id, body.page_url, amount_cents, body.comment,
            )
            tip_id = tip_row["id"]
            slug_list = " + ".join(r.slug for r in body.receivers)

            for split in body.receivers:
                split_cents = round(amount_cents * split.pct / 100)
                receiver = await conn.fetchrow("SELECT id, wallet_id FROM receivers WHERE slug = $1", split.slug)
                if not receiver:
                    raise HTTPException(400, f"receiver not found: {split.slug}")
                await conn.execute(
                    "INSERT INTO tip_splits (tip_id, receiver_id, amount_cents, role) VALUES ($1, $2, $3, $4)",
                    tip_id, receiver["id"], split_cents, split.role,
                )
                await conn.execute(
                    "UPDATE receivers SET total_received_cents = total_received_cents + $1 WHERE id = $2",
                    split_cents, receiver["id"],
                )
                # Credit receiver's wallet (double-entry)
                if receiver["wallet_id"]:
                    await conn.execute(
                        "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
                        split_cents, receiver["wallet_id"],
                    )
                    rcv_balance = await conn.fetchval(
                        "SELECT balance_cents FROM wallets WHERE id = $1", receiver["wallet_id"],
                    )
                    await conn.execute(
                        "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                        "VALUES ($1, 'tip_received', $2, $3, $4, 'tip', $5)",
                        receiver["wallet_id"], split_cents, rcv_balance, tip_id, f"Tip received for {split.slug}",
                    )

            # Debit donor wallet
            await conn.execute(
                "UPDATE wallets SET balance_cents = balance_cents - $1, total_tipped_cents = total_tipped_cents + $1 WHERE id = $2",
                amount_cents, wallet["id"],
            )
            new_balance = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", wallet["id"])

            await conn.execute(
                "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                "VALUES ($1, 'tip', $2, $3, $4, 'tip', $5)",
                wallet["id"], -amount_cents, new_balance, tip_id, f"Tip to {slug_list}",
            )

            if article_id:
                await conn.execute(
                    "INSERT INTO article_events (article_id, event_type, wallet_id) VALUES ($1, 'tip_completed', $2)",
                    article_id, wallet["id"],
                )

    total_tipped = await db.fetch_val("SELECT total_tipped_cents FROM wallets WHERE id = $1", wallet["id"])

    if settings.atproto_enabled:
        asyncio.create_task(_publish_tip_safe(tip_id))

    return {"success": True, "tipId": str(tip_id), "balance": int(new_balance), "totalTipped": int(total_tipped)}


@app.post("/api/tip/checkout")
async def tip_checkout(body: TipRequest, authorization: Optional[str] = Header(None)):
    """Anonymous tip via Stripe checkout (no wallet needed)."""
    amount_cents = round(body.amount * 100)
    receiver_names = " + ".join(r.slug for r in body.receivers)
    uri = canonicalize_uri(body.page_url)

    article = await db.fetch_one("SELECT id FROM articles WHERE uri = $1", uri)
    article_id = article["id"] if article else None

    tip_row = await db.fetch_one(
        "INSERT INTO tips (article_id, page_url, amount_cents, comment, source, status) "
        "VALUES ($1, $2, $3, $4, 'stripe_direct', 'pending') RETURNING id",
        article_id, body.page_url, amount_cents, body.comment,
    )
    tip_id = tip_row["id"]

    for split in body.receivers:
        split_cents = round(amount_cents * split.pct / 100)
        receiver = await db.fetch_one("SELECT id FROM receivers WHERE slug = $1", split.slug)
        if receiver:
            await db.execute(
                "INSERT INTO tip_splits (tip_id, receiver_id, amount_cents, role) VALUES ($1, $2, $3, $4)",
                tip_id, receiver["id"], split_cents, split.role,
            )

    if settings.stripe_enabled:
        session = stripe_lib.checkout.Session.create(
            mode="payment",
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"Tip for {receiver_names}"},
                    "unit_amount": amount_cents,
                },
                "quantity": 1,
            }],
            metadata={"tip_id": str(tip_id), "type": "tip"},
            success_url=f"{settings.node_url}/tip-success.html?amount={body.amount}",
            cancel_url=body.page_url,
        )
        await db.execute("UPDATE tips SET payment_provider_id = $1 WHERE id = $2", session.id, tip_id)
        return {"checkoutUrl": session.url, "sessionId": session.id, "tipId": str(tip_id)}

    # Demo mode
    return {
        "checkoutUrl": f"{settings.node_url}/checkout.html?tip={tip_id}&amount={body.amount}",
        "tipId": str(tip_id),
    }


@app.post("/api/tip/confirm")
async def confirm_tip(body: TipConfirm):
    tip = await db.fetch_one("SELECT * FROM tips WHERE id = $1 AND status = 'pending'", body.tip_id)
    if not tip:
        raise HTTPException(404, "tip not found or already confirmed")

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("UPDATE tips SET status = 'completed' WHERE id = $1", body.tip_id)
            splits = await conn.fetch("SELECT * FROM tip_splits WHERE tip_id = $1", body.tip_id)
            for s in splits:
                await conn.execute(
                    "UPDATE receivers SET total_received_cents = total_received_cents + $1 WHERE id = $2",
                    s["amount_cents"], s["receiver_id"],
                )

    if settings.atproto_enabled:
        asyncio.create_task(_publish_tip_safe(body.tip_id))

    return {"success": True}


@app.get("/api/wallet/tips")
async def wallet_tips(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    rows = await db.fetch_all(
        "SELECT t.id, t.amount_cents, t.comment, t.page_url, t.source, t.created_at, "
        "json_agg(json_build_object('slug', r.slug, 'name', r.name, 'amount_cents', ts.amount_cents, 'role', ts.role)) AS receivers "
        "FROM tips t "
        "LEFT JOIN tip_splits ts ON ts.tip_id = t.id "
        "LEFT JOIN receivers r ON r.id = ts.receiver_id "
        "WHERE t.wallet_id = $1 AND t.status = 'completed' "
        "GROUP BY t.id ORDER BY t.created_at DESC LIMIT 50",
        wallet["id"],
    )
    return [dict(r) for r in rows]


# ── Pledges ──────────────────────────────────────────────────

@app.post("/api/pledge")
async def create_pledge(body: PledgeRequest, authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    amount_cents = round(body.amount * 100)
    uri = canonicalize_uri(body.page_url) if body.page_url else None

    article_id = None
    if uri:
        article = await db.fetch_one("SELECT id FROM articles WHERE uri = $1", uri)
        article_id = article["id"] if article else None

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            pledge = await conn.fetchrow(
                "INSERT INTO pledges (wallet_id, article_id, page_url, amount_cents, comment) "
                "VALUES ($1, $2, $3, $4, $5) RETURNING id",
                wallet["id"], article_id, body.page_url, amount_cents, body.comment,
            )
            for split in body.receivers:
                split_cents = round(amount_cents * split.pct / 100)
                receiver = await conn.fetchrow("SELECT id FROM receivers WHERE slug = $1", split.slug)
                if not receiver:
                    raise HTTPException(400, f"receiver not found: {split.slug}")
                await conn.execute(
                    "INSERT INTO pledge_splits (pledge_id, receiver_id, amount_cents, role) VALUES ($1, $2, $3, $4)",
                    pledge["id"], receiver["id"], split_cents, split.role,
                )
            if article_id:
                await conn.execute(
                    "INSERT INTO article_events (article_id, event_type, wallet_id) VALUES ($1, 'pledge', $2)",
                    article_id, wallet["id"],
                )

    pending = await db.fetch_one(
        "SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS total "
        "FROM pledges WHERE wallet_id = $1 AND status = 'pending'",
        wallet["id"],
    )
    return {
        "success": True,
        "pledgeId": str(pledge["id"]),
        "pendingCount": int(pending["n"]),
        "pendingTotal": int(pending["total"]),
    }


@app.get("/api/pledges")
async def list_pledges(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    rows = await db.fetch_all(
        "SELECT p.id, p.amount_cents, p.comment, p.page_url, p.created_at, "
        "json_agg(json_build_object('slug', r.slug, 'name', r.name, 'amount_cents', ps.amount_cents, 'role', ps.role)) AS receivers "
        "FROM pledges p "
        "LEFT JOIN pledge_splits ps ON ps.pledge_id = p.id "
        "LEFT JOIN receivers r ON r.id = ps.receiver_id "
        "WHERE p.wallet_id = $1 AND p.status = 'pending' "
        "GROUP BY p.id ORDER BY p.created_at DESC",
        wallet["id"],
    )
    total = sum(int(r["amount_cents"]) for r in rows)
    return {"pledges": [dict(r) for r in rows], "total": total}


@app.post("/api/pledges/fulfill")
async def fulfill_pledges(authorization: Optional[str] = Header(None)):
    wallet = await get_wallet(authorization)
    if not wallet:
        raise HTTPException(401, "not authenticated")

    pending = await db.fetch_all(
        "SELECT * FROM pledges WHERE wallet_id = $1 AND status = 'pending' ORDER BY created_at ASC",
        wallet["id"],
    )
    if not pending:
        return {"fulfilled": 0}

    total_needed = sum(int(p["amount_cents"]) for p in pending)
    if wallet["balance_cents"] < total_needed:
        raise HTTPException(402, f"insufficient_funds: balance={wallet['balance_cents']}, needed={total_needed}")

    fulfilled = 0
    balance = int(wallet["balance_cents"])

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            for pledge in pending:
                pledge_amount = int(pledge["amount_cents"])
                if balance < pledge_amount:
                    break

                tip = await conn.fetchrow(
                    "INSERT INTO tips (wallet_id, article_id, page_url, amount_cents, comment, source, status) "
                    "VALUES ($1, $2, $3, $4, $5, 'pledge', 'completed') RETURNING id",
                    wallet["id"], pledge["article_id"], pledge["page_url"] or "", pledge_amount, pledge["comment"],
                )

                splits = await conn.fetch("SELECT * FROM pledge_splits WHERE pledge_id = $1", pledge["id"])
                for s in splits:
                    await conn.execute(
                        "INSERT INTO tip_splits (tip_id, receiver_id, amount_cents, role) VALUES ($1, $2, $3, $4)",
                        tip["id"], s["receiver_id"], s["amount_cents"], s["role"],
                    )
                    await conn.execute(
                        "UPDATE receivers SET total_received_cents = total_received_cents + $1 WHERE id = $2",
                        int(s["amount_cents"]), s["receiver_id"],
                    )
                    # Credit receiver wallet (double-entry)
                    rcv_wallet_id = await conn.fetchval(
                        "SELECT wallet_id FROM receivers WHERE id = $1", s["receiver_id"],
                    )
                    if rcv_wallet_id:
                        await conn.execute(
                            "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
                            int(s["amount_cents"]), rcv_wallet_id,
                        )
                        rcv_bal = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", rcv_wallet_id)
                        await conn.execute(
                            "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                            "VALUES ($1, 'tip_received', $2, $3, $4, 'tip', 'Tip received (pledge fulfilled)')",
                            rcv_wallet_id, int(s["amount_cents"]), rcv_bal, tip["id"],
                        )

                # Debit donor wallet
                await conn.execute(
                    "UPDATE wallets SET balance_cents = balance_cents - $1, total_tipped_cents = total_tipped_cents + $1 WHERE id = $2",
                    pledge_amount, wallet["id"],
                )
                balance -= pledge_amount

                await conn.execute(
                    "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                    "VALUES ($1, 'tip', $2, $3, $4, 'tip', 'Fulfilled pledge')",
                    wallet["id"], -pledge_amount, balance, tip["id"],
                )

                await conn.execute(
                    "UPDATE pledges SET status = 'fulfilled', fulfilled_tip_id = $1 WHERE id = $2",
                    tip["id"], pledge["id"],
                )
                fulfilled += 1

                if settings.atproto_enabled:
                    asyncio.create_task(_publish_tip_safe(tip["id"]))

    return {"fulfilled": fulfilled, "balance": balance}


# ── Stripe webhook ───────────────────────────────────────────

@app.post("/api/webhook/stripe")
async def stripe_webhook(request: Request):
    if not settings.stripe_enabled:
        raise HTTPException(400, "Stripe not configured")

    body = await request.body()

    if settings.stripe_webhook_secret:
        sig = request.headers.get("stripe-signature", "")
        try:
            event = stripe_lib.Webhook.construct_event(body, sig, settings.stripe_webhook_secret)
        except Exception as e:
            raise HTTPException(400, f"Webhook error: {e}")
    else:
        import json
        event = json.loads(body)

    if event.get("type") == "checkout.session.completed":
        session = event["data"]["object"]
        meta = session.get("metadata", {})

        if meta.get("type") == "fund":
            fund = await db.fetch_one(
                "SELECT * FROM funding WHERE payment_provider_id = $1 AND status = 'pending'",
                session["id"],
            )
            if fund:
                async with db.pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.execute("UPDATE funding SET status = 'completed', completed_at = now() WHERE id = $1", fund["id"])
                        await conn.execute(
                            "UPDATE wallets SET balance_cents = balance_cents + $1, total_funded_cents = total_funded_cents + $1 WHERE id = $2",
                            fund["amount_cents"], fund["wallet_id"],
                        )
                        new_bal = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", fund["wallet_id"])
                        await conn.execute(
                            "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                            "VALUES ($1, 'topup', $2, $3, $4, 'funding', 'Stripe payment')",
                            fund["wallet_id"], fund["amount_cents"], new_bal, fund["id"],
                        )

        elif meta.get("type") == "tip":
            tip_id = meta.get("tip_id")
            tip = await db.fetch_one("SELECT * FROM tips WHERE id = $1 AND status = 'pending'", tip_id)
            if tip:
                async with db.pool.acquire() as conn:
                    async with conn.transaction():
                        await conn.execute("UPDATE tips SET status = 'completed' WHERE id = $1", tip_id)
                        splits = await conn.fetch("SELECT * FROM tip_splits WHERE tip_id = $1", tip_id)
                        for s in splits:
                            await conn.execute(
                                "UPDATE receivers SET total_received_cents = total_received_cents + $1 WHERE id = $2",
                                s["amount_cents"], s["receiver_id"],
                            )
                            # Credit receiver wallet (double-entry)
                            rcv_wallet_id = await conn.fetchval(
                                "SELECT wallet_id FROM receivers WHERE id = $1", s["receiver_id"],
                            )
                            if rcv_wallet_id:
                                await conn.execute(
                                    "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
                                    s["amount_cents"], rcv_wallet_id,
                                )
                                rcv_bal = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", rcv_wallet_id)
                                await conn.execute(
                                    "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                                    "VALUES ($1, 'tip_received', $2, $3, $4, 'tip', 'Tip received (Stripe direct)')",
                                    rcv_wallet_id, int(s["amount_cents"]), rcv_bal, tip_id,
                                )
                if settings.atproto_enabled:
                    asyncio.create_task(_publish_tip_safe(tip_id))

    return {"received": True}


# ── Receiver dashboard ───────────────────────────────────────

@app.get("/api/receiver/{slug}/dashboard")
async def receiver_dashboard(slug: str):
    r = await db.fetch_one("SELECT * FROM receivers WHERE slug = $1", slug)
    if not r:
        raise HTTPException(404, "receiver not found")

    tips = await db.fetch_all(
        "SELECT t.amount_cents, ts.amount_cents AS split_amount_cents, t.comment, t.source, t.page_url, t.created_at, "
        "wc.display_name AS tipper_name, wc.handle AS tipper_handle, wc.anonymous AS tipper_anonymous "
        "FROM tip_splits ts "
        "JOIN tips t ON t.id = ts.tip_id "
        "LEFT JOIN wallet_contacts wc ON wc.wallet_id = t.wallet_id "
        "WHERE ts.receiver_id = $1 AND t.status = 'completed' "
        "ORDER BY t.created_at DESC LIMIT 100",
        r["id"],
    )

    pledges = await db.fetch_all(
        "SELECT p.amount_cents, ps.amount_cents AS split_amount_cents, p.comment, p.created_at, "
        "wc.display_name AS pledger_name, wc.handle AS pledger_handle "
        "FROM pledge_splits ps "
        "JOIN pledges p ON p.id = ps.pledge_id "
        "LEFT JOIN wallet_contacts wc ON wc.wallet_id = p.wallet_id "
        "WHERE ps.receiver_id = $1 AND p.status = 'pending' "
        "ORDER BY p.created_at DESC",
        r["id"],
    )

    stats = await db.fetch_one(
        "SELECT count(*) AS tip_count, COALESCE(sum(ts.amount_cents), 0) AS total_received "
        "FROM tip_splits ts JOIN tips t ON t.id = ts.tip_id "
        "WHERE ts.receiver_id = $1 AND t.status = 'completed'",
        r["id"],
    )

    payouts = await db.fetch_all(
        "SELECT id, amount_cents, status, initiated_at, completed_at "
        "FROM payouts WHERE receiver_id = $1 ORDER BY initiated_at DESC LIMIT 20",
        r["id"],
    )

    total_paid_out = sum(int(p["amount_cents"]) for p in payouts if p["status"] in ("completed", "processing", "pending"))

    # Available balance from wallet (source of truth)
    wallet_balance = 0
    if r["wallet_id"]:
        wb = await db.fetch_val("SELECT balance_cents FROM wallets WHERE id = $1", r["wallet_id"])
        wallet_balance = int(wb) if wb else 0

    # Annual payout cap tracking
    paid_this_year = await db.fetch_val(
        "SELECT COALESCE(sum(amount_cents), 0) FROM payouts "
        "WHERE receiver_id = $1 AND status IN ('completed', 'processing', 'pending') "
        "AND initiated_at >= date_trunc('year', now())",
        r["id"],
    )
    remaining_annual_cap = ANNUAL_PAYOUT_CAP_CENTS - int(paid_this_year)

    return {
        "receiver": {"slug": r["slug"], "name": r["name"], "type": r["type"], "createdAt": r["created_at"].isoformat()},
        "tips": [
            {
                **{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(t).items()},
                "tipper_name": "Anonymous" if t["tipper_anonymous"] else (t["tipper_name"] or "Anonymous"),
                "tipper_handle": None if t.get("tipper_anonymous") else t["tipper_handle"],
            }
            for t in tips
        ],
        "pledges": [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(p).items()} for p in pledges],
        "payouts": [{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in dict(p).items()} for p in payouts],
        "stats": {
            "tipCount": int(stats["tip_count"]),
            "totalReceived": int(stats["total_received"]),
            "totalPaidOut": total_paid_out,
            "availableBalance": wallet_balance,
            "annualPayoutRemaining": max(0, remaining_annual_cap),
            "annualPayoutCap": ANNUAL_PAYOUT_CAP_CENTS,
        },
    }


# ── Receiver payout request ──────────────────────────────────

MINIMUM_PAYOUT_CENTS = 1000  # $10.00
ANNUAL_PAYOUT_CAP_CENTS = 60000  # $600.00 per receiver per calendar year (below 1099 threshold)

@app.post("/api/receiver/{slug}/request-payout")
async def request_payout(slug: str, authorization: Optional[str] = Header(None)):
    r = await db.fetch_one("SELECT * FROM receivers WHERE slug = $1", slug)
    if not r:
        raise HTTPException(404, "receiver not found")

    # Must have a wallet linked
    if not r["wallet_id"]:
        raise HTTPException(400, "no wallet linked to this receiver — re-register to link one")

    # Auth check: only the receiver's own wallet can request payout
    wallet = await get_wallet(authorization)
    if not wallet or wallet["id"] != r["wallet_id"]:
        raise HTTPException(403, "only the receiver can request a payout")

    method = await db.fetch_one(
        "SELECT * FROM receiver_payout_methods WHERE receiver_id = $1 AND is_preferred = true",
        r["id"],
    )
    if not method:
        raise HTTPException(400, "no payout method configured")

    # Check annual payout cap ($600/year per receiver for non-Stripe-Connect)
    # TODO: skip this check for Stripe Connect receivers once implemented
    paid_this_year = await db.fetch_val(
        "SELECT COALESCE(sum(amount_cents), 0) FROM payouts "
        "WHERE receiver_id = $1 AND status IN ('completed', 'processing', 'pending') "
        "AND initiated_at >= date_trunc('year', now())",
        r["id"],
    )
    remaining_cap = ANNUAL_PAYOUT_CAP_CENTS - int(paid_this_year)

    if remaining_cap <= 0:
        raise HTTPException(400,
            "You've reached the $600 annual payout limit. "
            "Link a Stripe Connect account to continue receiving payouts."
        )

    # Available = wallet balance, capped at remaining annual limit
    available = min(int(wallet["balance_cents"]), remaining_cap)
    if available < MINIMUM_PAYOUT_CENTS:
        raise HTTPException(400, f"minimum payout is ${MINIMUM_PAYOUT_CENTS / 100:.2f} — current balance: ${available / 100:.2f}")

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            payout_row = await conn.fetchrow(
                "INSERT INTO payouts (receiver_id, payout_method_id, amount_cents, status) "
                "VALUES ($1, $2, $3, 'pending') RETURNING id",
                r["id"], method["id"], available,
            )
            # Debit receiver wallet
            await conn.execute(
                "UPDATE wallets SET balance_cents = balance_cents - $1 WHERE id = $2",
                available, r["wallet_id"],
            )
            new_balance = await conn.fetchval(
                "SELECT balance_cents FROM wallets WHERE id = $1", r["wallet_id"],
            )
            # Ledger entry
            await conn.execute(
                "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                "VALUES ($1, 'payout', $2, $3, $4, 'payout', $5)",
                r["wallet_id"], -available, new_balance, payout_row["id"], f"Payout requested: ${available / 100:.2f}",
            )

    return {"payoutId": str(payout_row["id"]), "amount": available, "status": "pending"}


# ── Article stats ────────────────────────────────────────────

@app.get("/api/article/stats")
async def article_stats(uri: str):
    article = await db.fetch_one("SELECT * FROM articles WHERE uri = $1", canonicalize_uri(uri))
    if not article:
        raise HTTPException(404, "article not found")

    impressions = await db.fetch_val(
        "SELECT count(*) FROM article_events WHERE article_id = $1 AND event_type = 'impression'",
        article["id"],
    )
    tip_stats = await db.fetch_one(
        "SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS total "
        "FROM tips WHERE article_id = $1 AND status = 'completed'",
        article["id"],
    )
    receivers = await db.fetch_all(
        "SELECT r.slug, r.name, ar.role, ar.default_split_pct "
        "FROM article_receivers ar JOIN receivers r ON r.id = ar.receiver_id WHERE ar.article_id = $1",
        article["id"],
    )

    return {
        "uri": article["uri"],
        "title": article["title"],
        "siteName": article["site_name"],
        "impressions": impressions,
        "tips": int(tip_stats["n"]),
        "totalTipped": int(tip_stats["total"]),
        "receivers": [dict(r) for r in receivers],
    }


# ── Global stats ─────────────────────────────────────────────

@app.get("/api/stats")
async def global_stats():
    total = await db.fetch_one(
        "SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS total FROM tips WHERE status = 'completed'"
    )
    top = await db.fetch_all(
        "SELECT slug, name, total_received_cents, "
        "(SELECT count(*) FROM tip_splits WHERE receiver_id = receivers.id) AS tip_count "
        "FROM receivers WHERE total_received_cents > 0 ORDER BY total_received_cents DESC LIMIT 10"
    )
    return {
        "totalTips": int(total["n"]),
        "totalAmount": int(total["total"]),
        "topReceivers": [dict(r) for r in top],
    }


# ── Admin ────────────────────────────────────────────────────

@app.post("/api/admin/confirm-funding")
async def admin_confirm_funding(body: AdminConfirmFunding):
    fund = await db.fetch_one(
        "SELECT * FROM funding WHERE id = $1 AND status = 'pending_confirmation'",
        body.fund_id,
    )
    if not fund:
        raise HTTPException(404, "funding not found")

    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("UPDATE funding SET status = 'completed', completed_at = now() WHERE id = $1", fund["id"])
            await conn.execute(
                "UPDATE wallets SET balance_cents = balance_cents + $1, total_funded_cents = total_funded_cents + $1 WHERE id = $2",
                fund["amount_cents"], fund["wallet_id"],
            )
            new_bal = await conn.fetchval("SELECT balance_cents FROM wallets WHERE id = $1", fund["wallet_id"])
            await conn.execute(
                "INSERT INTO wallet_transactions (wallet_id, type, amount_cents, balance_after_cents, reference_id, reference_type, description) "
                "VALUES ($1, 'topup', $2, $3, $4, 'funding', 'Manual payment confirmed')",
                fund["wallet_id"], fund["amount_cents"], new_bal, fund["id"],
            )
    return {"success": True}


@app.post("/api/admin/confirm-payout")
async def admin_confirm_payout(body: AdminConfirmPayout):
    await db.execute(
        "UPDATE payouts SET status = 'completed', completed_at = now(), provider_reference = $1 "
        "WHERE id = $2 AND status IN ('pending', 'processing')",
        body.provider_reference, body.payout_id,
    )
    return {"success": True}


@app.post("/api/admin/atproto/publish-batch")
async def admin_atproto_publish_batch(since_hours: int = Query(default=24)):
    if not settings.atproto_enabled:
        raise HTTPException(400, "ATProto not configured — set ATPROTO_HANDLE and ATPROTO_APP_PASSWORD")

    from atproto_publisher import publish_batch
    async with db.pool.acquire() as conn:
        result = await publish_batch(conn, since_hours)
    return result


# ── ATProto OAuth ────────────────────────────────────────────

@app.get("/client-metadata.json")
async def client_metadata():
    """OAuth client metadata — required by ATProto OAuth."""
    return atproto_oauth.get_client_metadata()


class OAuthStartRequest(BaseModel):
    handle: str
    scope: str = "atproto"  # Start with read, upgrade to transition:authfull for writes


@app.post("/api/oauth/start")
async def oauth_start(body: OAuthStartRequest):
    """Start ATProto OAuth flow. Returns URL to redirect user to."""
    try:
        result = await atproto_oauth.start_auth(body.handle, body.scope)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/oauth/callback")
async def oauth_callback(code: str = Query(...), state: str = Query(...)):
    """OAuth callback — exchange code for tokens."""
    try:
        result = await atproto_oauth.handle_callback(code, state)
        # Redirect to login success page with session info
        from fastapi.responses import RedirectResponse
        return RedirectResponse(
            url=f"{settings.node_url}/login-success.html?session={result['session_id']}&did={result['did']}&handle={result['handle']}&scope={result['scope']}"
        )
    except Exception as e:
        raise HTTPException(400, str(e))


class OAuthUpgradeRequest(BaseModel):
    session_id: str


@app.post("/api/oauth/upgrade")
async def oauth_upgrade(body: OAuthUpgradeRequest):
    """Upgrade OAuth scope from atproto to transition:authfull for writing claims."""
    try:
        result = await atproto_oauth.upgrade_scope(body.session_id)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@app.get("/api/oauth/session")
async def oauth_session(session_id: str = Query(...)):
    """Check OAuth session status."""
    session = atproto_oauth.get_session(session_id)
    if not session:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "did": session["did"],
        "handle": session["handle"],
        "scope": session["scope"],
        "can_write": session["scope"] == "transition:authfull",
    }


# ── Static files (public/ directory) ─────────────────────────

import os
public_dir = os.path.join(os.path.dirname(__file__), "..", "public")
if os.path.isdir(public_dir):
    app.mount("/", StaticFiles(directory=public_dir, html=True), name="static")
