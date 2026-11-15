"""Startet die API. Bindet bewusst nur an 127.0.0.1."""
from __future__ import annotations

import uvicorn

from app.config import settings

if __name__ == "__main__":
    if settings.host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit(
            f"MIXAPART_HOST={settings.host!r} wuerde die API nach aussen oeffnen. "
            "Dieser Prototyp hat keine Authentifizierung und ist nur fuer 127.0.0.1 gedacht."
        )
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level="info")
