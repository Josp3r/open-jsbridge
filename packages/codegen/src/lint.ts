import type { ErrorRegistry, JsonSchemaObject, LintIssue, SpecBundle } from './schema.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const WIRE_NAME_PATTERN = /^(?!rpc\.)[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const SCHEMA_ID_PATTERN = /^ojsb:schema\/[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const PROTOCOL_SINCE_PATTERN = /^[1-9][0-9]*\.[0-9]+$/;
const SUNSET_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_CONCURRENCY = new Set(['parallel', 'serial']);
const ALLOWED_CONCURRENCY_POLICY = new Set(['queue', 'reject']);
const ALLOWED_EXTENSIONS = new Set([
  'x-ojsb-kind',
  'x-ojsb-version',
  'x-ojsb-since',
  'x-ojsb-sunset',
  'x-ojsb-platforms',
  'x-ojsb-allow-degraded',
  'x-ojsb-long-running',
  'x-ojsb-callbacks',
  'x-ojsb-concurrency',
  'x-ojsb-concurrency-policy',
  'x-ojsb-throttle-ms',
  'x-ojsb-sensitive',
  'x-ojsb-errors',
]);
const STANDARD_JSONRPC_ERRORS = new Set([-32700, -32600, -32601, -32602, -32603]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function collectRefs(node: unknown, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (!isPlainObject(node)) return;
  if (typeof node.$ref === 'string') refs.push(node.$ref);
  for (const value of Object.values(node)) {
    collectRefs(value, refs);
  }
}

function expectedMethodPath(title: string, version: number): string {
  const segments = title.split('.');
  const suffix = version > 1 ? `@${version}` : '';
  return `methods/${segments.join('/')}${suffix}.json`;
}

function expectedId(kind: 'method' | 'event', title: string, version: number): string {
  const suffix = version > 1 ? `@${version}` : '';
  return `ojsb:${kind}/${title}${suffix}`;
}

function validateRefs(
  file: string,
  document: JsonSchemaObject,
  knownSchemaIds: ReadonlySet<string>,
  issues: LintIssue[],
): void {
  const refs: string[] = [];
  collectRefs(document, refs);
  const localDefs = isPlainObject(document.$defs) ? document.$defs : {};

  for (const ref of refs) {
    if (ref.startsWith('#/$defs/')) {
      const defName = ref.slice('#/$defs/'.length);
      if (!Object.prototype.hasOwnProperty.call(localDefs, defName)) {
        issues.push({ file, rule: 'ref-target', message: `Unresolved local $ref: "${ref}"` });
      }
      continue;
    }
    if (!knownSchemaIds.has(ref)) {
      issues.push({ file, rule: 'ref-target', message: `Unresolved external $ref: "${ref}"` });
    }
  }
}

function lintErrorsRegistry(
  file: string,
  registry: ErrorRegistry,
  issues: LintIssue[],
): void {
  if (!isPlainObject(registry)) {
    issues.push({ file, rule: 'errors-shape', message: 'Error registry must be a JSON object' });
    return;
  }

  const seenCodes = new Map<number, string>();
  for (const [name, entry] of Object.entries(registry)) {
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
      issues.push({ file, rule: 'errors-name', message: `Error name "${name}" must be PascalCase` });
    }
    if (!isPlainObject(entry)) {
      issues.push({ file, rule: 'errors-shape', message: `Error "${name}" must be an object` });
      continue;
    }
    const { code, message } = entry as { code?: unknown; message?: unknown };
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
      issues.push({ file, rule: 'errors-code', message: `Error "${name}" code must be a safe integer` });
    } else {
      const validCode =
        STANDARD_JSONRPC_ERRORS.has(code) ||
        (code >= -32099 && code <= -32000) ||
        (code >= 1 && code <= 9999);
      if (!validCode) {
        issues.push({
          file,
          rule: 'errors-range',
          message: `Error "${name}" code ${code} is outside allowed protocol/profile ranges`,
        });
      }
      const existing = seenCodes.get(code);
      if (existing !== undefined) {
        issues.push({
          file,
          rule: 'errors-duplicate-code',
          message: `Duplicate error code ${code} shared by "${existing}" and "${name}"`,
        });
      } else {
        seenCodes.set(code, name);
      }
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      issues.push({ file, rule: 'errors-message', message: `Error "${name}" must have a non-empty message` });
    }
  }
}

function lintExtensionKeywords(
  file: string,
  document: JsonSchemaObject,
  issues: LintIssue[],
): void {
  for (const key of Object.keys(document)) {
    if (key.startsWith('x-ojsb-') && !ALLOWED_EXTENSIONS.has(key)) {
      issues.push({ file, rule: 'unknown-extension', message: `Unknown extension keyword "${key}"` });
    }
  }

  const concurrency = document['x-ojsb-concurrency'];
  if (concurrency !== undefined && (typeof concurrency !== 'string' || !ALLOWED_CONCURRENCY.has(concurrency))) {
    issues.push({
      file,
      rule: 'extension-concurrency',
      message: 'x-ojsb-concurrency must be "parallel" or "serial"',
    });
  }

  const policy = document['x-ojsb-concurrency-policy'];
  if (policy !== undefined && (typeof policy !== 'string' || !ALLOWED_CONCURRENCY_POLICY.has(policy))) {
    issues.push({
      file,
      rule: 'extension-concurrency-policy',
      message: 'x-ojsb-concurrency-policy must be "queue" or "reject"',
    });
  }

  for (const boolKey of ['x-ojsb-long-running', 'x-ojsb-allow-degraded'] as const) {
    const value = document[boolKey];
    if (value !== undefined && typeof value !== 'boolean') {
      issues.push({ file, rule: 'extension-type', message: `${boolKey} must be a boolean` });
    }
  }

  const throttle = document['x-ojsb-throttle-ms'];
  if (throttle !== undefined && !isNonNegativeSafeInteger(throttle)) {
    issues.push({ file, rule: 'extension-throttle', message: 'x-ojsb-throttle-ms must be a non-negative integer' });
  }

  const sunset = document['x-ojsb-sunset'];
  if (sunset !== undefined && (typeof sunset !== 'string' || !SUNSET_DATE_PATTERN.test(sunset))) {
    issues.push({ file, rule: 'extension-sunset', message: 'x-ojsb-sunset must use YYYY-MM-DD format' });
  }

  const platforms = document['x-ojsb-platforms'];
  if (platforms !== undefined && (!Array.isArray(platforms) || !platforms.every((p) => typeof p === 'string' && p.length > 0))) {
    issues.push({ file, rule: 'extension-platforms', message: 'x-ojsb-platforms must be an array of non-empty strings' });
  }

  const businessErrors = document['x-ojsb-errors'];
  if (businessErrors !== undefined) {
    if (!Array.isArray(businessErrors)) {
      issues.push({ file, rule: 'extension-errors', message: 'x-ojsb-errors must be an array of error codes' });
    } else {
      for (const code of businessErrors) {
        if (!isPositiveSafeInteger(code) || code > 99999) {
          issues.push({
            file,
            rule: 'extension-errors',
            message: `x-ojsb-errors entry ${String(code)} must be an integer in 1..99999`,
          });
        }
      }
    }
  }
}

export function lintSpecBundle(bundle: SpecBundle): LintIssue[] {
  const issues: LintIssue[] = [];
  const knownSchemaIds = new Set<string>();
  const seenIds = new Map<string, string>();

  // 1. Validate shared schemas first so method/event $refs can resolve against them.
  for (const { path: file, document } of bundle.schemas) {
    if (!isPlainObject(document)) {
      issues.push({ file, rule: 'schema-shape', message: 'Shared schema must be a JSON object' });
      continue;
    }
    if (document.$schema !== DRAFT_2020_12) {
      issues.push({ file, rule: 'schema-draft', message: `$schema must be "${DRAFT_2020_12}"` });
    }
    if (typeof document.$id !== 'string' || !SCHEMA_ID_PATTERN.test(document.$id)) {
      issues.push({
        file,
        rule: 'schema-id',
        message: 'Shared schema $id must match "ojsb:schema/<domain>.<name>"',
      });
    } else {
      const existing = seenIds.get(document.$id);
      if (existing !== undefined) {
        issues.push({
          file,
          rule: 'duplicate-id',
          message: `Duplicate $id "${document.$id}" (already defined in ${existing})`,
        });
      } else {
        seenIds.set(document.$id, file);
        knownSchemaIds.add(document.$id);
      }
    }
  }

  for (const { path: file, document } of bundle.schemas) {
    if (isPlainObject(document)) validateRefs(file, document, knownSchemaIds, issues);
  }

  // 2. Validate method and event specs.
  const seenMethodVersions = new Map<string, string>();
  for (const { path: file, document } of bundle.methods) {
    if (!isPlainObject(document)) {
      issues.push({ file, rule: 'spec-shape', message: 'Method/event spec must be a JSON object' });
      continue;
    }
    if (document.$schema !== DRAFT_2020_12) {
      issues.push({ file, rule: 'schema-draft', message: `$schema must be "${DRAFT_2020_12}"` });
    }

    const kind = document['x-ojsb-kind'];
    if (kind !== 'method' && kind !== 'event') {
      issues.push({ file, rule: 'kind', message: 'x-ojsb-kind must be "method" or "event"' });
    }

    const title = document.title;
    const validTitle = typeof title === 'string' && WIRE_NAME_PATTERN.test(title);
    if (!validTitle) {
      issues.push({
        file,
        rule: 'name',
        message: `title "${String(title)}" must be a valid multi-segment wire name and must not use rpc.*`,
      });
    }

    const version = document['x-ojsb-version'];
    const validVersion = isPositiveSafeInteger(version);
    if (!validVersion) {
      issues.push({ file, rule: 'version', message: 'x-ojsb-version must be a positive safe integer' });
    }

    const since = document['x-ojsb-since'];
    if (typeof since !== 'string' || !PROTOCOL_SINCE_PATTERN.test(since)) {
      issues.push({ file, rule: 'since', message: 'x-ojsb-since must match "<MAJOR>.<MINOR>" (e.g. "1.0")' });
    }

    if (typeof document.description !== 'string' || document.description.trim().length === 0) {
      issues.push({ file, rule: 'description', message: 'description must be a non-empty string' });
    }

    if ((kind === 'method' || kind === 'event') && validTitle && validVersion) {
      const wantId = expectedId(kind, title, version);
      if (document.$id !== wantId) {
        issues.push({
          file,
          rule: 'spec-id',
          message: `$id must be "${wantId}", got "${String(document.$id)}"`,
        });
      } else {
        const existing = seenIds.get(wantId);
        if (existing !== undefined) {
          issues.push({
            file,
            rule: 'duplicate-id',
            message: `Duplicate $id "${wantId}" (already defined in ${existing})`,
          });
        } else {
          seenIds.set(wantId, file);
        }
      }

      const wantPath = expectedMethodPath(title, version);
      if (file !== wantPath) {
        issues.push({
          file,
          rule: 'spec-path',
          message: `Spec path "${file}" does not match title/version (expected "${wantPath}")`,
        });
      }

      const versionKey = `${kind}:${title}@${version}`;
      const prev = seenMethodVersions.get(versionKey);
      if (prev !== undefined) {
        issues.push({
          file,
          rule: 'duplicate-version',
          message: `Duplicate spec for ${versionKey} (already defined in ${prev})`,
        });
      } else {
        seenMethodVersions.set(versionKey, file);
      }
    }

    if (kind === 'method') {
      if (!isPlainObject(document.params)) {
        issues.push({ file, rule: 'method-params', message: 'Method spec must define a JSON Schema object "params"' });
      }
      if (!isPlainObject(document.result)) {
        issues.push({ file, rule: 'method-result', message: 'Method spec must define a JSON Schema object "result"' });
      }
      if (document.payload !== undefined) {
        issues.push({ file, rule: 'method-no-payload', message: 'Method spec must not define "payload"' });
      }
    } else if (kind === 'event') {
      if (!isPlainObject(document.payload)) {
        issues.push({ file, rule: 'event-payload', message: 'Event spec must define a JSON Schema object "payload"' });
      }
      if (document.params !== undefined || document.result !== undefined) {
        issues.push({
          file,
          rule: 'event-no-rpc-fields',
          message: 'Event spec must not define "params" or "result"',
        });
      }
    }

    lintExtensionKeywords(file, document, issues);
    validateRefs(file, document, knownSchemaIds, issues);
  }

  // 3. Validate protocol error registry.
  lintErrorsRegistry(bundle.errors.path, bundle.errors.document, issues);

  return issues;
}
