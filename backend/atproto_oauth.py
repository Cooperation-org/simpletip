"""
ATProto OAuth — progressive scope upgrade for SimpleTip.

Flow:
1. User logs in with `atproto` scope (basic read)
2. When they want to publish claims, we upgrade to `transition:authfull`
3. CRITICAL: never use `transition:generic` — only `transition:authfull`

Uses ATProto OAuth 2.0 with PKCE and DPoP.
"""

import hashlib
import hmac
import logging
import secrets
import time
from base64 import urlsafe_b64encode
from urllib.parse import urlencode

import httpx

from config import settings

log = logging.getLogger("simpletip.oauth")

# Scope constants
SCOPE_READ = "atproto"
SCOPE_WRITE = "transition:authfull"  # CRITICAL: never use transition:generic

# In-memory session store (use Redis/DB in production)
_oauth_states: dict[str, dict] = {}
_oauth_sessions: dict[str, dict] = {}


def _generate_pkce():
    """Generate PKCE code verifier and challenge."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


async def resolve_auth_server(handle: str) -> dict:
    """Resolve a handle to its ATProto authorization server metadata."""
    # First resolve the handle to a DID
    async with httpx.AsyncClient() as client:
        # Try resolving via the handle's PDS
        resp = await client.get(
            f"https://bsky.social/xrpc/com.atproto.identity.resolveHandle",
            params={"handle": handle},
        )
        resp.raise_for_status()
        did = resp.json()["did"]

        # Get the PDS service endpoint from the DID document
        resp = await client.get(f"https://plc.directory/{did}")
        resp.raise_for_status()
        did_doc = resp.json()

        # Find PDS service endpoint
        pds_url = None
        for service in did_doc.get("service", []):
            if service.get("type") == "AtprotoPersonalDataServer":
                pds_url = service["serviceEndpoint"]
                break

        if not pds_url:
            raise ValueError(f"No PDS found for {handle}")

        # Get authorization server metadata from PDS
        resp = await client.get(f"{pds_url}/.well-known/oauth-authorization-server")
        resp.raise_for_status()
        auth_meta = resp.json()

    return {
        "did": did,
        "pds_url": pds_url,
        "authorization_endpoint": auth_meta["authorization_endpoint"],
        "token_endpoint": auth_meta["token_endpoint"],
        "pushed_authorization_request_endpoint": auth_meta.get("pushed_authorization_request_endpoint"),
    }


def get_client_metadata() -> dict:
    """Return OAuth client metadata for SimpleTip."""
    base_url = settings.node_url
    return {
        "client_id": f"{base_url}/client-metadata.json",
        "client_name": settings.node_name,
        "client_uri": base_url,
        "redirect_uris": [f"{base_url}/api/oauth/callback"],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "scope": f"{SCOPE_READ} {SCOPE_WRITE}",
        "token_endpoint_auth_method": "none",
        "application_type": "web",
        "dpop_bound_access_tokens": True,
    }


async def start_auth(handle: str, scope: str = SCOPE_READ) -> dict:
    """Start OAuth flow. Returns authorization URL to redirect user to.

    Args:
        handle: User's ATProto handle (e.g., alice.bsky.social)
        scope: OAuth scope — 'atproto' for read, 'transition:authfull' for write
    """
    if scope not in (SCOPE_READ, SCOPE_WRITE):
        raise ValueError(f"Invalid scope: {scope}. Use '{SCOPE_READ}' or '{SCOPE_WRITE}'")

    auth_server = await resolve_auth_server(handle)
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)

    # Store state for callback verification
    _oauth_states[state] = {
        "handle": handle,
        "did": auth_server["did"],
        "verifier": verifier,
        "scope": scope,
        "token_endpoint": auth_server["token_endpoint"],
        "created_at": time.monotonic(),
    }

    client_id = f"{settings.node_url}/client-metadata.json"
    redirect_uri = f"{settings.node_url}/api/oauth/callback"

    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scope,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "login_hint": handle,
    }

    # Use PAR if available
    par_endpoint = auth_server.get("pushed_authorization_request_endpoint")
    if par_endpoint:
        async with httpx.AsyncClient() as client:
            resp = await client.post(par_endpoint, data=params)
            if resp.status_code == 201:
                par_data = resp.json()
                auth_url = f"{auth_server['authorization_endpoint']}?request_uri={par_data['request_uri']}&client_id={client_id}"
                return {"authorization_url": auth_url, "state": state}

    # Fallback to standard authorization URL
    auth_url = f"{auth_server['authorization_endpoint']}?{urlencode(params)}"
    return {"authorization_url": auth_url, "state": state}


async def handle_callback(code: str, state: str) -> dict:
    """Exchange authorization code for tokens."""
    if state not in _oauth_states:
        raise ValueError("Invalid or expired state")

    oauth_state = _oauth_states.pop(state)

    # Check expiry (10 minutes)
    if time.monotonic() - oauth_state["created_at"] > 600:
        raise ValueError("OAuth state expired")

    client_id = f"{settings.node_url}/client-metadata.json"
    redirect_uri = f"{settings.node_url}/api/oauth/callback"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            oauth_state["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "code_verifier": oauth_state["verifier"],
            },
        )
        resp.raise_for_status()
        tokens = resp.json()

    session_id = secrets.token_urlsafe(32)
    _oauth_sessions[session_id] = {
        "did": oauth_state["did"],
        "handle": oauth_state["handle"],
        "scope": oauth_state["scope"],
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token"),
        "token_endpoint": oauth_state["token_endpoint"],
        "expires_at": time.monotonic() + tokens.get("expires_in", 3600),
    }

    return {
        "session_id": session_id,
        "did": oauth_state["did"],
        "handle": oauth_state["handle"],
        "scope": oauth_state["scope"],
    }


async def upgrade_scope(session_id: str) -> dict:
    """Upgrade an existing session from atproto to transition:authfull.

    This is the progressive scope upgrade — user starts with read,
    then upgrades to write when they want to publish claims.
    """
    session = _oauth_sessions.get(session_id)
    if not session:
        raise ValueError("Invalid session")

    if session["scope"] == SCOPE_WRITE:
        return {"already_upgraded": True, "scope": SCOPE_WRITE}

    # Start a new auth flow with write scope
    result = await start_auth(session["handle"], scope=SCOPE_WRITE)
    return {
        "needs_reauth": True,
        "authorization_url": result["authorization_url"],
        "state": result["state"],
    }


def get_session(session_id: str) -> dict | None:
    """Get an active OAuth session."""
    session = _oauth_sessions.get(session_id)
    if not session:
        return None
    if time.monotonic() > session["expires_at"]:
        # TODO: refresh token
        del _oauth_sessions[session_id]
        return None
    return session
