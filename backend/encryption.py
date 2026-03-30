"""
AES-256-GCM encryption for sensitive payout method details.

ENCRYPTION_KEY env var: 64-char hex string (32 bytes).
Generate with: python3 -c "import secrets; print(secrets.token_hex(32))"
"""

import json
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_LENGTH = 12


def _get_key() -> bytes:
    hex_key = os.environ.get("ENCRYPTION_KEY", "")
    if len(hex_key) != 64:
        raise ValueError(
            "ENCRYPTION_KEY must be 64 hex chars (32 bytes). "
            "Generate: python3 -c \"import secrets; print(secrets.token_hex(32))\""
        )
    return bytes.fromhex(hex_key)


def encrypt(data: dict) -> bytes:
    """Encrypt a dict to bytes (nonce + ciphertext+tag). Store as Postgres BYTEA."""
    key = _get_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(NONCE_LENGTH)
    plaintext = json.dumps(data).encode("utf-8")
    ct = aesgcm.encrypt(nonce, plaintext, None)
    return nonce + ct


def decrypt(blob: bytes) -> dict:
    """Decrypt bytes back to dict."""
    key = _get_key()
    aesgcm = AESGCM(key)
    nonce = blob[:NONCE_LENGTH]
    ct = blob[NONCE_LENGTH:]
    plaintext = aesgcm.decrypt(nonce, ct, None)
    return json.loads(plaintext.decode("utf-8"))


def mask_detail(key: str, value: str) -> str:
    """Mask a single payout detail for safe display."""
    if not value:
        return "***"
    s = str(value)
    if "email" in key:
        parts = s.split("@")
        if len(parts) == 2:
            return parts[0][0] + "***@" + parts[1]
    if "address" in key and s.startswith("0x"):
        return s[:6] + "..." + s[-4:]
    if "phone" in key or "routing" in key or "account_number" in key:
        return "***" + s[-4:]
    if len(s) > 6:
        return s[:3] + "***" + s[-2:]
    return "***"


def masked_details(blob: bytes) -> dict:
    """Decrypt and return masked version (safe for API responses)."""
    data = decrypt(blob)
    return {k: mask_detail(k, v) for k, v in data.items()}
