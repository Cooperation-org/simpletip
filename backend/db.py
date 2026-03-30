"""
Async Postgres connection pool for SimpleTip.
"""

import asyncpg
from config import settings

pool: asyncpg.Pool | None = None


def _fix_dsn(url: str) -> str:
    """Convert postgres:// to postgresql:// for asyncpg."""
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://"):]
    return url


async def init_pool():
    global pool
    pool = await asyncpg.create_pool(
        _fix_dsn(settings.database_url),
        min_size=2,
        max_size=20,
    )


async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None


async def fetch_one(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetchrow(query, *args)


async def fetch_all(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetch(query, *args)


async def execute(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.execute(query, *args)


async def fetch_val(query: str, *args):
    async with pool.acquire() as conn:
        return await conn.fetchval(query, *args)
