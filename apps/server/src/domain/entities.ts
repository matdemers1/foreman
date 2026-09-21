import { parseHumanId } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType } from '../generated/prisma/enums.js';
import { NotFound } from './errors.js';

/**
 * One entity by human ID, with what cites it.
 *
 * `BND-REQ-021` resolves with no other context — that is the whole argument of ADR-008 — so this is
 * the endpoint that argument pays for. The type segment says which table to look in, which means no
 * fan-out across nine of them for every lookup.
 */

/** The type segment of a human ID, to the entity it names. */
const BY_TYPE: Record<string, EntityType> = {
  REQ: 'requirement',
  T: 'task',
  P: 'phase',
  ADR: 'adr',
  D: 'decision',
  R: 'risk',
  // Every audit's findings share the entity; the prefix says which audit produced them.
  CR: 'finding',
  DA: 'finding',
  FR: 'finding',
  API: 'finding',
  AUD: 'audit',
  IDEA: 'idea',
};

export interface EntityResult {
  readonly type: EntityType;
  readonly humanId: string;
  readonly projectCode: string;
  readonly entity: Record<string, unknown>;
  /** What cites this: the reason the `reference` table exists. */
  readonly backlinks: readonly {
    readonly fromType: string;
    readonly humanId: string | null;
    readonly title: string;
    readonly kind: string;
  }[];
}

export async function getByHumanId(
  db: Db,
  humanId: string,
  options: { backlinks?: boolean } = {},
): Promise<EntityResult> {
  const parsed = parseHumanId(humanId);
  if (parsed === null) {
    // Not a lookup failure: an unprefixed ID is ambiguous by construction, and saying so is more
    // useful than "not found".
    throw new NotFound(
      `${humanId} is not a project-prefixed human ID (expected something like BND-REQ-021)`,
    );
  }

  const type = BY_TYPE[parsed.type];
  if (type === undefined) throw new NotFound(`${humanId} names no kind of entity Foreman knows`);

  const found = await findOne(db, type, humanId);
  if (found === null) throw new NotFound(humanId);

  return {
    type,
    humanId,
    projectCode: parsed.code,
    entity: found.entity,
    backlinks: options.backlinks === false ? [] : await citations(db, type, found.id),
  };
}

async function findOne(
  db: Db,
  type: EntityType,
  humanId: string,
): Promise<{ id: string; entity: Record<string, unknown> } | null> {
  const where = { humanId, deletedAt: null };

  switch (type) {
    case 'requirement': {
      const row = await db.requirement.findFirst({
        where,
        include: {
          phase: { select: { humanId: true, name: true } },
          tasks: { select: { task: { select: { humanId: true, title: true, status: true } } } },
        },
      });
      return row === null
        ? null
        : { id: row.id, entity: { ...row, tasks: row.tasks.map((t) => t.task) } };
    }
    case 'task': {
      const row = await db.task.findFirst({
        where,
        include: {
          phase: { select: { humanId: true, name: true } },
          files: { select: { path: true } },
          requirements: {
            select: { requirement: { select: { humanId: true, statement: true } } },
          },
        },
      });
      return row === null
        ? null
        : {
            id: row.id,
            entity: {
              ...row,
              files: row.files.map((f) => f.path),
              requirements: row.requirements.map((r) => r.requirement),
            },
          };
    }
    case 'phase': {
      const row = await db.phase.findFirst({
        where,
        include: { tasks: { select: { humanId: true, title: true, status: true } } },
      });
      return row === null ? null : { id: row.id, entity: { ...row, number: row.number.toString() } };
    }
    case 'adr': {
      const row = await db.adr.findFirst({
        where,
        include: {
          relations: { select: { kind: true, relatedAdr: { select: { humanId: true, title: true } } } },
        },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'decision': {
      const row = await db.decision.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'risk': {
      const row = await db.risk.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'idea': {
      const row = await db.idea.findFirst({ where });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'finding': {
      const row = await db.finding.findFirst({
        where,
        include: {
          requirement: { select: { humanId: true, statement: true } },
          adr: { select: { humanId: true, title: true } },
        },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    case 'audit': {
      const row = await db.audit.findFirst({
        where,
        include: { findings: { select: { humanId: true, severity: true, status: true, title: true } } },
      });
      return row === null ? null : { id: row.id, entity: row };
    }
    default:
      return null;
  }
}

/** Everything that cites this entity, resolved to something readable. */
async function citations(db: Db, type: EntityType, id: string) {
  const references = await db.reference.findMany({
    where: { toType: type, toId: id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return Promise.all(
    references.map(async (reference) => {
      const source = await findOneById(db, reference.fromType, reference.fromId);
      return {
        fromType: reference.fromType,
        humanId: source?.humanId ?? null,
        title: source?.title ?? '(deleted)',
        kind: reference.kind,
      };
    }),
  );
}

async function findOneById(
  db: Db,
  type: EntityType,
  id: string,
): Promise<{ humanId: string; title: string } | null> {
  switch (type) {
    case 'requirement': {
      const row = await db.requirement.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.statement.slice(0, 120) };
    }
    case 'task': {
      const row = await db.task.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'adr': {
      const row = await db.adr.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'finding': {
      const row = await db.finding.findUnique({ where: { id } });
      return row === null ? null : { humanId: row.humanId, title: row.title };
    }
    case 'document_section': {
      const row = await db.documentSection.findUnique({
        where: { id },
        include: { document: { select: { title: true } } },
      });
      return row === null
        ? null
        : { humanId: row.key, title: `${row.document.title} — ${row.heading}` };
    }
    default:
      return null;
  }
}
