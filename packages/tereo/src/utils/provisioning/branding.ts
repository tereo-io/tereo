import { isAbsolute, relative, resolve, sep } from "path";
import { readFile, realpath, stat } from "fs/promises";
import { AppError } from "../errors.js";
import type { z } from "zod";
import {
  checkImage,
  imageMaxBytes,
  imageTooLarge,
  type CheckedImage,
} from "../branding/images.js";
import {
  BRANDING_IMAGE_SLOTS,
  type BrandingFields,
  type BrandingImageSlot,
  type ProvisionedProfileSchema,
} from "../branding/schema.js";

/** A declared profile with its images read and checked. */
export type LoadedProfile = BrandingFields &
  Partial<Record<BrandingImageSlot, CheckedImage>>;

export interface LoadedBranding {
  default: LoadedProfile | null;
  clients: Record<string, LoadedProfile>;
}

type DeclaredProfile = z.output<typeof ProvisionedProfileSchema>;

/** The profile's fields, its image paths left out. */
export const profileFields = (profile: DeclaredProfile): BrandingFields => {
  const fields: Partial<DeclaredProfile> = { ...profile };
  for (const slot of BRANDING_IMAGE_SLOTS) delete fields[slot];
  return fields as BrandingFields;
};

// By segment: a ConfigMap mount keeps its files under `..<timestamp>/`.
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
};

const readImage = async (
  docDir: string,
  realRoot: string,
  slot: BrandingImageSlot,
  declared: string
): Promise<CheckedImage | string> => {
  let real;
  try {
    real = await realpath(resolve(docDir, declared));
  } catch (err) {
    return `cannot read "${declared}": ${(err as NodeJS.ErrnoException).code ?? "error"}`;
  }
  // realpath follows every link, so a symlink out of the folder fails here.
  if (!inside(realRoot, real))
    return `"${declared}" resolves outside PROVISIONING_PATH`;
  try {
    const info = await stat(real);
    if (!info.isFile()) return `"${declared}" is not a file`;
    // checkImage refuses it too; this spares reading a huge file first.
    if (info.size > imageMaxBytes(slot)) return imageTooLarge(slot).message;
    return await checkImage(slot, await readFile(real));
  } catch (err) {
    if (err instanceof AppError) return err.message;
    return `cannot read "${declared}": ${(err as NodeJS.ErrnoException).code ?? "error"}`;
  }
};

/**
 * Read and check each image a profile declares, its path relative to the
 * document's folder and required to stay inside `realRoot` (PROVISIONING_PATH's
 * folder, links resolved). Problems are recorded as `<label>.<slot>: <reason>`.
 */
export const loadBrandingImages = async (
  docDir: string,
  realRoot: string,
  profile: DeclaredProfile,
  label: string,
  problems: string[]
): Promise<LoadedProfile> => {
  const loaded: LoadedProfile = profileFields(profile);
  for (const slot of BRANDING_IMAGE_SLOTS) {
    const declared = profile[slot];
    if (declared === undefined) continue;
    const image = await readImage(docDir, realRoot, slot, declared);
    if (typeof image === "string") problems.push(`${label}.${slot}: ${image}`);
    else loaded[slot] = image;
  }
  return loaded;
};

/** `default` and each client may be branded by one document of the set. */
export const checkBrandingSet = (
  set: { documents: { file: string; branding?: LoadedBranding }[] },
  problems: string[]
): void => {
  const owners = new Map<string, string[]>();
  const claim = (key: string, file: string) =>
    owners.set(key, [...(owners.get(key) ?? []), file]);
  for (const { file, branding } of set.documents) {
    if (!branding) continue;
    if (branding.default) claim("branding.default", file);
    for (const clientId of Object.keys(branding.clients))
      claim(`branding.clients[${clientId}]`, file);
  }
  for (const [key, files] of owners)
    if (files.length > 1)
      problems.push(
        `${files.join(" and ")}: ${key} is declared in more than one document`
      );
};
