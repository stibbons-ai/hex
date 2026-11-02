import type { Mastra } from "@mastra/core/mastra";
import { ORPCError, implement } from "@orpc/server";
import { contract } from "./contract";

const api = implement(contract).$context<{ mastra: Mastra }>();

function registeredWorkflow(mastra: Mastra, workflowId: string) {
  const workflows = mastra.listWorkflows();
  return Object.hasOwn(workflows, workflowId) ? workflows[workflowId] : undefined;
}

export const router = api.router({
  health: api.health.handler(() => ({ status: "ok" })),
  workflows: {
    list: api.workflows.list.handler(({ context }) => Object.keys(context.mastra.listWorkflows())),
    start: api.workflows.start.handler(async ({ context, input, errors }) => {
      const workflow = registeredWorkflow(context.mastra, input.workflowId);
      if (!workflow) throw errors.NOT_FOUND();
      // Checked here so a bad input is the caller's error, shaped like oRPC's own input check,
      // instead of Mastra's throw surfacing as a 500.
      const checked = await workflow.inputSchema["~standard"].validate(input.inputData);
      if (checked.issues) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Workflow input validation failed",
          data: { issues: checked.issues },
        });
      }
      const run = await workflow.createRun();
      const result = await run.start({ inputData: input.inputData });
      return {
        runId: run.runId,
        status: result.status,
        ...(result.status === "success" ? { result: result.result } : {}),
        ...(result.status === "failed" ? { error: result.error.message } : {}),
      };
    }),
    runs: api.workflows.runs.handler(async ({ context, input, errors }) => {
      const workflow = registeredWorkflow(context.mastra, input.workflowId);
      if (!workflow) throw errors.NOT_FOUND();
      // The contract's output schema keeps only the fields it lists, so snapshots stay out.
      return workflow.listWorkflowRuns();
    }),
  },
});
