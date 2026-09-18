import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORBIDDEN_ESTIMATE_FIELDS } from '@foreman/shared';
import { describe, expect, it } from 'vitest';

/**
 * FRM-REQ-041 — **no time estimate exists anywhere.** Not in the schema, not in the API, not in a
 * form.
 *
 * This is one of the anti-features recorded as a requirement asserting its own absence, so that it
 * cannot quietly arrive. The operator's standing position is that AI-assisted development makes an
 * estimate in days meaningless; what survives is a T-shirt size and a dependency order.
 *
 * The check reads the Prisma schema rather than the generated client, because the schema is where
 * such a field would be added — usually with a good reason, at the end of a long day.
 */

const SERVER = resolve(import.meta.dirname, '../..');
const SCHEMA = readFileSync(resolve(SERVER, 'prisma/schema.prisma'), 'utf8');

/** Field declarations: the name is the first token on a line inside a model block. */
function declaredFields(schema: string): { model: string; field: string }[] {
  const fields: { model: string; field: string }[] = [];
  let model: string | null = null;

  for (const raw of schema.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('///')) continue;

    const opened = /^model\s+(\w+)\s*\{/.exec(line);
    if (opened !== null) {
      model = opened[1] ?? null;
      continue;
    }
    if (line === '}') {
      model = null;
      continue;
    }
    if (model === null || line.startsWith('@@')) continue;

    const field = /^(\w+)\s+\S+/.exec(line);
    if (field?.[1] !== undefined) fields.push({ model, field: field[1] });
  }
  return fields;
}

describe('no time estimates (FRM-REQ-041)', () => {
  const fields = declaredFields(SCHEMA);

  it('parsed the schema, so the check is not passing by reading nothing', () => {
    expect(fields.length).toBeGreaterThan(200);
    // A field that certainly exists, proving the parser finds real ones.
    expect(fields).toContainEqual({ model: 'Phase', field: 'sortOrder' });
  });

  it('declares no estimate-shaped column in any model', () => {
    const offending = fields.filter(({ field }) =>
      FORBIDDEN_ESTIMATE_FIELDS.some((banned) => field.toLowerCase() === banned.toLowerCase()),
    );
    expect(
      offending,
      'Foreman records T-shirt sizes and dependency order, never time. See FRM-REQ-041.',
    ).toEqual([]);
  });

  it('keeps the sizes it does record as T-shirts, not numbers', () => {
    // `size` is the sanctioned field, and its type must stay the enum.
    expect(SCHEMA).toMatch(/enum Size \{\s*\n\s*XS/);
    const sizeFields = fields.filter((f) => f.field === 'size');
    expect(sizeFields.length).toBeGreaterThan(0);
    for (const { model } of sizeFields) {
      const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA)?.[0] ?? '';
      expect(block).toMatch(/size\s+Size/);
    }
  });

  it('has no sprint, velocity or burndown anywhere in the schema', () => {
    // The vocabulary is the tell: these words arrive together, and none of them belong here.
    for (const word of ['sprint', 'velocity', 'burndown', 'storyPoint', 'story_point']) {
      expect(SCHEMA.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
