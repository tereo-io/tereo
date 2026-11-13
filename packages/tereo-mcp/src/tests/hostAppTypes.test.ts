import { beforeAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Virtual files live inside the package so that their imports of express and
// @tereo-io/sdk resolve through the real node_modules.
const declarationsDir = join(packageRoot, "__declarations__");
const hostAppFile = join(packageRoot, "__host_app__", "app.ts");

// Lines, not a template: the import sorter would hoist a line that starts
// with `import` out of a template literal.
const hostApp = (...extraImports: string[]): string =>
  [
    ...extraImports,
    'import express from "express";',
    'import type { AuthContext } from "@tereo-io/sdk";',
    'import { hostHeaderValidation, originValidation } from "@tereo-io/mcp";',
    'import { createTestClient } from "@tereo-io/mcp/testing";',
    "type Equal<A, B> =",
    "  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;",
    'const authIsTereos: Equal<NonNullable<express.Request["auth"]>, AuthContext> = true;',
    "const helperIsTyped: Equal<ReturnType<typeof originValidation>, express.RequestHandler> = true;",
    "export const app = express();",
    'app.use(hostHeaderValidation(["mcp.example.com"]));',
    'app.use(originValidation(["app.example.com"]));',
    'app.get("/me", (req, res) => {',
    "  res.json({ userId: req.auth?.userId, authIsTereos, helperIsTyped });",
    "});",
    "export type TestClient = typeof createTestClient;",
  ].join("\n");

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  packageRoot
);

// The package's declarations as an app installing it sees them, emitted from
// src so that a stale dist cannot hide a regression.
const emitDeclarations = (): Map<string, string> => {
  const program = ts.createProgram({
    rootNames: config.fileNames.filter((f) => !f.includes("/tests/")),
    options: {
      ...config.options,
      composite: false,
      incremental: false,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      noEmit: false,
      outDir: declarationsDir,
    },
  });
  const files = new Map<string, string>();
  const result = program.emit(undefined, (fileName, text) => {
    files.set(fileName, text);
  });
  expect(result.diagnostics).toEqual([]);
  return files;
};

const hostAppProgram = (
  declarations: Map<string, string>,
  source: string
): ts.Program => {
  const options: ts.CompilerOptions = {
    ...config.options,
    composite: false,
    incremental: false,
    noEmit: true,
    rootDir: undefined,
    paths: {
      "@tereo-io/mcp": [join(declarationsDir, "index.d.ts")],
      "@tereo-io/mcp/testing": [join(declarationsDir, "testing.d.ts")],
    },
  };
  const virtual = new Map(declarations);
  virtual.set(hostAppFile, source);
  const virtualDirs = new Set([...virtual.keys()].map((f) => dirname(f)));
  const host = ts.createCompilerHost(options);
  const { directoryExists, fileExists, readFile, getSourceFile } = host;
  // Module resolution asks whether a directory exists before looking for
  // files in it, so the virtual directories have to be reported too.
  host.directoryExists = (d) =>
    virtualDirs.has(d) || (directoryExists?.call(host, d) ?? true);
  host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, languageVersion, ...rest) => {
    const text = virtual.get(f);
    return text === undefined
      ? getSourceFile.call(host, f, languageVersion, ...rest)
      : ts.createSourceFile(f, text, languageVersion);
  };
  return ts.createProgram({ rootNames: [hostAppFile], options, host });
};

const errors = (program: ts.Program): string[] =>
  ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));

const loads = (program: ts.Program, name: string): boolean =>
  program.getSourceFiles().some((f) => f.fileName.includes(name));

describe("a host app importing @tereo-io/mcp's validation helpers", () => {
  let declarations: Map<string, string>;

  beforeAll(() => {
    declarations = emitDeclarations();
  }, 60_000);

  it("keeps req.auth as the SDK's AuthContext", () => {
    const program = hostAppProgram(declarations, hostApp());

    expect(errors(program)).toEqual([]);
    expect(loads(program, "__declarations__/validation.d.ts")).toBe(true);
    expect(loads(program, "__declarations__/testing.d.ts")).toBe(true);
    expect(loads(program, "@modelcontextprotocol/express")).toBe(false);
  });

  // The check above can fail: with the MCP SDK's Express package loaded, its
  // AuthInfo becomes req.auth.
  it("would not, if @modelcontextprotocol/express were loaded", () => {
    const program = hostAppProgram(
      declarations,
      hostApp('import "@modelcontextprotocol/express";')
    );

    expect(loads(program, "@modelcontextprotocol/express")).toBe(true);
    expect(errors(program).join("\n")).toMatch(
      /Property 'userId' does not exist on type 'AuthInfo'/
    );
  });
});
