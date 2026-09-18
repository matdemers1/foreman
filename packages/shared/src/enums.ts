import { z } from 'zod';

/**
 * Every enumerated value in the model, declared once (FRM-REQ-003). The Prisma schema mirrors
 * these as native Postgres enums, the API validates against them, and the MCP tool schemas are
 * generated from them — so a value added here cannot silently miss a surface.
 */

export const ProjectLifecycle = z.enum([
  'planned',
  'scaffolded',
  'building',
  'deployed',
  'parked',
  'scrapped',
]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycle>;

export const PhaseStatus = z.enum(['planned', 'active', 'complete', 'parked']);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

/** T-shirt sizes only. Foreman records no time estimates anywhere (FRM-REQ-125 territory). */
export const Size = z.enum(['XS', 'S', 'M', 'L', 'XL']);
export type Size = z.infer<typeof Size>;

export const TaskStatus = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** MoSCoW. `M` must, `S` should, `C` could, `W` won't. */
export const Priority = z.enum(['M', 'S', 'C', 'W']);
export type Priority = z.infer<typeof Priority>;

/**
 * EARS patterns. `unparsed` is a legal stored state, never a rejection: the lint warns and the
 * requirement is kept (ADR/Discovery D-14).
 */
export const EarsPattern = z.enum([
  'ubiquitous',
  'state',
  'event',
  'unwanted',
  'optional',
  'complex',
  'unparsed',
]);
export type EarsPattern = z.infer<typeof EarsPattern>;

export const AdrStatus = z.enum(['proposed', 'accepted', 'superseded', 'rejected']);
export type AdrStatus = z.infer<typeof AdrStatus>;

export const AdrRelationKind = z.enum(['extends', 'supersedes', 'superseded_by']);
export type AdrRelationKind = z.infer<typeof AdrRelationKind>;

export const RiskLikelihood = z.enum(['low', 'medium', 'high']);
export type RiskLikelihood = z.infer<typeof RiskLikelihood>;

export const RiskImpact = z.enum(['low', 'medium', 'high']);
export type RiskImpact = z.infer<typeof RiskImpact>;

export const RiskStatus = z.enum(['open', 'fired', 'closed']);
export type RiskStatus = z.infer<typeof RiskStatus>;

/**
 * Document kinds are *data*, not a migration (ADR-006): the five registers that used to be files
 * are views over tables and deliberately absent from this list.
 */
export const DocumentKind = z.enum([
  'architecture',
  'data_model',
  'api_contract',
  'ux_flows',
  'research',
  'discovery',
  'phase_plan',
  'test_strategy',
  'feature_ideas',
  'overview',
  'runbook',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const AuditKind = z.enum(['code_review', 'design', 'feature', 'api']);
export type AuditKind = z.infer<typeof AuditKind>;

export const AuditStatus = z.enum(['running', 'complete', 'abandoned']);
export type AuditStatus = z.infer<typeof AuditStatus>;

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

export const Verified = z.enum(['confirmed', 'plausible']);
export type Verified = z.infer<typeof Verified>;

export const FindingStatus = z.enum(['open', 'fixed', 'skipped', 'wont_fix']);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const CheckConclusion = z.enum([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'neutral',
  'stale',
]);
export type CheckConclusion = z.infer<typeof CheckConclusion>;

/** How a commit came to be attributed to a task (ADR-005 — declared beats inferred). */
export const AttributionSource = z.enum(['declared', 'message', 'file_overlap']);
export type AttributionSource = z.infer<typeof AttributionSource>;

/** The importer's three outcomes. Every source file gets one; silence is the failure mode. */
export const ImportStatus = z.enum(['mapped', 'partial', 'unmapped']);
export type ImportStatus = z.infer<typeof ImportStatus>;

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const ReferenceKind = z.enum(['cites', 'satisfies', 'violates', 'relates', 'supersedes']);
export type ReferenceKind = z.infer<typeof ReferenceKind>;

/** The entity types addressable by a reference, an audit event or an import record. */
export const EntityType = z.enum([
  'project',
  'repo',
  'phase',
  'requirement',
  'task',
  'adr',
  'decision',
  'risk',
  'term',
  'document',
  'document_section',
  'audit',
  'finding',
  'commit',
  'check_run',
  'release',
  'deployment',
  'tech_item',
  'user',
  'api_token',
  'job',
]);
export type EntityType = z.infer<typeof EntityType>;

export const AuditAction = z.enum(['create', 'update', 'delete', 'restore', 'undo']);
export type AuditAction = z.infer<typeof AuditAction>;

/** Who performed a mutation. The MCP shim and the importer are first-class actors. */
export const ActorKind = z.enum(['user', 'mcp', 'importer', 'webhook', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;
