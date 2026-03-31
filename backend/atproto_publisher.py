"""
ATProto publisher — posts completed tips as com.thelexfiles.zakia.temp.tip records.

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
        "SELECT t.id, t.wallet_id, t.amount_cents, t.comment, t.page_url, t.created_at, t.atproto_uri "
        "FROM tips t WHERE t.id = $1 AND t.status = 'completed'",
        tip_id,
    )
    if not tip:
        log.warning("publish_tip: tip %s not found or not completed", tip_id)
        return None
    if tip["atproto_uri"]:
        log.debug("publish_tip: tip %s already published: %s", tip_id, tip["atproto_uri"])
        return tip["atproto_uri"]

    # Get tipper info from wallet_contacts
    tipper_info = await conn.fetchrow(
        "SELECT wc.did, wc.handle, wc.name, wc.display_name, wc.anonymous "
        "FROM wallet_contacts wc "
        "WHERE wc.wallet_id = $1",
        tip["wallet_id"],
    )

    splits = await conn.fetch(
        "SELECT r.slug, r.name, ts.amount_cents, ts.role "
        "FROM tip_splits ts JOIN receivers r ON r.id = ts.receiver_id "
        "WHERE ts.tip_id = $1",
        tip_id,
    )
    if not splits:
        log.warning("publish_tip: tip %s has no splits", tip_id)
        return None

    # Build claim fields — tipper is the subject, receiver is the object
    tipper_did = ""
    if tipper_info and not tipper_info["anonymous"]:
        tipper_did = tipper_info["did"] or tipper_info["handle"] or ""

    receiver_names = " + ".join(s["name"] or s["slug"] for s in splits)
    amount_str = f"${tip['amount_cents'] / 100:.2f}"

    created_at = tip["created_at"]
    if isinstance(created_at, datetime):
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        iso_ts = created_at.isoformat(timespec="milliseconds")
    else:
        iso_ts = str(created_at)

    record = {
        "$type": "com.thelexfiles.zakia.temp.tip",
        "tipper": tipper_did,
        "receiver": receiver_names,
        "amount": amount_str,
        "createdAt": iso_ts,
    }
    if tip["page_url"]:
        record["contentUrl"] = tip["page_url"]
    if tip["comment"]:
        record["comment"] = tip["comment"]

    # Publish
    session = await _get_session()
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.atproto_service}/xrpc/com.atproto.repo.createRecord",
            headers={"Authorization": f"Bearer {session['accessJwt']}"},
            json={
                "repo": session["did"],
                "collection": "com.thelexfiles.zakia.temp.tip",
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
