import { AxiError } from "axi-sdk-js";

export type FlagType = "string" | "boolean" | "number" | "list";

export interface FlagSpec {
  name: string; // without leading dashes
  type: FlagType;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  values?: readonly string[]; // allowed values for string flags
}

export type FlagValues = Record<string, string | number | boolean | string[] | undefined>;

export interface ParsedArgs {
  positionals: string[];
  flags: FlagValues;
}

/**
 * Strict flag parser: unknown flags are fatal (exit 2) and list the valid ones,
 * as AXI principle 6 asks. Supports `--flag value`, `--flag=value` and bare booleans.
 * `list` flags may repeat (`--query a=b --query c=d`).
 */
export function parseArgs(args: string[], specs: FlagSpec[], usage: string): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const flags: FlagValues = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const spec = byName.get(name);
    if (!spec) {
      throw new AxiError(`Unknown flag --${name}`, "VALIDATION_ERROR", [
        `Valid flags: ${specs.map((s) => `--${s.name}`).join(", ") || "(none)"}`,
        `Usage: ${usage}`,
      ]);
    }
    let raw: string | undefined;
    if (eq !== -1) {
      raw = arg.slice(eq + 1);
    } else if (spec.type !== "boolean") {
      raw = args[i + 1];
      if (raw === undefined || (raw.startsWith("--") && raw.length > 2)) {
        throw new AxiError(`Flag --${name} needs a value`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
      }
      i++;
    }
    flags[name] = coerce(spec, raw, usage, flags[name]);
  }

  for (const spec of specs) {
    if (flags[spec.name] === undefined && spec.default !== undefined) {
      flags[spec.name] = spec.default;
    }
    if (spec.required && flags[spec.name] === undefined) {
      throw new AxiError(`Missing required flag --${spec.name}`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
    }
  }
  return { positionals, flags };
}

function coerce(spec: FlagSpec, raw: string | undefined, usage: string, previous: FlagValues[string]) {
  switch (spec.type) {
    case "boolean":
      if (raw === undefined || raw === "true") return true;
      if (raw === "false") return false;
      throw new AxiError(`Flag --${spec.name} takes true or false`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
    case "number": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new AxiError(`Flag --${spec.name} needs a non-negative integer`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
      }
      return n;
    }
    case "list": {
      const list = Array.isArray(previous) ? previous : [];
      return [...list, raw ?? ""];
    }
    default:
      if (spec.values && !spec.values.includes(raw ?? "")) {
        throw new AxiError(`Invalid value for --${spec.name}: ${raw}`, "VALIDATION_ERROR", [
          `Allowed: ${spec.values.join(", ")}`,
        ]);
      }
      return raw;
  }
}

export function requirePositional(parsed: ParsedArgs, index: number, label: string, usage: string): string {
  const value = parsed.positionals[index];
  if (!value) {
    throw new AxiError(`Missing ${label}`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
  }
  return value;
}

export function rejectExtraPositionals(parsed: ParsedArgs, expected: number, usage: string): void {
  if (parsed.positionals.length > expected) {
    throw new AxiError(`Unexpected argument: ${parsed.positionals[expected]}`, "VALIDATION_ERROR", [`Usage: ${usage}`]);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string, label: string): string {
  if (!UUID.test(value)) {
    throw new AxiError(`${label} must be a UUID, got: ${value}`, "VALIDATION_ERROR", [
      "Find ids with the matching `list` command",
    ]);
  }
  return value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!DATE.test(value)) {
    throw new AxiError(`${label} must be YYYY-MM-DD, got: ${value}`, "VALIDATION_ERROR");
  }
  return value;
}
