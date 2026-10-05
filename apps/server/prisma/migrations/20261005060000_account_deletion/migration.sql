-- FRM-T-15.3: an account asked to be deleted waits out a grace period before it is purged.
ALTER TABLE "user" ADD COLUMN "delete_after" TIMESTAMPTZ(6);
