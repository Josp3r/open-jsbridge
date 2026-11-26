import { ErrorCode } from '../../protocol/src/index.js';

export type AclFrameScope = 'main' | 'any';

export interface AclRateLimit {
  perSecond: number;
}

export interface AclRule {
  origins: readonly string[];
  frames?: AclFrameScope;
  allow?: readonly string[];
  deny?: readonly string[];
  rateLimit?: AclRateLimit;
}

export interface AclConfig {
  version: 1;
  rules: readonly AclRule[];
  default: 'deny';
}

export interface CallerContext {
  readonly origin?: string;
  readonly isMainFrame?: boolean;
}

export interface AclPolicyOptions {
  /**
   * Whether the host platform actually provides verified iframe document binding (protocol F5).
   * When false (default), `frames: "any"` rules cannot enable non-main frames.
   */
  supportsIframe?: boolean;
  /** Optional monotonic/wall clock in milliseconds for deterministic rate-limit testing. */
  now?: () => number;
}

export type AclDenyReason =
  | 'origin_not_allowed'
  | 'frame_not_allowed'
  | 'acl_denied'
  | 'rate_limited';

export type AclDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: number;
      readonly message: string;
      readonly reason: AclDenyReason;
    };

export interface AclPolicy {
  readonly config: AclConfig;
  readonly supportsIframe: boolean;
  canHandshake(caller: CallerContext): AclDecision;
  evaluate(
    caller: CallerContext,
    method: string,
    options?: { consumeRateLimit?: boolean },
  ): AclDecision;
  resetRateLimits(): void;
}

type OriginMatcher =
  | { kind: 'exact'; origin: string }
  | { kind: 'wildcard'; suffix: string; port: string };

type MethodMatcher =
  | { kind: 'all' }
  | { kind: 'exact'; method: string }
  | { kind: 'prefix'; prefix: string };

interface CompiledRule {
  index: number;
  origins: readonly OriginMatcher[];
  frames: AclFrameScope;
  allow: readonly MethodMatcher[];
  deny: readonly MethodMatcher[];
  perSecond?: number;
}

const EXACT_METHOD_PATTERN = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const PREFIX_METHOD_PATTERN = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*\.\*$/;
const WILDCARD_ORIGIN_PATTERN = /^https:\/\/\*\.([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)(?::([0-9]{1,5}))?\/?$/;

function canonicalizeExactHttpsOrigin(input: string): { origin: string; host: string; port: string } | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed || !trimmed.toLowerCase().startsWith('https://')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  if (!parsed.hostname || parsed.hostname.includes('*')) return undefined;
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
    return undefined;
  }
  const normalizedPort = parsed.port === '443' ? '' : parsed.port;
  return {
    origin: parsed.origin,
    host: parsed.hostname.toLowerCase(),
    port: normalizedPort,
  };
}

function parseOriginMatcher(raw: string): OriginMatcher {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RangeError(`Invalid ACL origin pattern "${String(raw)}"`);
  }
  const trimmed = raw.trim();
  const wildcard = WILDCARD_ORIGIN_PATTERN.exec(trimmed);
  if (wildcard) {
    const baseDomain = wildcard[1]!.toLowerCase();
    const rawPort = wildcard[2];
    if (rawPort !== undefined) {
      const portNum = Number(rawPort);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new RangeError(`Invalid port in ACL origin pattern "${raw}"`);
      }
    }
    const normalizedPort = rawPort === undefined || rawPort === '443' ? '' : String(Number(rawPort));
    return { kind: 'wildcard', suffix: `.${baseDomain}`, port: normalizedPort };
  }

  const exact = canonicalizeExactHttpsOrigin(trimmed);
  if (!exact) {
    throw new RangeError(`Invalid ACL origin pattern "${raw}": expected exact https://host[:port] or https://*.domain[:port]`);
  }
  return { kind: 'exact', origin: exact.origin };
}

function parseMethodMatcher(raw: string): MethodMatcher {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RangeError(`Invalid ACL method pattern "${String(raw)}"`);
  }
  if (raw === '*') return { kind: 'all' };
  if (PREFIX_METHOD_PATTERN.test(raw)) {
    return { kind: 'prefix', prefix: raw.slice(0, -1) };
  }
  if (EXACT_METHOD_PATTERN.test(raw)) {
    return { kind: 'exact', method: raw };
  }
  throw new RangeError(`Invalid ACL method pattern "${raw}"`);
}

function matchesOrigin(matcher: OriginMatcher, caller: { origin: string; host: string; port: string }): boolean {
  if (matcher.kind === 'exact') return matcher.origin === caller.origin;
  // Subdomain wildcard requires at least one non-empty subdomain label before `.domain` and identical port.
  return caller.port === matcher.port &&
    caller.host.endsWith(matcher.suffix) &&
    caller.host.length > matcher.suffix.length;
}

function matchesMethod(matcher: MethodMatcher, method: string): boolean {
  if (matcher.kind === 'all') return true;
  if (matcher.kind === 'exact') return matcher.method === method;
  return method.startsWith(matcher.prefix);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compiles a protocol §11.3 `rules` JSON ACL configuration into an executable policy engine.
 *
 * Enforces:
 * - `version === 1` and `default === "deny"`
 * - `deny` takes precedence over `allow`
 * - Exact HTTPS origin or strict subdomain wildcard matching (no prefix/substring matches)
 * - Protocol F5: `frames: "any"` never enables non-main frames unless `supportsIframe: true`
 * - Optional per-second rate limiting per `(rule, origin)`
 */
export function createAclPolicy(config: AclConfig, options: AclPolicyOptions = {}): AclPolicy {
  if (!isObject(config)) {
    throw new RangeError('ACL config must be an object');
  }
  if (config.version !== 1) {
    throw new RangeError(`Unsupported ACL config version "${String(config.version)}": expected 1`);
  }
  if (config.default !== 'deny') {
    throw new RangeError('ACL config default MUST be "deny" (protocol §11.3)');
  }
  if (!Array.isArray(config.rules)) {
    throw new RangeError('ACL config rules must be an array');
  }

  const supportsIframe = options.supportsIframe === true;
  const now = options.now ?? (() => Date.now());
  const compiledRules: CompiledRule[] = config.rules.map((rule, index) => {
    if (!isObject(rule) || !Array.isArray(rule.origins) || rule.origins.length === 0) {
      throw new RangeError(`ACL rule #${index} must specify at least one HTTPS origin pattern`);
    }
    const frames = rule.frames ?? 'main';
    if (frames !== 'main' && frames !== 'any') {
      throw new RangeError(`ACL rule #${index} has invalid frames "${String(frames)}"`);
    }
    const allow = rule.allow === undefined
      ? []
      : Array.isArray(rule.allow)
        ? rule.allow.map(parseMethodMatcher)
        : (() => { throw new RangeError(`ACL rule #${index} allow must be an array`); })();
    const deny = rule.deny === undefined
      ? []
      : Array.isArray(rule.deny)
        ? rule.deny.map(parseMethodMatcher)
        : (() => { throw new RangeError(`ACL rule #${index} deny must be an array`); })();

    let perSecond: number | undefined;
    if (rule.rateLimit !== undefined) {
      if (
        !isObject(rule.rateLimit) ||
        typeof rule.rateLimit.perSecond !== 'number' ||
        !Number.isSafeInteger(rule.rateLimit.perSecond) ||
        rule.rateLimit.perSecond < 1
      ) {
        throw new RangeError(`ACL rule #${index} rateLimit.perSecond must be a positive safe integer`);
      }
      perSecond = rule.rateLimit.perSecond;
    }

    return {
      index,
      origins: rule.origins.map(parseOriginMatcher),
      frames,
      allow,
      deny,
      perSecond,
    };
  });

  // Sliding 1-second timestamp windows keyed by `${rule.index}:${origin}`.
  const buckets = new Map<string, number[]>();

  function resolveMatchingRules(caller: CallerContext):
    | { ok: true; origin: string; rules: CompiledRule[] }
    | { ok: false; decision: AclDecision } {
    if (typeof caller.origin !== 'string') {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'origin_not_allowed',
        },
      };
    }
    const parsedOrigin = canonicalizeExactHttpsOrigin(caller.origin);
    if (!parsedOrigin) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'origin_not_allowed',
        },
      };
    }

    const isMainFrame = caller.isMainFrame !== false;
    // Protocol F5: `frames: "any"` cannot enable iframe traffic if the host does not support iframe isolation.
    if (!isMainFrame && !supportsIframe) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'frame_not_allowed',
        },
      };
    }

    const originMatched = compiledRules.filter((rule) =>
      rule.origins.some((matcher) => matchesOrigin(matcher, parsedOrigin)),
    );
    if (originMatched.length === 0) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'origin_not_allowed',
        },
      };
    }

    const frameMatched = originMatched.filter((rule) => isMainFrame || rule.frames === 'any');
    if (frameMatched.length === 0) {
      return {
        ok: false,
        decision: {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'frame_not_allowed',
        },
      };
    }

    return { ok: true, origin: parsedOrigin.origin, rules: frameMatched };
  }

  return {
    config,
    supportsIframe,
    canHandshake(caller: CallerContext): AclDecision {
      const matched = resolveMatchingRules(caller);
      return matched.ok ? { allowed: true } : matched.decision;
    },
    evaluate(
      caller: CallerContext,
      method: string,
      evalOptions?: { consumeRateLimit?: boolean },
    ): AclDecision {
      const matched = resolveMatchingRules(caller);
      if (!matched.ok) return matched.decision;

      // Protocol §11.3: `deny` takes precedence over `allow`.
      for (const rule of matched.rules) {
        if (rule.deny.some((matcher) => matchesMethod(matcher, method))) {
          return {
            allowed: false,
            code: ErrorCode.PermissionDenied,
            message: 'Permission denied',
            reason: 'acl_denied',
          };
        }
      }

      const allowRules = matched.rules.filter((rule) =>
        rule.allow.some((matcher) => matchesMethod(matcher, method)),
      );
      if (allowRules.length === 0) {
        return {
          allowed: false,
          code: ErrorCode.PermissionDenied,
          message: 'Permission denied',
          reason: 'acl_denied',
        };
      }

      if (evalOptions?.consumeRateLimit !== false) {
        const timestamp = now();
        const windowStart = timestamp - 1000;
        const limited: { key: string; list: number[] }[] = [];

        for (const rule of allowRules) {
          if (rule.perSecond === undefined) continue;
          const key = `${rule.index}:${matched.origin}`;
          const existing = buckets.get(key) ?? [];
          const active = existing.filter((ts) => ts > windowStart);
          if (active.length >= rule.perSecond) {
            buckets.set(key, active);
            return {
              allowed: false,
              code: ErrorCode.RateLimited,
              message: 'Rate limited',
              reason: 'rate_limited',
            };
          }
          limited.push({ key, list: active });
        }

        for (const entry of limited) {
          entry.list.push(timestamp);
          buckets.set(entry.key, entry.list);
        }
      }

      return { allowed: true };
    },
    resetRateLimits(): void {
      buckets.clear();
    },
  };
}
