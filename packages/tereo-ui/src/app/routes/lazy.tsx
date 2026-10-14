import { lazy, Suspense, type ComponentType } from "react";

type PageComponent = ComponentType;
type Loader = () => Promise<{ default: PageComponent }>;

/**
 * Wraps a dynamically imported page component in a Suspense boundary.
 * Section layouts remain mounted, so a null fallback is intentional — the
 * surrounding chrome stays visible while the page chunk streams in.
 */
export const lazyPage = (loader: Loader) => {
  const Component = lazy(loader);
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  );
};

/**
 * Helper for named exports — converts `{ Foo }` to `{ default: Foo }`.
 */
export const namedLazy = (
  loader: () => Promise<Record<string, PageComponent>>,
  exportName: string
) => lazyPage(() => loader().then((mod) => ({ default: mod[exportName] })));
