import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0193_routine_skip_streak.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("routine skip streak migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("backfills the skip columns onto existing rows and can be reapplied", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-skip-streak-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind to the pre-migration shape, with a routine and a run already in place, so the
    // ALTERs are exercised against populated tables rather than empty ones.
    await sql.unsafe(`
      ALTER TABLE "routines"
        DROP COLUMN "consecutive_skip_count",
        DROP COLUMN "consecutive_skip_reason",
        DROP COLUMN "consecutive_skip_since";
      ALTER TABLE "routine_runs" DROP COLUMN "skip_reason";
    `);

    const [company] = await sql`
      INSERT INTO "companies" (name, issue_prefix) VALUES ('Paperclip', 'SKIP') RETURNING id
    `;
    const [routine] = await sql`
      INSERT INTO "routines" (company_id, title) VALUES (${company.id}, 'Nightly sweep') RETURNING id
    `;
    await sql`
      INSERT INTO "routine_runs" (company_id, routine_id, source, status)
      VALUES (${company.id}, ${routine.id}, 'schedule', 'skipped')
    `;

    const migrationSql = await fs.promises.readFile(
      new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
      "utf8",
    );
    await sql.unsafe(migrationSql);
    // Replaying over an already-migrated database must be a no-op.
    await sql.unsafe(migrationSql);

    const [routineRow] = await sql`
      SELECT consecutive_skip_count, consecutive_skip_reason, consecutive_skip_since
      FROM "routines" WHERE id = ${routine.id}
    `;
    expect(routineRow).toEqual({
      consecutive_skip_count: 0,
      consecutive_skip_reason: null,
      consecutive_skip_since: null,
    });

    const [runRow] = await sql`SELECT skip_reason FROM "routine_runs" WHERE routine_id = ${routine.id}`;
    expect(runRow).toEqual({ skip_reason: null });

    // The count is NOT NULL with a default, so inserts that predate the column still work.
    const [insertedRoutine] = await sql`
      INSERT INTO "routines" (company_id, title) VALUES (${company.id}, 'Weekly digest')
      RETURNING consecutive_skip_count
    `;
    expect(insertedRoutine).toEqual({ consecutive_skip_count: 0 });
  });
});
