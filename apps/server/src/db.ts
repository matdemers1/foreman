import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type Db = PrismaClient;

export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export { Prisma } from './generated/prisma/client.js';

/**
 * A payload or stage output on its way into a `Json` column. Prisma distinguishes "SQL NULL" from
 * "JSON null" and refuses a bare `null`, so the absence of a value is spelled once, here.
 */
export type JsonObject = Record<string, unknown>;
