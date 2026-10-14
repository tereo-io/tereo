import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";
import js from "@eslint/js";

const featureNames = [
  "auth",
  "auth-admin",
  "file-storage",
  "webhooks",
  "notifications",
  "audit-log",
  "api-docs",
  "services",
  "setup",
];

// Each feature may import from:
// - its own subtree (deep paths allowed within itself)
// - other features' public barrel only (./<other>/index.ts)
const crossFeatureZones = featureNames.map((feature) => ({
  target: `./src/features/${feature}`,
  from: "./src/features",
  except: [
    `./${feature}`,
    ...featureNames
      .filter((other) => other !== feature)
      .map((other) => `./${other}/index.ts`),
  ],
  message: `Feature "${feature}" must import other features via their public barrel (@/features/<name>), not deep paths.`,
}));

// App layer (except route files) must use feature barrels.
// `app/routes/*` is exempt: lazy `import()` calls there need per-route deep
// paths so the bundler can split each page into its own chunk. A barrel-only
// rule would collapse the entire feature into one lazy chunk.
const appToFeatureBarrelOnly = {
  target: [
    "./src/app/layouts",
    "./src/app/index.tsx",
    "./src/app/provider.tsx",
    "./src/app/router.tsx",
  ],
  from: "./src/features",
  except: featureNames.map((feature) => `./${feature}/index.ts`),
  message:
    "App layer must import features via their public barrel (@/features/<name>), not deep paths.",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      import: importPlugin,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            // Prevent cross-feature imports
            ...crossFeatureZones,

            // App layer must use feature barrels (no deep paths into features)
            appToFeatureBarrelOnly,

            // Prevent features from importing from app layer
            {
              target: "./src/features",
              from: "./src/app",
              message:
                "Features cannot import from the app layer. Flow is: shared → features → app.",
            },

            // Prevent shared code from importing from features or app
            {
              target: [
                "./src/components",
                "./src/hooks",
                "./src/lib",
                "./src/types",
                "./src/utils",
              ],
              from: ["./src/features", "./src/app"],
              message:
                "Shared code (components, hooks, lib, types, utils) cannot import from features or app.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  }
);
