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
  // MCP servers may provide JSON Schema keywords that the small built-in validator
  // does not implement. They are passed through to the model and detected at runtime.
  [keyword: string]: unknown;
};

export function parseAndValidateArgs(
  rawArgs: string | Record<string, unknown>,
  schema: JsonSchema
): Record<string, unknown> {
  const value = parseRawArgs(rawArgs);
  validateValue(value, schema, "arguments");
  return value as Record<string, unknown>;
}

export function parseAndValidateExtraArgs(
  rawArgs: string | Record<string, unknown>,
  schema: unknown
): Record<string, unknown> {
  const value = parseRawArgs(rawArgs);
  validatePlainObject(value, "arguments");
  if (supportsSchema(schema)) validateValue(value, schema, "arguments");
  return value;
}

function parseRawArgs(rawArgs: string | Record<string, unknown>): unknown {
  if (typeof rawArgs !== "string") return rawArgs;
  try {
    return rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
  } catch (error) {
    throw new Error(`Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function supportsSchema(value: unknown): value is JsonSchema {
  if (!isPlainObject(value)) return false;
  const schema = value as Record<string, unknown>;
  const supported = new Set([
    "type", "properties", "required", "additionalProperties", "items", "enum",
    "minimum", "maximum", "minItems", "maxItems"
  ]);
  if (Object.keys(schema).some((key) => !supported.has(key))) return false;
  if (!new Set(["object", "string", "number", "integer", "array", "boolean"]).has(schema.type as string)) return false;
  if (schema.properties !== undefined && (
    !isPlainObject(schema.properties) || Object.values(schema.properties).some((child) => !supportsSchema(child))
  )) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.items !== undefined && !supportsSchema(schema.items)) return false;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false;
  for (const key of ["minimum", "maximum", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return false;
  }
  return true;
}

function validatePlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a plain object`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
