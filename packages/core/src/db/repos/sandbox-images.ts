// Sandbox images the instance operator registered with the provider (#809). One instance-scope row
// of the settings table holds them all, by snapshot name. It is not a registry setting: only
// `register_sandbox_image` writes it, after the provider made the snapshot, so no settings op and
// no configuration layer can name an image the provider never registered.
import type { Db } from "..";
import { getStoredSetting, putStoredSetting, type SettingTarget } from "./settings";

export const SANDBOX_IMAGES_KEY = "sandbox_images";
const INSTANCE: SettingTarget = { kind: "instance", id: "", orgId: null };

/** Where an image came from: Turntable's own registry, or a ref the operator chose. */
export type ImageSource = "turntable" | "operator";

export type SandboxImage = {
  /** The provider snapshot sandboxes start from. */
  name: string;
  /** `repository@sha256:...`: what the provider pulled, by digest. */
  image: string;
  digest: string;
  source: ImageSource;
  provider: string;
  state: "pending" | "ready";
  registeredBy: string;
  registeredAt: number;
};

/** Turntable's own images. Anything else is an operator-registered ref. */
export const TURNTABLE_REGISTRY = "ghcr.io/turntable-ci/";

function decode(value: unknown): Record<string, SandboxImage> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, SandboxImage> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const i = v as Partial<SandboxImage> | null;
    if (
      i &&
      typeof i.name === "string" &&
      i.name === k &&
      typeof i.image === "string" &&
      typeof i.digest === "string"
    )
      out[k] = i as SandboxImage;
  }
  return out;
}

export async function listSandboxImages(db: Db): Promise<SandboxImage[]> {
  const row = await getStoredSetting(db, INSTANCE, SANDBOX_IMAGES_KEY);
  return Object.values(decode(row?.value)).toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function getSandboxImage(db: Db, name: string): Promise<SandboxImage | undefined> {
  const row = await getStoredSetting(db, INSTANCE, SANDBOX_IMAGES_KEY);
  const all = decode(row?.value);
  return Object.hasOwn(all, name) ? all[name] : undefined;
}

/** Records (or replaces) one image. A compare-and-set, retried, so two writers never lose one. */
export async function putSandboxImage(db: Db, img: SandboxImage): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const row = await getStoredSetting(db, INSTANCE, SANDBOX_IMAGES_KEY);
    const all = { ...decode(row?.value), [img.name]: img };
    if (
      await putStoredSetting(
        db,
        INSTANCE,
        SANDBOX_IMAGES_KEY,
        all,
        img.registeredBy,
        img.registeredAt,
        {
          raw: row?.raw,
        },
      )
    )
      return;
  }
  throw new Error("sandbox images: the record kept changing under the write; try again");
}
