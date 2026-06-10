import { z } from "zod";

const routineVariableLikeNameSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const pipelineStageVariableSchema = z.object({
  key: routineVariableLikeNameSchema,
  label: z.string().trim().max(120),
  type: z.enum(["select", "text", "multiline"]).default("text"),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
  required: z.boolean().optional().default(false),
  showInAddForm: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
});

export const pipelineStageConfigSchema = z.object({
  variables: z.array(pipelineStageVariableSchema).default([]),
}).passthrough().superRefine((value, ctx) => {
  const keys = new Set<string>();
  value.variables.forEach((variable, index) => {
    if (keys.has(variable.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variables", index, "key"],
        message: "Pipeline stage variable keys must be unique",
      });
    }
    keys.add(variable.key);
  });
});

export type PipelineStageVariable = z.infer<typeof pipelineStageVariableSchema>;
export type PipelineStageConfig = z.infer<typeof pipelineStageConfigSchema>;
