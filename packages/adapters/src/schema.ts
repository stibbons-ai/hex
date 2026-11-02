// Adapted from stibbons-ai/iconograph packages/adapters/src/schema.ts (code unchanged) at commit
// f15a5f2bb80a6103554b3ad4ff9bec02ef45a018. ADR 0002: re-check this helper (and its contract
// tests) on every Mastra upgrade.
//
// Limit: use schemas whose Encoded and Type are the same. Mastra validates the decoded workflow
// input again at each step's input, so a transforming schema (e.g. Schema.NumberFromString) fails
// there; packages/adapters/test/schema.test.ts pins that behaviour.
import { Schema } from "effect";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "effect/StandardSchema";

type MastraSchema<S extends Schema.ConstraintDecoder<unknown>> = S &
  StandardSchemaV1<S["Encoded"], S["Type"]> &
  StandardJSONSchemaV1<S["Encoded"], S["Type"]>;

const converted = new WeakMap<object, object>();

/**
 * Convert an Effect schema into one Mastra accepts: Standard Schema for validation plus
 * Standard JSON Schema for its JSON Schema. Cached per schema.
 */
export function toMastraSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): MastraSchema<S> {
  const cached = converted.get(schema);
  if (cached) return cached as MastraSchema<S>;

  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
  converted.set(schema, standard);
  return standard;
}
