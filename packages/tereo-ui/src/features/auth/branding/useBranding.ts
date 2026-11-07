import { createContext, useContext } from "react";
import type { EffectiveBranding } from "./types";

export const BrandingContext = createContext<EffectiveBranding | null>(null);

export const useBranding = (): EffectiveBranding | null =>
  useContext(BrandingContext);
