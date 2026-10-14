import tseslint from "typescript-eslint";
import eslint from "@eslint/js";

// A Pino call on `logger`, `log`, `this.logger`, … — the object argument is a
// direct child of the call.
const LOG_CALL =
  "CallExpression:matches([callee.object.name=/^(logger|log)$/], [callee.object.property.name=/^(logger|log)$/])[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > ObjectExpression";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      "**/dist/",
      "**/build/",
      "**/node_modules/",
      "**/generated/",
      "local/",
      // Linted from its own directory, with its own config (npm run lint).
      "packages/tereo-ui/",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "always" },
      ],
      "@typescript-eslint/no-namespace": "off",
      // Pino serializes an Error, with its stack, only under `err`.
      "no-restricted-syntax": [
        "error",
        {
          selector: `${LOG_CALL} > Property[key.name='error']`,
          message:
            "Log the error itself under `err` (`{ err }`), not under `error`.",
        },
        {
          selector: `${LOG_CALL} > Property[key.name='err']:matches([value.type='MemberExpression'][value.property.name='message'], [value.type='CallExpression'][value.callee.name='String'], [value.type='ConditionalExpression'], [value.type='TemplateLiteral'])`,
          message:
            "Log the error itself under `err` (`{ err }`), not its message.",
        },
      ],
    },
  }
);
