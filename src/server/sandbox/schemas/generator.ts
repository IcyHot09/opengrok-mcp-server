import { z } from "zod";

/**
 * Convert a Zod schema to its TypeScript declaration string representation.
 * @param schema — The Zod schema to convert
 * @param registry — Map of Zod object schemas to their named interface names
 */
export function zodToTypeString(schema: z.ZodType, registry: Map<z.ZodType, string> = new Map()): string {
  // Named interface reference
  const registered = registry.get(schema);
  if (registered) {
    return registered;
  }

  // Unwrap optional (emit handled by caller for object fields)
  if (schema instanceof z.ZodOptional) {
    return zodToTypeString(schema.unwrap() as z.ZodType, registry);
  }

  // Nullable: T | null
  if (schema instanceof z.ZodNullable) {
    return `${zodToTypeString(schema.unwrap() as z.ZodType, registry)}|null`;
  }

  // Primitives
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodNull) return "null";
  if (schema instanceof z.ZodUndefined) return "undefined";
  if (schema instanceof z.ZodUnknown) return "unknown";

  // Literals
  if (schema instanceof z.ZodLiteral) {
    const val = schema.value;
    if (typeof val === "string") return `'${val}'`;
    return String(val);
  }

  // Enums
  if (schema instanceof z.ZodEnum) {
    return (schema.options as string[]).map(v => `'${v}'`).join("|");
  }

  // Unions
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as z.ZodType[]).map(o => zodToTypeString(o, registry));
    // Use spaces around | when any member is complex (named type, object literal, or array)
    const isComplex = options.some(o => /[A-Z{]/.test(o) || o.startsWith("Array<"));
    return options.join(isComplex ? " | " : "|");
  }

  // Intersections: A & B
  if (schema instanceof z.ZodIntersection) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Zod 4 internal _def access
    const left = zodToTypeString((schema as any)._def.left, registry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Zod 4 internal _def access
    const right = zodToTypeString((schema as any)._def.right, registry);
    return `${left} & ${right}`;
  }

  // Tuples: [T1, T2, ...]
  if (schema instanceof z.ZodTuple) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zod 4 internal _def access
    const items = ((schema as any)._def.items as z.ZodType[]).map(i => zodToTypeString(i, registry));
    return `[${items.join(", ")}]`;
  }

  // Arrays
  if (schema instanceof z.ZodArray) {
    const inner = zodToTypeString(schema.element as z.ZodType, registry);
    // Use Array<T> when inner type is complex (union, object, intersection)
    const isComplex = inner.includes("|") || inner.includes("{") || inner.includes("&");
    return isComplex ? `Array<${inner}>` : `${inner}[]`;
  }

  // Objects (inline)
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const fields = Object.entries(shape).map(([key, fieldSchema]) => {
      const isOpt = fieldSchema instanceof z.ZodOptional;
      const typeStr = zodToTypeString(fieldSchema, registry);
      return `${key}${isOpt ? "?" : ""}: ${typeStr}`;
    });
    return `{ ${fields.join("; ")} }`;
  }

  // Records
  if (schema instanceof z.ZodRecord) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- Zod 4 internal _def access
    const valType = zodToTypeString((schema as any).element ?? (schema as any)._def.valueType, registry);
    return `Record<string, ${valType}>`;
  }

  return "unknown";
}

/** Schema definition for a named interface. */
export interface InterfaceSchema {
  name: string;
  schema: z.ZodObject<Record<string, z.ZodType>>;
  description?: string;
  featureFlag?: "MEMORY" | "ELICIT" | "SAMPLE";
}

/** Schema definition for a sandbox method. */
export interface MethodSchema {
  name: string;
  description: string;
  params: Array<{ name: string; type: z.ZodType }>;
  returns: z.ZodType;
  featureFlag?: "MEMORY" | "ELICIT" | "SAMPLE";
  sideComment?: string;
  section: string;
}

/** Emit a TypeScript interface declaration line. Registers the schema in the registry. */
export function emitInterface(iface: InterfaceSchema, registry: Map<z.ZodType, string>): string {
  registry.set(iface.schema, iface.name);
  const shape = iface.schema.shape as Record<string, z.ZodType>;
  const fields = Object.entries(shape).map(([key, fieldSchema]) => {
    const isOpt = fieldSchema instanceof z.ZodOptional;
    const typeStr = zodToTypeString(fieldSchema, registry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zod 4 field description access
    const desc = (fieldSchema as any).description as string | undefined;
    const prefix = desc ? `/** ${desc} */ ` : "";
    return `${prefix}${key}${isOpt ? "?" : ""}: ${typeStr}`;
  });
  const flag = iface.featureFlag ? ` // [${iface.featureFlag}]` : "";
  const body = `interface ${iface.name} { ${fields.join("; ")}; }${flag}`;
  if (iface.description) {
    return `/** ${iface.description} */\n${body}`;
  }
  return body;
}

/** Emit a method signature line. Skips JSDoc when description is empty. */
export function emitMethod(method: MethodSchema, registry: Map<z.ZodType, string>): string {
  const params = method.params.map(p => {
    const isOpt = p.type instanceof z.ZodOptional;
    const typeStr = zodToTypeString(p.type, registry);
    return `${p.name}${isOpt ? "?" : ""}: ${typeStr}`;
  });
  const returnStr = zodToTypeString(method.returns, registry);
  // Combine featureFlag and sideComment into a single trailing comment
  const parts = [
    method.featureFlag ? `[${method.featureFlag}]` : "",
    method.sideComment || "",
  ].filter(Boolean);
  const trailing = parts.length > 0 ? ` // ${parts.join(" ")}` : "";
  const sig = `${method.name}(${params.join(", ")}): ${returnStr};${trailing}`;
  if (method.description) {
    const descFlag = method.featureFlag ? ` // [${method.featureFlag}]` : "";
    return `/** ${method.description} */${descFlag}\n${sig}`;
  }
  return sig;
}

/** Section definition for assembleSpec. */
export interface SectionDef {
  header: string;
  sectionComment?: string;
  methods: MethodSchema[];
}

/** Assemble the full API spec string from interfaces and method schemas. */
export function assembleSpec(opts: {
  headerLines: string[];
  interfaces: InterfaceSchema[];
  sections: SectionDef[];
}): string {
  const registry = new Map<z.ZodType, string>();
  const lines: string[] = [];

  // Header comments
  for (const line of opts.headerLines) {
    lines.push(line);
  }
  lines.push("");

  // Interfaces (each registered before any method references them)
  for (const iface of opts.interfaces) {
    lines.push(emitInterface(iface, registry));
  }
  lines.push("");

  // Method sections
  for (const section of opts.sections) {
    lines.push(section.header + (section.sectionComment ? ` ${section.sectionComment}` : ""));
    for (const method of section.methods) {
      lines.push(emitMethod(method, registry));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
