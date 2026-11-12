import type { ToolDefinition } from "./types.js";
import { isZodObject } from "./zodObject.js";

const NAME_PATTERN = /^[a-z0-9_]+$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
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
    if (tool.output !== undefined && !isZodObject(tool.output)) {
      throw new Error(
        `Tool "${tool.name}" needs output to be a z.object() schema`
      );
    }
    this.tools.set(tool.name, tool);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  freeze(): void {
    this.frozen = true;
  }
}
