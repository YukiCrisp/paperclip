import { describe, expect, it } from "vitest";
import { pipelineStageConfigSchema } from "./pipeline.js";

describe("pipeline stage variable schema", () => {
  it("validates select variables require options", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [{ key: "status", type: "select", options: ["open", "done"] }],
      }).success,
    ).toBe(true);

    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [{ key: "status", type: "select", options: [] }],
      }).success,
    ).toBe(false);
  });

  it("enforces unique variable keys in stage config", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [
          { key: "repo", type: "text" },
          { key: "repo", type: "text" },
        ],
      }).success,
    ).toBe(false);
  });
});
