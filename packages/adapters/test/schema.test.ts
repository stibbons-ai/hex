import { afterEach, describe, expect, test } from "bun:test";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, Schema } from "effect";
import { toMastraSchema } from "../src";

const Input = Schema.Struct({ message: Schema.String });
const Output = Schema.Struct({ message: Schema.String, length: Schema.Number });
const decodeOutput = Schema.decodeUnknownEffect(Output);

describe("Effect to Mastra schema bridge", () => {
  test("exposes both standards and wraps each schema only once", async () => {
    const standard = toMastraSchema(Input);
    const properties = standard["~standard"];
    expect(toMastraSchema(Input)).toBe(standard);
    expect(Object.hasOwn(Input, "~standard")).toBe(false);
    expect(properties.vendor).toBe("effect");
    expect(await properties.validate({ message: "hello" })).toEqual({
      value: { message: "hello" },
    });
    expect(properties.jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    });
  });
});

describe("Mastra workflow contract", () => {
  let mastra: Mastra | undefined;
  afterEach(async () => {
    await mastra?.shutdown();
    mastra = undefined;
  });

  /** One step whose raw output comes from `produce`; the step decodes it with Effect. */
  function run(produce: (input: typeof Input.Type) => unknown) {
    let calls = 0;
    const step = createStep({
      id: "echo",
      inputSchema: toMastraSchema(Input),
      outputSchema: toMastraSchema(Output),
      // Mastra does not validate step output, so the step decodes its own (ADR 0002).
      execute: ({ inputData }) => {
        calls++;
        return Effect.runPromise(decodeOutput(produce(inputData)));
      },
    });
    const workflow = createWorkflow({
      id: "echo",
      inputSchema: toMastraSchema(Input),
      outputSchema: toMastraSchema(Output),
      options: { validateInputs: true },
    })
      .then(step)
      .commit();
    const instance = new Mastra({ workflows: { echo: workflow }, logger: false });
    mastra = instance;
    return {
      calls: () => calls,
      async start(inputData: unknown) {
        const created = await instance.getWorkflow("echo").createRun();
        // Deliberately cross the static boundary to exercise Mastra's runtime validation.
        return created.start({ inputData: inputData as typeof Input.Type });
      },
    };
  }

  test("runs a valid input through the step", async () => {
    const workflow = run(({ message }) => ({ message, length: message.length }));
    const result = await workflow.start({ message: "hello" });
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error(JSON.stringify(result));
    expect(result.result).toEqual({ message: "hello", length: 5 });
  });

  test("rejects invalid workflow input with Effect's parse error", async () => {
    const invalid = { message: 42 };
    const effectIssue = (await toMastraSchema(Input)["~standard"].validate(invalid)).issues?.[0];
    expect(effectIssue?.message).toBe("Expected string");

    const workflow = run(() => {
      throw new Error("step must not run");
    });
    await expect(workflow.start(invalid)).rejects.toThrow(`message: ${effectIssue?.message}`);
    expect(workflow.calls()).toBe(0);
  });

  test("fails the run when the step's own output does not decode", async () => {
    const workflow = run(({ message }) => ({ message, length: "five" }));
    const result = await workflow.start({ message: "hello" });
    expect(workflow.calls()).toBe(1);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error(JSON.stringify(result));
    expect(result.steps.echo?.status).toBe("failed");
    expect(result.error.message).toBe('Expected number\n  at ["length"]');
  });
});
