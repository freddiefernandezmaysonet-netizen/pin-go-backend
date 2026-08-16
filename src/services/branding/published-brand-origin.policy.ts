import {
  resolvePublishedBrandContextByHostname,
  type HostnameBrandResolution,
} from "./published-brand-context.service.js";

type BrandContextResolver = (
  hostname: string
) => Promise<HostnameBrandResolution>;

export type PublishedBrandOriginPolicyOptions = {
  resolveBrandContext?: BrandContextResolver;
};

export function hostnameFromSecureRequestOrigin(
  rawOrigin: string | null | undefined
): string | null {
  const origin = String(rawOrigin ?? "").trim();
  if (!origin) return null;

  const authority = origin
    .replace(/^https:\/\//i, "")
    .replace(/\/$/, "");
  if (authority.includes(":")) return null;

  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.port
    ) {
      return null;
    }

    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export async function isPublishedBrandOriginAllowed(
  rawOrigin: string | null | undefined,
  options: PublishedBrandOriginPolicyOptions = {}
): Promise<boolean> {
  const hostname = hostnameFromSecureRequestOrigin(rawOrigin);
  if (!hostname) return false;

  const resolveBrandContext =
    options.resolveBrandContext ?? resolvePublishedBrandContextByHostname;
  const context = await resolveBrandContext(hostname);

  return (
    context.kind === "CUSTOM_BRAND" &&
    context.customDomain === hostname
  );
}
