export interface OriginAllowlist {
  readonly origins: readonly string[];
  allowsOrigin(origin: string | undefined): boolean;
  allowsUrl(url: string | undefined): boolean;
}

/**
 * Normalizes an exact HTTPS URL or origin to canonical `https://host[:port]` form.
 * Rejects non-HTTPS schemes, credentials, wildcards, and opaque origins.
 */
export function canonicalHttpsOrigin(input: string): string | undefined {
  if (typeof input !== 'string' || input.trim().length === 0) return;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:') return;
  if (parsed.username !== '' || parsed.password !== '') return;
  if (!parsed.hostname || parsed.hostname.includes('*')) return;
  return parsed.origin;
}

/**
 * Validates that every configured entry is a bare exact HTTPS origin (no path/query/hash/wildcard).
 */
export function createOriginAllowlist(origins: readonly string[]): OriginAllowlist {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new RangeError('allowedOrigins must contain at least one exact HTTPS origin');
  }
  const canonical = new Set<string>();
  for (const raw of origins) {
    const normalized = canonicalHttpsOrigin(raw);
    if (!normalized) {
      throw new RangeError(`Invalid allowedOrigin "${String(raw)}": expected exact https://host[:port]`);
    }
    const parsed = new URL(raw);
    if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') {
      throw new RangeError(`Invalid allowedOrigin "${raw}": origin must not include path, query, or fragment`);
    }
    if (raw.endsWith('/') && raw !== `${normalized}/`) {
      throw new RangeError(`Invalid allowedOrigin "${raw}": expected exact https://host[:port]`);
    }
    canonical.add(normalized);
  }
  const list = Object.freeze([...canonical]);
  return {
    origins: list,
    allowsOrigin(origin: string | undefined): boolean {
      if (typeof origin !== 'string') return false;
      const normalized = canonicalHttpsOrigin(origin);
      return normalized !== undefined && canonical.has(normalized);
    },
    allowsUrl(url: string | undefined): boolean {
      if (typeof url !== 'string') return false;
      const normalized = canonicalHttpsOrigin(url);
      return normalized !== undefined && canonical.has(normalized);
    },
  };
}
