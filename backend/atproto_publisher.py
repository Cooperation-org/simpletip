"""
ATProto publisher — posts completed tips as com.linkedclaims.claim records.

Uses httpx for direct ATProto XRPC calls (lightweight, async).
All errors are caught and logged — publishing never fails a tip.
"""

import logging
import time
from datetime import datetime, timezone

import httpx

from config import settings

log = logging.getLogger("simpletip.atproto")

# ── Session cache ────────────────────────────────────────────

_session: dict | None = None
_session_expires: float = 0


async def _get_session() -> dict:
    """Login via app password, return cached session with accessJwt + did."""
    global _session, _session_expires

    if _session and time.monotonic() < _session_expires:
        return _session

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.atproto_service}/xrpc/com.atproto.server.createSession",
            json={
                "identifier": settings.atproto_handle,
                "password": settings.atproto_app_password,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    _session = {
        "accessJwt": data["accessJwt"],
        "refreshJwt": data["refreshJwt"],
        "did": data["did"],
    }
    # Cache for 90 minutes (tokens last ~2 hours)
    _session_expires = time.monotonic() + 90 * 60
    return _session


# ── Publish a single tip ─────────────────────────────────────

async def publish_tip(tip_id, conn) -> str | None:
    """Build and publish a tip as a LinkedClaim. Returns AT-URI or None on failure."""
    tip = await conn.fetchrow(
        "SELECT t.id, t.amount_cents, t.comment, t.page_url, t.created_at, t.atproto_uri "
        "FROM tips t WHERE t.id = $1 AND t.status = 'completed'",
        tip_id,
    )
    if not tip:
        log.warning("publish_tip: tip %s not found or not completed", tip_id)
        return None
    if tip["atproto_uri"]:
        log.debug("publish_tip: tip %s already published: %s", tip_id, tip["atproto_uri"])
        return tip["atproto_uri"]

    splits = await conn.fetch(
        "SELECT r.slug, r.name, ts.amount_cents, ts.role "
        "FROM tip_splits ts JOIN receivers r ON r.id = ts.receiver_id "
        "WHERE ts.tip_id = $1",
        tip_id,
    )
    if not splits:
        log.warning("publish_tip: tip %s has no splits", tip_id)
        return None

    # Build claim fields
    receiver_names = " + ".join(s["name"] or s["slug"] for s in splits)
    amount_str = f"${tip['amount_cents'] / 100:.2f}"
    statement = f"Tip of {amount_str} to {receiver_names}"
    if tip["page_url"]:
        statement += f" for {tip['page_url']}"
    if tip["comment"]:
        statement += f" — {tip['comment']}"

    created_at = tip["created_at"]
    if isinstance(created_at, datetime):
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        iso_ts = created_at.isoformat(timespec="milliseconds")
    else:
        iso_ts = str(created_at)

    object_val = " + ".join(s["slug"] for s in splits)

    record = {
        "$type": "com.linkedclaims.claim",
        "subject": settings.node_url,
        "claimType": "tip",
        "object": object_val,
        "statement": statement,
        "confidence": 1.0,
        "effectiveDate": iso_ts,
        "createdAt": iso_ts,
    }
    if tip["page_url"]:
        record["source"] = {
            "uri": tip["page_url"],
            "howKnown": "FIRST_HAND",
        }

    # Publish
    session = await _get_session()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.atproto_service}/xrpc/com.atproto.repo.createRecord",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            json={
                "repo": session["did"],
                "collection": "com.linkedclaims.claim",
                "record": record,
            },
        )
        resp.raise_for_status()
        result = resp.json()

    at_uri = result.get("uri", "")
    if at_uri:
        await conn.execute("UPDATE tips SET atproto_uri = $1 WHERE id = $2", at_uri, tip_id)
        log.info("Published tip %s → %s", tip_id, at_uri)

    return at_uri


# ── Batch publish ────────────────────────────────────────────

async def publish_batch(conn, since_hours: int = 24) -> dict:
    """Publish all unpublished completed tips from the last N hours. Returns summary."""
    rows = await conn.fetch(
        "SELECT id FROM tips "
        "WHERE status = 'completed' AND atproto_uri IS NULL "
        "AND created_at > now() - make_interval(hours => $1) "
        "ORDER BY created_at ASC",
        since_hours,
    )

    published = 0
    failed = 0
    errors = []

    for row in rows:
        try:
            uri = await publish_tip(row["id"], conn)
            if uri:
                published += 1
            else:
                failed += 1
                errors.append(f"tip {row['id']}: returned None")
        except Exception as e:
            failed += 1
            errors.append(f"tip {row['id']}: {e}")
            log.exception("Batch publish failed for tip %s", row["id"])

    return {"published": published, "failed": failed, "errors": errors}
