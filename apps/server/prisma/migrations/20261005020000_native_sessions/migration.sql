-- Native sessions for D3 Constellation (FRM-P-14, the D3 App contract). A native session is an
-- ordinary session row, marked and named by its device, reached with a Bearer access token; its
-- refresh tokens rotate through native_refresh.
ALTER TABLE "session" ADD COLUMN "native" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "device_name" TEXT,
ADD COLUMN "device_platform" TEXT;

CREATE TABLE "native_refresh" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "replaced_at" TIMESTAMPTZ(6),
    CONSTRAINT "native_refresh_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "native_refresh_token_hash_key" ON "native_refresh"("token_hash");
CREATE INDEX "native_refresh_session_id_idx" ON "native_refresh"("session_id");

ALTER TABLE "native_refresh" ADD CONSTRAINT "native_refresh_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
