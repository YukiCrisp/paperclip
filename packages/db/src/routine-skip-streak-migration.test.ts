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

  it("adds the skip columns to pre-migration tables and can be reapplied", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-routine-skip-streak-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Minimal stand-ins for the pre-migration tables the ALTERs touch.
    await sql.unsafe(`
      CREATE TABLE "routines" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL);
      CREATE TABLE "routine_runs" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL);
      INSERT INTO "routines" (title) VALUES ('existing routine');
      INSERT INTO "routine_runs" (status) VALUES ('skipped');
    `);

    const migrationSql = await fs.promises.readFile(
      new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
      "utf8",
    );
    await sql.unsafe(migrationSql);
    // Re-running must be a no-op, matching how migrations are replayed over existing databases.
    await sql.unsafe(migrationSql);

    const [routineRow] = await sql`
      SELECT consecutive_skip_count, consecutive_skip_reason, consecutive_skip_since FROM "routines"
    `;
    expect(routineRow).toEqual({
      consecutive_skip_count: 0,
      consecutive_skip_reason: null,
      consecutive_skip_since: null,
    });

    const [runRow] = await sql`SELECT skip_reason FROM "routine_runs"`;
    expect(runRow).toEqual({ skip_reason: null });
  });
});
