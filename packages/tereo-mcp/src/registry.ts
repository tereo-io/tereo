import type { ResourceDefinition, ToolDefinition } from "./types.js";
import { isZodObject, toJsonSchemaError } from "./zodObject.js";

const NAME_PATTERN = /^[a-z0-9_]+$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly resources = new Map<string, ResourceDefinition>();
  private frozen = false;

  define(tool: ToolDefinition): void {
    if (this.frozen)
      throw new Error("Tools cannot be defined after the server has started");
    if (typeof tool.name !== "string" || !NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Tool name ${JSON.stringify(tool.name)} must match ${NAME_PATTERN.source}`
      );
    }
    if (this.tools.has(tool.name))
      throw new Error(`Tool "${tool.name}" is already defined`);
    if (
      typeof tool.description !== "string" ||
      tool.description.trim() === ""
    ) {
      throw new Error(`Tool "${tool.name}" needs a non-empty description`);
    }
    // undefined is rejected so that forgetting the permission cannot silently mean "open to all"
    if (
      tool.permission !== null &&
      (typeof tool.permission !== "string" || tool.permission === "")
    ) {
      throw new Error(
        `Tool "${tool.name}" needs a permission: a non-empty string, or null for none`
      );
    }
    if (typeof tool.readOnly !== "boolean") {
      throw new Error(
        `Tool "${tool.name}" needs readOnly set to true or false`
      );
    }
    if (
      tool.title !== undefined &&
      (typeof tool.title !== "string" || tool.title.trim() === "")
    ) {
      throw new Error(
        `Tool "${tool.name}" needs title, when given, to be a non-empty string`
      );
    }
    if (
      tool.timeoutMs !== undefined &&
      !(Number.isInteger(tool.timeoutMs) && tool.timeoutMs > 0)
    ) {
      throw new Error(
        `Tool "${tool.name}" needs timeoutMs to be a positive integer, not ${String(tool.timeoutMs)}`
      );
    }
    if (tool.rateLimit !== undefined && tool.rateLimit !== false) {
      if (typeof tool.rateLimit !== "object" || tool.rateLimit === null) {
        throw new Error(
          `Tool "${tool.name}" needs rateLimit to be { perMinute } or false`
        );
      }
      const { perMinute } = tool.rateLimit;
      if (!(Number.isInteger(perMinute) && perMinute > 0)) {
        throw new Error(
          `Tool "${tool.name}" needs rateLimit.perMinute to be a positive integer, not ${String(perMinute)}`
        );
      }
    }
    if (tool.ui !== undefined) {
      const { ui } = tool;
      if (
        typeof ui !== "object" ||
        ui === null ||
        typeof ui.resourceUri !== "string" ||
        !ui.resourceUri.startsWith("ui://")
      ) {
        throw new Error(
          `Tool "${tool.name}" needs ui.resourceUri to be a string starting with ui://`
        );
      }
      if (ui.visibility !== undefined) {
        const seen: unknown = ui.visibility;
        if (
          !Array.isArray(seen) ||
          seen.length === 0 ||
          new Set(seen).size !== seen.length ||
          !seen.every((v) => v === "model" || v === "app")
        ) {
          throw new Error(
            `Tool "${tool.name}" needs ui.visibility to be a non-empty list of unique "model" or "app" values`
          );
        }
      }
    }
    if (tool.output !== undefined && !isZodObject(tool.output)) {
      throw new Error(
        `Tool "${tool.name}" needs output to be a z.object() schema`
      );
    }
    for (const io of ["input", "output"] as const) {
      const schema = tool[io];
      if (schema === undefined || typeof schema === "function") continue;
      // At define time the schema is the author's code, so its message is safe to show.
      const failure = toJsonSchemaError(schema, io);
      if (failure !== undefined) {
        const detail =
          failure instanceof Error ? failure.message : String(failure);
        throw new Error(
          `Tool "${tool.name}" needs an ${io} schema that can be expressed as JSON Schema: ${detail}`,
          { cause: failure }
        );
      }
    }
    this.tools.set(tool.name, tool);
  }

  defineResource(resource: ResourceDefinition): void {
    if (this.frozen)
      throw new Error(
        "Resources cannot be defined after the server has started"
      );
    for (const key of ["uri", "name", "mimeType"] as const) {
      const value: unknown = resource[key];
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`A resource needs ${key} to be a non-empty string`);
      }
    }
    let normalised: string | undefined;
    try {
      normalised = new URL(resource.uri).toString();
    } catch {
      normalised = undefined;
    }
    if (normalised !== resource.uri) {
      throw new Error(
        `resource uri ${JSON.stringify(resource.uri)} must be an absolute, normalised URL`
      );
    }
    if (typeof resource.read !== "function") {
      throw new Error(`Resource "${resource.uri}" needs a read function`);
    }
    if (this.resources.has(resource.uri))
      throw new Error(`Resource "${resource.uri}" is already defined`);
    this.resources.set(resource.uri, resource);
  }

  listResources(): readonly ResourceDefinition[] {
    return [...this.resources.values()];
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  freeze(): void {
    this.frozen = true;
  }
}
