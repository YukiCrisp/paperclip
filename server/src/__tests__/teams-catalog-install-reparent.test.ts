import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { teamsCatalogService } from "../services/teams-catalog.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres teams catalog install tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("teams catalog target-manager reparent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome: string | null = null;
  let oldPaperclipHome: string | undefined;

  beforeAll(async () => {
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-teams-catalog-reparent-"));
    process.env.PAPERCLIP_HOME = tempHome;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-catalog-reparent-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (tempHome) await fs.rm(tempHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedCompanyWithExistingExecTeam() {
    const companyId = randomUUID();
    const existingCeoId = randomUUID();
    const existingCtoId = randomUUID();
    const existingQaId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Existing company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: existingCeoId,
        companyId,
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: existingCtoId,
        companyId,
        name: "CTO",
        role: "engineering-manager",
        title: "Chief Technology Officer",
        status: "idle",
        reportsTo: existingCeoId,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: existingQaId,
        companyId,
        name: "QA",
        role: "qa",
        title: "QA Engineer",
        status: "idle",
        reportsTo: existingCtoId,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, existingCeoId };
  }

  async function listCompanyAgents(companyId: string) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    return new Map(rows.map((agent) => [agent.name, agent]));
  }

  const adapterOverrides = {
    ceo: { adapterType: "claude_local" },
    cto: { adapterType: "claude_local" },
    qa: { adapterType: "claude_local" },
  };

  it("reparents the renamed imported root to targetManagerSlug while preserving renamed imported hierarchy", async () => {
    const { companyId, existingCeoId } = await seedCompanyWithExistingExecTeam();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      targetManagerSlug: "ceo",
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
      adapterOverrides,
    });

    const byName = await listCompanyAgents(companyId);
    const importedCeo = byName.get("CEO 2");
    const importedCto = byName.get("CTO 2");
    const importedQa = byName.get("QA 2");

    expect(importedCeo?.reportsTo).toBe(existingCeoId);
    expect(importedCto?.reportsTo).toBe(importedCeo?.id);
    expect(importedQa?.reportsTo).toBe(importedCto?.id);
  });

  it("reparents the renamed imported root to targetManagerAgentId while preserving renamed imported hierarchy", async () => {
    const { companyId, existingCeoId } = await seedCompanyWithExistingExecTeam();
    const svc = teamsCatalogService(db);

    await svc.installCatalogTeam(companyId, "core-exec-team", {
      targetManagerAgentId: existingCeoId,
      collisionStrategy: "rename",
      include: { projects: false, issues: false },
      adapterOverrides,
    });

    const byName = await listCompanyAgents(companyId);
    const importedCeo = byName.get("CEO 2");
    const importedCto = byName.get("CTO 2");
    const importedQa = byName.get("QA 2");

    expect(importedCeo?.reportsTo).toBe(existingCeoId);
    expect(importedCto?.reportsTo).toBe(importedCeo?.id);
    expect(importedQa?.reportsTo).toBe(importedCto?.id);
  });
});
