// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueStatusBadge, IssueStatusGlyph } from "./StatusBadge";
import { brandChipBadge, issueStatusColor } from "../lib/status-colors";

/**
 * PAP-99 (PAP-95e): issue/task status chips adopt the PAP-75 brand palette and
 * carry their glyph icon. These tests lock the colour mapping ("blue =
 * liveness": todo → amber, in_progress → blue, in_review → violet) and assert a
 * glyph is always present, against the brand `.task-chip` tokens.
 */
describe("IssueStatusBadge", () => {
  it("maps each issue status to its PAP-75 brand colour token", () => {
    const cases: Record<string, keyof typeof brandChipBadge> = {
      backlog: "gray",
      todo: "amber",
      in_progress: "blue",
      in_review: "violet",
      done: "green",
      blocked: "red",
      cancelled: "gray",
    };
    for (const [status, color] of Object.entries(cases)) {
      expect(issueStatusColor[status]).toBe(color);
      const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
      // Brand chip carries a 1px border + the colour's light + dark classes.
      expect(html).toContain("border");
      expect(html).toContain(brandChipBadge[color].split(" ")[0]); // light bg hex
      // Every chip carries a glyph (inline SVG).
      expect(html).toContain("<svg");
      // Human-readable label, underscores spaced out.
      expect(html).toContain(status.replace(/_/g, " "));
    }
  });

  it("uses liveness blue for in_progress (not amber) and amber for todo (not blue)", () => {
    const prog = renderToStaticMarkup(<IssueStatusBadge status="in_progress" />);
    expect(prog).toContain("#DBEAFE"); // blue light bg
    expect(prog).not.toContain("#FEF3C7"); // not amber
    const todo = renderToStaticMarkup(<IssueStatusBadge status="todo" />);
    expect(todo).toContain("#FEF3C7"); // amber light bg
    expect(todo).not.toContain("#DBEAFE"); // not blue
  });

  it("renders in_review with the reserved violet token", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="in_review" />);
    expect(html).toContain("#EDE9FE");
    expect(html).toContain("#7C3AED");
  });

  it("strikes through cancelled chips", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="cancelled" />);
    expect(html).toContain("line-through");
  });

  it("falls back to the gray token for unknown statuses", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="mystery" />);
    expect(html).toContain(brandChipBadge.gray.split(" ")[0]);
  });
});

describe("IssueStatusGlyph", () => {
  it("gives in_progress a half-filled ring (liveness)", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="in_progress" />);
    // Open ring + the right-half semicircle fill path from status-reference.html.
    expect(html).toContain('d="M6 1.5 A4.5 4.5 0 0 1 6 10.5 Z"');
  });

  it("gives in_review a ring + centre dot (not a clock)", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="in_review" />);
    expect(html).toContain('r="2"');
  });

  it("gives done a filled circle with a knocked-out check", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="done" />);
    expect(html).toContain('d="M3.5 6 5.5 8 8.5 4.5"');
    expect(html).toContain("stroke-background");
  });

  it("gives blocked a ring + bar", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="blocked" />);
    expect(html).toContain("<rect");
  });

  it("gives backlog a dashed ring", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="backlog" />);
    expect(html).toContain('stroke-dasharray="2 2"');
  });

  it("gives cancelled a ring + slash", () => {
    const html = renderToStaticMarkup(<IssueStatusGlyph status="cancelled" />);
    expect(html).toContain('d="M3 9 9 3"');
  });
});
