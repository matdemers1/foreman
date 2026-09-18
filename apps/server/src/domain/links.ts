import { parseHumanId } from '@foreman/shared';
import type { Db } from '../db.js';
import type { EntityType, ReferenceKind } from '../generated/prisma/enums.js';
import { record, type Actor } from './audit.js';
import { getByHumanId } from './entities.js';
import { Invalid } from './errors.js';

/**
 * Citations between entities.
 *
 * A `reference` row is what makes backlinks possible and what coverage is computed from. Two kinds
 * of link are more than a citation and are kept in their own columns as well: task↔requirement is a
 * `task_requirement` row (it is how coverage is counted), and ADR↔ADR is an `adr_relation` (it is
 * how a superseded decision knows what replaced it). The `reference` row is written either way, so
 * the backlinks are uniform.
 */

/** The entity a human ID's type segment names. */
function typeOf(humanId: string): EntityType {
  const parsed = parseHumanId(humanId);
  if (parsed === null) throw new Invalid(`${humanId} is not a project-prefixed human ID`);

  const map: Record<string, EntityType> = {
    REQ: 'requirement',
    T: 'task',
    P: 'phase',
    ADR: 'adr',
    D: 'decision',
    R: 'risk',
    CR: 'finding',
    DA: 'finding',
    FR: 'finding',
    API: 'finding',
    AUD: 'audit',
  };
  const type = map[parsed.type];
  if (type === undefined) throw new Invalid(`${humanId} names no kind of entity Foreman knows`);
  return type;
}

export interface LinkResult {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly created: boolean;
}

export async function link(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: ReferenceKind | 'extends',
): Promise<LinkResult> {
  const fromType = typeOf(from);
  const toType = typeOf(to);

  // Both must exist. A citation of something absent is not a link, it is a typo.
  const [source, target] = await Promise.all([
    getByHumanId(db, from, { backlinks: false }),
    getByHumanId(db, to, { backlinks: false }),
  ]);
  const fromId = String(source.entity['id']);
  const toId = String(target.entity['id']);

  // `extends` is an ADR relation and not a reference kind; every other kind is both.
  const referenceKind: ReferenceKind = kind === 'extends' ? 'relates' : kind;

  return db.$transaction(async (tx) => {
    const existing = await tx.reference.findUnique({
      where: {
        fromType_fromId_toType_toId_kind: {
          fromType,
          fromId,
          toType,
          toId,
          kind: referenceKind,
        },
      },
    });

    if (existing === null) {
      await tx.reference.create({
        data: { fromType, fromId, toType, toId, kind: referenceKind, citedAs: to },
      });
    }

    // Coverage counts `task_requirement`, not references, so the link has to land there too.
    if (fromType === 'task' && toType === 'requirement') {
      await tx.taskRequirement.upsert({
        where: { taskId_requirementId: { taskId: fromId, requirementId: toId } },
        create: { taskId: fromId, requirementId: toId },
        update: {},
      });
    }

    if (fromType === 'adr' && toType === 'adr') {
      const relationKind = kind === 'supersedes' ? 'supersedes' : 'extends';
      await tx.adrRelation.upsert({
        where: { adrId_relatedAdrId_kind: { adrId: fromId, relatedAdrId: toId, kind: relationKind } },
        create: { adrId: fromId, relatedAdrId: toId, kind: relationKind },
        update: {},
      });
      // A supersedes edge is also a status change on the ADR it replaces.
      if (relationKind === 'supersedes') {
        await tx.adr.update({ where: { id: toId }, data: { status: 'superseded' } });
        await tx.adrRelation.upsert({
          where: {
            adrId_relatedAdrId_kind: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' },
          },
          create: { adrId: toId, relatedAdrId: fromId, kind: 'superseded_by' },
          update: {},
        });
      }
    }

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: fromType,
      entityId: fromId,
      entityHumanId: from,
      after: { event: 'link', to, kind },
    });

    return { from, to, kind, created: existing === null };
  });
}

export async function unlink(
  db: Db,
  actor: Actor,
  from: string,
  to: string,
  kind: ReferenceKind | 'extends',
): Promise<LinkResult> {
  const fromType = typeOf(from);
  const toType = typeOf(to);

  const [source, target] = await Promise.all([
    getByHumanId(db, from, { backlinks: false }),
    getByHumanId(db, to, { backlinks: false }),
  ]);
  const fromId = String(source.entity['id']);
  const toId = String(target.entity['id']);
  const referenceKind: ReferenceKind = kind === 'extends' ? 'relates' : kind;

  return db.$transaction(async (tx) => {
    const { count } = await tx.reference.deleteMany({
      where: { fromType, fromId, toType, toId, kind: referenceKind },
    });

    if (fromType === 'task' && toType === 'requirement') {
      await tx.taskRequirement.deleteMany({ where: { taskId: fromId, requirementId: toId } });
    }
    if (fromType === 'adr' && toType === 'adr') {
      await tx.adrRelation.deleteMany({ where: { adrId: fromId, relatedAdrId: toId } });
    }

    await record(tx, {
      ...actor,
      action: 'delete',
      entityType: fromType,
      entityId: fromId,
      entityHumanId: from,
      // Recorded in full, because an unlink is what `POST /undo` has to be able to put back.
      before: { event: 'link', to, kind },
      after: { event: 'unlink', to, kind },
    });

    return { from, to, kind, created: false, removed: count > 0 } as LinkResult;
  });
}
