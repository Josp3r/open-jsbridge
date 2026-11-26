import type { JsonSchemaObject, JsonSchemaValue, SpecBundle } from './schema.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func',
  'import', 'init', 'inout', 'internal', 'let', 'open', 'operator', 'private',
  'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
  'typealias', 'var', 'break', 'case', 'catch', 'continue', 'default', 'defer', 'do',
  'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch',
  'throw', 'where', 'while', 'as', 'Any', 'false', 'is', 'nil', 'self', 'Self',
  'super', 'throws', 'true', 'try', 'Type',
]);

function toPascalCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  if (!pascal) return 'value';
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function swiftIdent(raw: string): string {
  const cleaned = IDENTIFIER_PATTERN.test(raw) ? raw : toCamelCase(raw);
  const safe = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || 'value';
  return SWIFT_KEYWORDS.has(safe) ? `\`${safe}\`` : safe;
}

function swiftDoc(description: string | undefined, indent = ''): string[] {
  if (!description) return [];
  return description.split('\n').map((line) => `${indent}/// ${line}`);
}

function versionSuffix(version: number): string {
  return version > 1 ? `V${version}` : '';
}

function resolveSharedTypeName(schema: JsonSchemaObject): string {
  if (typeof schema.title === 'string' && IDENTIFIER_PATTERN.test(schema.title)) {
    return schema.title;
  }
  const id = typeof schema.$id === 'string' ? schema.$id : '';
  const local = id.startsWith('ojsb:schema/') ? id.slice('ojsb:schema/'.length) : id;
  return toPascalCase(local);
}

interface DiscriminatedBranch {
  caseName: string;
  discriminatorValue: string;
  schema: JsonSchemaObject;
}

function detectDiscriminatedUnion(
  branches: readonly JsonSchemaObject[],
): { field: string; variants: DiscriminatedBranch[] } | undefined {
  if (branches.length < 2) return undefined;
  const candidateFields = new Set<string>();
  const firstProps = branches[0]?.properties;
  if (!firstProps) return undefined;
  for (const [key, prop] of Object.entries(firstProps)) {
    if (typeof prop.const === 'string') candidateFields.add(key);
  }
  for (const field of candidateFields) {
    const seen = new Set<string>();
    const variants: DiscriminatedBranch[] = [];
    let valid = true;
    for (const branch of branches) {
      const val = branch.properties?.[field]?.const;
      if (typeof val !== 'string' || seen.has(val)) {
        valid = false;
        break;
      }
      seen.add(val);
      variants.push({ caseName: toCamelCase(val), discriminatorValue: val, schema: branch });
    }
    if (valid) return { field, variants };
  }
  return undefined;
}

function isStringEnum(values: readonly JsonSchemaValue[]): values is string[] {
  return values.length > 0 && values.every((item) => typeof item === 'string');
}

function inferConstType(value: JsonSchemaValue): string {
  if (value === null) return 'OJSBJSONNull';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'boolean') return 'Bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Double';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[OJSBJSONValue]';
    const first = inferConstType(value[0] as JsonSchemaValue);
    const same = value.every((item) => inferConstType(item) === first);
    return `[${same ? first : 'OJSBJSONValue'}]`;
  }
  return '[String: OJSBJSONValue]';
}

interface SwiftEmitContext {
  sharedTypes: ReadonlyMap<string, string>;
  emittedNames: Set<string>;
  hoisted: string[];
}

function reserveName(ctx: SwiftEmitContext, preferred: string): string {
  let candidate = preferred;
  let counter = 2;
  while (ctx.emittedNames.has(candidate)) {
    candidate = `${preferred}${counter++}`;
  }
  ctx.emittedNames.add(candidate);
  return candidate;
}

function emitSwiftType(
  schema: JsonSchemaObject,
  hintName: string,
  ctx: SwiftEmitContext,
): string {
  if (typeof schema.$ref === 'string') {
    const target = ctx.sharedTypes.get(schema.$ref);
    if (!target) {
      throw new Error(`Cannot emit Swift for unresolved $ref "${schema.$ref}"`);
    }
    return target;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return inferConstType(schema.const as JsonSchemaValue);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (isStringEnum(schema.enum)) {
      const enumName = reserveName(ctx, hintName);
      ctx.hoisted.push(emitSwiftStringEnum(enumName, schema.enum, schema.description));
      return enumName;
    }
    return 'OJSBJSONValue';
  }

  const unionBranches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (unionBranches && unionBranches.length > 0) {
    const unionName = reserveName(ctx, hintName);
    ctx.hoisted.push(emitSwiftUnion(unionName, unionBranches, schema.description, ctx));
    return unionName;
  }

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((item) => item !== 'null');
    if (nonNull.length === 1 && schema.type.includes('null')) {
      return `${emitSwiftType({ ...schema, type: nonNull[0] }, hintName, ctx)}?`;
    }
    return 'OJSBJSONValue';
  }

  switch (schema.type) {
    case 'null':
      return 'OJSBJSONNull';
    case 'boolean':
      return 'Bool';
    case 'string':
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'array': {
      if (schema.maxItems === 0) return '[OJSBJSONValue]';
      const itemType = schema.items
        ? emitSwiftType(schema.items, `${hintName}Item`, ctx)
        : 'OJSBJSONValue';
      return `[${itemType}]`;
    }
    case 'object':
    default: {
      const props = schema.properties ? Object.entries(schema.properties) : [];
      if (props.length > 0) {
        const structName = reserveName(ctx, hintName);
        ctx.hoisted.push(emitSwiftStruct(structName, schema, ctx));
        return structName;
      }
      if (schema.maxProperties === 0 || schema.additionalProperties === false) {
        const emptyName = reserveName(ctx, hintName);
        ctx.hoisted.push(emitSwiftEmptyStruct(emptyName, schema.description));
        return emptyName;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const valType = emitSwiftType(schema.additionalProperties, `${hintName}Entry`, ctx);
        return `[String: ${valType}]`;
      }
      return schema.type === 'object' ? '[String: OJSBJSONValue]' : 'OJSBJSONValue';
    }
  }
}

function emitSwiftStringEnum(
  name: string,
  values: readonly string[],
  description?: string,
): string {
  const lines = [
    ...swiftDoc(description),
    `public enum ${name}: String, Codable, Sendable, Equatable, CaseIterable {`,
  ];
  for (const val of values) {
    lines.push(`    case ${swiftIdent(toCamelCase(val))} = ${JSON.stringify(val)}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function emitSwiftEmptyStruct(name: string, description?: string): string {
  return [
    ...swiftDoc(description),
    `public struct ${name}: Codable, Sendable, Equatable {`,
    '    public init() {}',
    '}',
  ].join('\n');
}

function emitSwiftStruct(
  name: string,
  schema: JsonSchemaObject,
  ctx: SwiftEmitContext,
): string {
  const entries = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  const fields: { jsonKey: string; propIdent: string; typeName: string; isOptional: boolean }[] = [];

  for (const [key, propSchema] of entries) {
    const isOptional = !required.has(key);
    const baseType = emitSwiftType(propSchema, `${name}${toPascalCase(key)}`, ctx);
    const typeName = isOptional && !baseType.endsWith('?') ? `${baseType}?` : baseType;
    fields.push({ jsonKey: key, propIdent: swiftIdent(key), typeName, isOptional });
  }

  const lines = [
    ...swiftDoc(schema.description),
    `public struct ${name}: Codable, Sendable, Equatable {`,
  ];
  for (const field of fields) {
    lines.push(`    public let ${field.propIdent}: ${field.typeName}`);
  }
  lines.push('');
  const initParams = fields
    .map((f) => `${f.propIdent}: ${f.typeName}${f.isOptional ? ' = nil' : ''}`)
    .join(', ');
  lines.push(`    public init(${initParams}) {`);
  for (const field of fields) {
    lines.push(`        self.${field.propIdent} = ${field.propIdent}`);
  }
  lines.push('    }');

  const needsCodingKeys = fields.some((f) => f.propIdent.replace(/^`|`$/g, '') !== f.jsonKey);
  if (needsCodingKeys) {
    lines.push('');
    lines.push('    private enum CodingKeys: String, CodingKey {');
    for (const field of fields) {
      lines.push(`        case ${field.propIdent} = ${JSON.stringify(field.jsonKey)}`);
    }
    lines.push('    }');
  }
  lines.push('}');
  return lines.join('\n');
}

function emitSwiftUnion(
  name: string,
  branches: readonly JsonSchemaObject[],
  description: string | undefined,
  ctx: SwiftEmitContext,
): string {
  const discriminated = detectDiscriminatedUnion(branches);
  const cases: { caseIdent: string; variantType: string; discriminatorValue?: string }[] = [];

  if (discriminated) {
    for (const variant of discriminated.variants) {
      const variantType = emitSwiftType(
        variant.schema,
        `${name}${toPascalCase(variant.discriminatorValue)}`,
        ctx,
      );
      cases.push({
        caseIdent: swiftIdent(variant.caseName),
        variantType,
        discriminatorValue: variant.discriminatorValue,
      });
    }
  } else {
    for (let i = 0; i < branches.length; i += 1) {
      const variantType = emitSwiftType(branches[i]!, `${name}Variant${i + 1}`, ctx);
      cases.push({ caseIdent: `variant${i + 1}`, variantType });
    }
  }

  const lines = [
    ...swiftDoc(description),
    `public enum ${name}: Codable, Sendable, Equatable {`,
  ];
  for (const c of cases) {
    lines.push(`    case ${c.caseIdent}(${c.variantType})`);
  }
  lines.push('');

  if (discriminated) {
    lines.push('    private enum DiscriminatorKey: String, CodingKey {');
    lines.push(`        case discriminator = ${JSON.stringify(discriminated.field)}`);
    lines.push('    }');
    lines.push('');
    lines.push('    public init(from decoder: Decoder) throws {');
    lines.push('        let container = try decoder.container(keyedBy: DiscriminatorKey.self)');
    lines.push('        let kind = try container.decode(String.self, forKey: .discriminator)');
    lines.push('        switch kind {');
    for (const c of cases) {
      lines.push(`        case ${JSON.stringify(c.discriminatorValue)}:`);
      lines.push(`            self = .${c.caseIdent}(try ${c.variantType}(from: decoder))`);
    }
    lines.push('        default:');
    lines.push(
      `            throw DecodingError.dataCorruptedError(forKey: .discriminator, in: container, debugDescription: "Unsupported ${name} discriminator: \\(kind)")`,
    );
    lines.push('        }');
    lines.push('    }');
  } else {
    lines.push('    public init(from decoder: Decoder) throws {');
    for (const c of cases) {
      lines.push(`        if let value = try? ${c.variantType}(from: decoder) {`);
      lines.push(`            self = .${c.caseIdent}(value)`);
      lines.push('            return');
      lines.push('        }');
    }
    lines.push(
      `        throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unable to decode ${name}"))`,
    );
    lines.push('    }');
  }

  lines.push('');
  lines.push('    public func encode(to encoder: Encoder) throws {');
  lines.push('        switch self {');
  for (const c of cases) {
    lines.push(`        case .${c.caseIdent}(let value):`);
    lines.push('            try value.encode(to: encoder)');
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function emitTopLevelSwift(
  name: string,
  schema: JsonSchemaObject,
  ctx: SwiftEmitContext,
): string {
  const beforeCount = ctx.hoisted.length;
  const resolved = emitSwiftType(schema, name, ctx);
  if (resolved === name && ctx.hoisted.length > beforeCount) {
    return ctx.hoisted.pop()!;
  }
  return [
    ...swiftDoc(schema.description),
    `public typealias ${name} = ${resolved}`,
  ].join('\n');
}

const SWIFT_SUPPORT_PRELUDE = `import Foundation

/// Represents a JSON \`null\` payload in generated Open JSBridge models.
public struct OJSBJSONNull: Codable, Sendable, Equatable {
    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.typeMismatch(
                OJSBJSONNull.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected null")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }
}

/// Arbitrary JSON value for open object schemas (e.g. \`conformance.echo\`).
public enum OJSBJSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case integer(Int)
    case number(Double)
    case string(String)
    case array([OJSBJSONValue])
    case object([String: OJSBJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([OJSBJSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: OJSBJSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// Base handler protocol implemented by generated per-method Swift handler stubs.
public protocol OJSBGeneratedHandler: Sendable {
    associatedtype Params: Codable & Sendable
    associatedtype Result: Codable & Sendable
    static var method: String { get }
    static var versions: [Int] { get }
    func handle(params: Params) async throws -> Result
}`;

export function generateSwift(bundle: SpecBundle): string {
  const sortedSchemas = [...bundle.schemas].sort((a, b) =>
    String(a.document.$id ?? '').localeCompare(String(b.document.$id ?? '')),
  );
  const sharedTypes = new Map<string, string>();
  for (const { document } of sortedSchemas) {
    if (typeof document.$id === 'string') {
      sharedTypes.set(document.$id, resolveSharedTypeName(document));
    }
  }

  const ctx: SwiftEmitContext = {
    sharedTypes,
    emittedNames: new Set(['OJSBJSONNull', 'OJSBJSONValue', 'OJSBGeneratedHandler', 'OJSBErrorCode', 'OJSBMethod', 'OJSBEvent']),
    hoisted: [],
  };

  const blocks: string[] = [
    '// GENERATED FROM spec/ — DO NOT EDIT.',
    '// Run `node scripts/codegen.mjs --target swift --out <file>` after modifying files under spec/.',
    '',
    SWIFT_SUPPORT_PRELUDE,
  ];

  const flushHoisted = () => {
    while (ctx.hoisted.length > 0) {
      blocks.push('', ctx.hoisted.shift()!);
    }
  };

  // 1. Shared schemas
  for (const { document } of sortedSchemas) {
    const typeName = resolveSharedTypeName(document);
    const decl = emitTopLevelSwift(typeName, document, ctx);
    flushHoisted();
    blocks.push('', decl);
  }

  // 2. Methods & Events
  const sortedSpecs = [...bundle.methods].sort((a, b) => {
    const titleDiff = String(a.document.title ?? '').localeCompare(String(b.document.title ?? ''));
    if (titleDiff !== 0) return titleDiff;
    return Number(a.document['x-ojsb-version'] ?? 1) - Number(b.document['x-ojsb-version'] ?? 1);
  });

  const methodStubs: {
    title: string;
    version: number;
    baseName: string;
    paramsName: string;
    resultName: string;
  }[] = [];
  const eventNames: { constName: string; title: string }[] = [];

  for (const { document } of sortedSpecs) {
    const kind = document['x-ojsb-kind'];
    const title = String(document.title ?? '');
    const version = Number(document['x-ojsb-version'] ?? 1);
    const baseName = `${toPascalCase(title)}${versionSuffix(version)}`;

    if (kind === 'method') {
      const paramsName = `${baseName}Params`;
      const resultName = `${baseName}Result`;
      const paramsDecl = emitTopLevelSwift(
        paramsName,
        (document.params ?? { type: 'object' }) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', paramsDecl);

      const resultDecl = emitTopLevelSwift(
        resultName,
        (document.result ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', resultDecl);

      methodStubs.push({ title, version, baseName, paramsName, resultName });
    } else if (kind === 'event') {
      const payloadName = `${baseName}Payload`;
      const payloadDecl = emitTopLevelSwift(
        payloadName,
        (document.payload ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', payloadDecl);
      eventNames.push({ constName: swiftIdent(toCamelCase(title)), title });
    }
  }

  // 3. Handler protocol stubs (skip internal bridge.* control methods)
  const methodGroups = new Map<string, typeof methodStubs>();
  for (const stub of methodStubs) {
    if (stub.title.startsWith('bridge.')) continue;
    const list = methodGroups.get(stub.title) ?? [];
    list.push(stub);
    methodGroups.set(stub.title, list);
  }
  for (const stubs of methodGroups.values()) {
    for (const stub of stubs) {
      const protocolName = `${stub.baseName}Handler`;
      blocks.push(
        '',
        [
          `public protocol ${protocolName}: OJSBGeneratedHandler where Params == ${stub.paramsName}, Result == ${stub.resultName} {}`,
          `public extension ${protocolName} {`,
          `    static var method: String { ${JSON.stringify(stub.title)} }`,
          `    static var versions: [Int] { [${stub.version}] }`,
          '}',
        ].join('\n'),
      );
    }
  }

  // 4. Method & Event name constants
  const methodConstLines = ['public enum OJSBMethod {'];
  const uniqueMethodTitles = [...new Set(methodStubs.map((m) => m.title))];
  for (const title of uniqueMethodTitles) {
    methodConstLines.push(`    public static let ${swiftIdent(toCamelCase(title))} = ${JSON.stringify(title)}`);
  }
  methodConstLines.push('}');
  blocks.push('', methodConstLines.join('\n'));

  const eventConstLines = ['public enum OJSBEvent {'];
  for (const ev of eventNames) {
    eventConstLines.push(`    public static let ${ev.constName} = ${JSON.stringify(ev.title)}`);
  }
  eventConstLines.push('}');
  blocks.push('', eventConstLines.join('\n'));

  // 5. Protocol ErrorCode constants
  const errorLines = ['public enum OJSBErrorCode: Int, Sendable {'];
  for (const [name, entry] of Object.entries(bundle.errors.document)) {
    errorLines.push(`    case ${swiftIdent(toCamelCase(name))} = ${entry.code}`);
  }
  errorLines.push('}');
  blocks.push('', errorLines.join('\n'));

  return `${blocks.join('\n').trimEnd()}\n`;
}
