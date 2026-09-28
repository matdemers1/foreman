-- A phase whose every task was cancelled (FRM-P-11, FRM-REQ-183).
--
-- Phase status is now derived from the phase's tasks. A phase of nothing but cancelled work is not
-- complete — nothing it promised was delivered — and it is not planned either: somebody decided.
-- Additive: no existing phase changes here. `reconcile-status` is what moves them.

-- AlterEnum
ALTER TYPE "PhaseStatus" ADD VALUE 'cancelled' BEFORE 'parked';
