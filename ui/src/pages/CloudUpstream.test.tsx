// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudUpstreamRun, CloudUpstreamsState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudUpstream, buildActivationRows } from "./CloudUpstream";

const mockCloudUpstreamsApi = vi.hoisted(() => ({
  list: vi.fn(),
  startConnect: vi.fn(),
  finishConnect: vi.fn(),
  preview: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  activateEntities: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/cloudUpstreams", () => ({
  cloudUpstreamsApi: mockCloudUpstreamsApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useLocation: () => ({ search: "" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CloudUpstream", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCloudSync: true });
    mockCloudUpstreamsApi.list.mockResolvedValue(stateWithRun(buildRun({ status: "succeeded" })));
    mockCloudUpstreamsApi.activateEntities.mockImplementation((_connectionId, _runId, input) =>
      Promise.resolve(buildRun({
        status: "succeeded",
        report: {
          activationChecklist: {
            [input.entityType]: {
              entityType: input.entityType,
              count: input.entityType === "agents" ? 2 : 1,
              status: "activated",
              activatedAt: "2026-05-18T19:00:00.000Z",
            },
          },
        },
      })),
    );
    mockCloudUpstreamsApi.createRun.mockResolvedValue(buildRun({ status: "running" }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("binds the succeeded run activation checklist to imported category counts", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudUpstream />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Re-run");
    expect(container.textContent).not.toContain("Retry");
    expect(container.textContent).toContain("Activation checklist");
    expect(container.textContent).toContain("2 paused");
    expect(container.textContent).toContain("1 paused");
    expect(container.textContent).toContain("0 imported monitors in this run.");
    expect(container.textContent).toContain("Keep paused");

    const activateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Activate") as HTMLButtonElement | undefined;
    expect(activateButton).toBeTruthy();

    await act(async () => {
      activateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockCloudUpstreamsApi.activateEntities).toHaveBeenCalledWith(
      "connection-1",
      "run-1",
      { entityType: "agents" },
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps retry only for failed or cancelled runs", async () => {
    mockCloudUpstreamsApi.list.mockResolvedValue(stateWithRun(buildRun({ status: "failed" })));
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudUpstream />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Retry");
    expect(container.textContent).not.toContain("Re-run");
    expect(container.textContent).not.toContain("Activation checklist");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("buildActivationRows", () => {
  it("reads activation decisions from the run report", () => {
    const rows = buildActivationRows(buildRun({
      status: "succeeded",
      report: {
        activationChecklist: {
          agents: {
            entityType: "agents",
            count: 2,
            status: "activated",
            activatedAt: "2026-05-18T19:00:00.000Z",
          },
        },
      },
    }));

    expect(rows[0]).toMatchObject({ key: "agents", count: 2, status: "activated", statusLabel: "2 activated" });
    expect(rows[2]).toMatchObject({ key: "monitors", count: 0, status: "paused", statusLabel: "0 imported" });
  });
});

function stateWithRun(run: CloudUpstreamRun): CloudUpstreamsState {
  return {
    connections: [
      {
        id: "connection-1",
        companyId: "company-1",
        remoteUrl: "https://paperclip.example/PAP",
        target: {
          stackId: "stack-1",
          stackSlug: "stack",
          stackDisplayName: "Paperclip Cloud",
          companyId: "cloud-company-1",
          primaryHost: "paperclip.example",
          origin: "https://paperclip.example",
          product: "Paperclip Cloud",
          schemaMajor: 1,
          maxChunkBytes: 1024,
        },
        tokenStatus: "connected",
        scopes: ["upstream_import:write"],
        authorizedGlobalUserId: "user-1",
        expiresAt: null,
        createdAt: "2026-05-18T18:00:00.000Z",
        updatedAt: "2026-05-18T18:00:00.000Z",
        lastRunId: run.id,
      },
    ],
    runs: [run],
  };
}

function buildRun(input: {
  status: CloudUpstreamRun["status"];
  report?: Record<string, unknown>;
}): CloudUpstreamRun {
  return {
    id: "run-1",
    connectionId: "connection-1",
    companyId: "company-1",
    status: input.status,
    activeStep: input.status === "succeeded" ? "activate" : "push",
    progressPercent: input.status === "running" ? 70 : 100,
    dryRun: false,
    summary: [
      { key: "agents", label: "Agents", count: 2 },
      { key: "routines", label: "Routines", count: 1 },
      { key: "issues", label: "Issues", count: 7 },
    ],
    warnings: [],
    conflicts: [],
    events: [
      {
        id: "event-1",
        at: "2026-05-18T18:30:00.000Z",
        phase: input.status === "succeeded" ? "activate" : "push",
        type: input.status === "failed" ? "failed" : "completed",
        message: input.status === "failed" ? "Push failed." : "Activation checklist is ready.",
      },
    ],
    targetUrl: "https://paperclip.example",
    report: input.report ?? {},
    retryOfRunId: null,
    createdAt: "2026-05-18T18:00:00.000Z",
    updatedAt: "2026-05-18T18:30:00.000Z",
    completedAt: input.status === "running" ? null : "2026-05-18T18:30:00.000Z",
  };
}
