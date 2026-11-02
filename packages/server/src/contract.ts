import { toMastraSchema } from "@hex/adapters";
import { oc } from "@orpc/contract";
import { Schema } from "effect";

const notFound = { NOT_FOUND: { message: "No workflow is registered under this id" } };

/**
 * The oRPC API served under /rpc (ADR 0004). Schemas are Effect Schemas handed over as Standard
 * Schema; like Mastra's, they must have the same Encoded and Type.
 */
export const contract = {
  health: oc.output(toMastraSchema(Schema.Struct({ status: Schema.Literal("ok") }))),
  workflows: {
    /** Ids the workflows are registered under. */
    list: oc.output(toMastraSchema(Schema.Array(Schema.String))),
    /**
     * Runs a workflow to its end and returns how it ended. Input the workflow rejects is a
     * BAD_REQUEST carrying the schema's issues.
     */
    start: oc
      .errors(notFound)
      .input(
        toMastraSchema(Schema.Struct({ workflowId: Schema.String, inputData: Schema.Unknown })),
      )
      .output(
        toMastraSchema(
          Schema.Struct({
            runId: Schema.String,
            status: Schema.Literals(["success", "failed", "tripwire", "suspended", "paused"]),
            result: Schema.optionalKey(Schema.Unknown),
            error: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    /** The workflow's runs as persisted in Mastra's storage. */
    runs: oc
      .errors(notFound)
      .input(toMastraSchema(Schema.Struct({ workflowId: Schema.String })))
      .output(
        toMastraSchema(
          Schema.Struct({
            total: Schema.Number,
            runs: Schema.Array(
              Schema.Struct({
                runId: Schema.String,
                workflowName: Schema.String,
                createdAt: Schema.Date,
                updatedAt: Schema.Date,
              }),
            ),
          }),
        ),
      ),
  },
};
