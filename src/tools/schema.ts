export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "array" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export function parseAndValidateArgs(
  rawArgs: string | Record<string, unknown>,
  schema: JsonSchema
): Record<string, unknown> {
  let value: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      value = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (error) {
      throw new Error(`Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  validateValue(value, schema, "arguments");
  return value as Record<string, unknown>;
}

function validateValue(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const required of schema.required ?? []) {
        if (!(required in record)) throw new Error(`${path}.${required} is required`);
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties ?? {}));
        const extra = Object.keys(record).find((key) => !allowed.has(key));
        if (extra) throw new Error(`${path}.${extra} is not allowed`);
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (record[key] !== undefined) validateValue(record[key], child, `${path}.${key}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Error(`${path} must contain at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Error(`${path} must contain at most ${schema.maxItems} items`);
      }
      if (schema.items) value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`));
      return;
    }
    case "string":
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be <= ${schema.maximum}`);
  }
}
