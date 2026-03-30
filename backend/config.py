"""
SimpleTip configuration — all from env vars.

Copy .env.example to .env for local dev, or set in systemd unit for production.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgres://simpletip:password@localhost:5432/simpletip"

    # Encryption key for payout method details (64-char hex = 32 bytes)
    encryption_key: str = ""

    # Node identity
    node_name: str = "SimpleTip by LinkedTrust"
    node_url: str = "https://demos.linkedtrust.us/simpletip"

    # Stripe
    stripe_secret_key: str = ""
    stripe_publishable_key: str = ""
    stripe_webhook_secret: str = ""

    # ATProto publishing (optional — disabled if handle is empty)
    atproto_handle: str = ""
    atproto_app_password: str = ""
    atproto_service: str = "https://bsky.social"

    # Port
    port: int = 8046

    # Demo mode — forced on when no payment keys are configured
    demo_mode: bool = False

    @property
    def is_demo(self) -> bool:
        return self.demo_mode or not self.stripe_secret_key

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_secret_key)

    @property
    def atproto_enabled(self) -> bool:
        return bool(self.atproto_handle and self.atproto_app_password)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
