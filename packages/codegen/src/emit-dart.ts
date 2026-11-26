import type { JsonSchemaObject, JsonSchemaValue, SpecBundle } from './schema.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const DART_KEYWORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'base', 'break', 'case', 'catch',
  'class', 'const', 'continue', 'covariant', 'default', 'deferred', 'do', 'dynamic',
  'else', 'enum', 'export', 'extends', 'extension', 'external', 'factory', 'false',
  'final', 'finally', 'for', 'Function', 'get', 'hide', 'if', 'implements', 'import',
  'in', 'interface', 'is', 'late', 'library', 'mixin', 'new', 'null', 'of', 'on',
  'operator', 'part', 'required', 'rethrow', 'return', 'sealed', 'set', 'show',
  'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'type',
  'typedef', 'var', 'void', 'when', 'while', 'with', 'yield',
]);

export interface DartEmitOptions {
  packageImport?: string;
}

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

function dartIdent(raw: string): string {
  const cleaned = IDENTIFIER_PATTERN.test(raw) ? raw : toCamelCase(raw);
  const safe = /^[0-9]/.test(cleaned) ? `v${cleaned}` : cleaned || 'value';
  return DART_KEYWORDS.has(safe) ? `${safe}Value` : safe;
}

function dartString(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}'`;
}

function dartDoc(description: string | undefined, indent = ''): string[] {
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
  variantName: string;
  discriminatorValue: string;
  schema: JsonSchemaObject;
}

function detectDiscriminatedUnion(
  branches: readonly JsonSchemaObject[],
): { field: string; variants: DiscriminatedBranch[] } | undefined {
  if (branches.length < 2) return undefined;
  const firstProps = branches[0]?.properties;
  if (!firstProps) return undefined;
  for (const [field, prop] of Object.entries(firstProps)) {
    if (typeof prop.const !== 'string') continue;
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
      variants.push({ variantName: toPascalCase(val), discriminatorValue: val, schema: branch });
    }
    if (valid) return { field, variants };
  }
  return undefined;
}

function isStringEnum(values: readonly JsonSchemaValue[]): values is string[] {
  return values.length > 0 && values.every((item) => typeof item === 'string');
}

interface DartTypeRef {
  dartType: string;
  kind: 'primitive' | 'null' | 'any' | 'list' | 'map' | 'enum' | 'class' | 'union';
  element?: DartTypeRef;
}

function inferConstType(value: JsonSchemaValue): DartTypeRef {
  if (value === null) return { dartType: 'Null', kind: 'null' };
  if (typeof value === 'string') return { dartType: 'String', kind: 'primitive' };
  if (typeof value === 'boolean') return { dartType: 'bool', kind: 'primitive' };
  if (typeof value === 'number') {
    return { dartType: Number.isInteger(value) ? 'int' : 'double', kind: 'primitive' };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { dartType: 'List<Object?>', kind: 'list', element: { dartType: 'Object?', kind: 'any' } };
    }
    const first = inferConstType(value[0] as JsonSchemaValue);
    const same = value.every((item) => inferConstType(item).dartType === first.dartType);
    const elem = same ? first : { dartType: 'Object?', kind: 'any' as const };
    return { dartType: `List<${elem.dartType}>`, kind: 'list', element: elem };
  }
  return { dartType: 'Map<String, Object?>', kind: 'map', element: { dartType: 'Object?', kind: 'any' } };
}

interface DartEmitContext {
  sharedTypes: ReadonlyMap<string, DartTypeRef>;
  emittedNames: Set<string>;
  hoisted: string[];
}

function reserveName(ctx: DartEmitContext, preferred: string): string {
  let candidate = preferred;
  let counter = 2;
  while (ctx.emittedNames.has(candidate)) {
    candidate = `${preferred}${counter++}`;
  }
  ctx.emittedNames.add(candidate);
  return candidate;
}

function decodeExpr(ref: DartTypeRef, expr: string): string {
  switch (ref.kind) {
    case 'null':
      return 'null';
    case 'any':
      return expr;
    case 'primitive':
      if (ref.dartType === 'int') return `(${expr}! as num).toInt()`;
      if (ref.dartType === 'double') return `(${expr}! as num).toDouble()`;
      return `${expr}! as ${ref.dartType}`;
    case 'enum':
      return `${ref.dartType}.fromJson(${expr})`;
    case 'class':
    case 'union':
      return `${ref.dartType}.fromJson(${expr}! as Map<String, Object?>)`;
    case 'list': {
      const elem = ref.element ?? { dartType: 'Object?', kind: 'any' as const };
      if (elem.kind === 'any') return `List<Object?>.from(${expr}! as List<Object?>)`;
      return `(${expr}! as List<Object?>).map<${elem.dartType}>((Object? e) => ${decodeExpr(elem, 'e')}).toList()`;
    }
    case 'map': {
      const val = ref.element ?? { dartType: 'Object?', kind: 'any' as const };
      if (val.kind === 'any') return `Map<String, Object?>.from(${expr}! as Map<String, Object?>)`;
      return `(${expr}! as Map<String, Object?>).map<String, ${val.dartType}>((String k, Object? v) => MapEntry<String, ${val.dartType}>(k, ${decodeExpr(val, 'v')}))`;
    }
  }
}

function encodeExpr(ref: DartTypeRef, expr: string): string {
  switch (ref.kind) {
    case 'null':
      return 'null';
    case 'any':
    case 'primitive':
      return expr;
    case 'enum':
      return `${expr}.rawValue`;
    case 'class':
    case 'union':
      return `${expr}.toJson()`;
    case 'list': {
      const elem = ref.element ?? { dartType: 'Object?', kind: 'any' as const };
      if (elem.kind === 'any' || elem.kind === 'primitive') return expr;
      return `${expr}.map<Object?>((${elem.dartType} e) => ${encodeExpr(elem, 'e')}).toList()`;
    }
    case 'map': {
      const val = ref.element ?? { dartType: 'Object?', kind: 'any' as const };
      if (val.kind === 'any' || val.kind === 'primitive') return expr;
      return `${expr}.map<String, Object?>((String k, ${val.dartType} v) => MapEntry<String, Object?>(k, ${encodeExpr(val, 'v')}))`;
    }
  }
}

function emitDartType(
  schema: JsonSchemaObject,
  hintName: string,
  ctx: DartEmitContext,
): DartTypeRef {
  if (typeof schema.$ref === 'string') {
    const target = ctx.sharedTypes.get(schema.$ref);
    if (!target) {
      throw new Error(`Cannot emit Dart for unresolved $ref "${schema.$ref}"`);
    }
    return target;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return inferConstType(schema.const as JsonSchemaValue);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (isStringEnum(schema.enum)) {
      const enumName = reserveName(ctx, hintName);
      ctx.hoisted.push(emitDartEnum(enumName, schema.enum, schema.description));
      return { dartType: enumName, kind: 'enum' };
    }
    return { dartType: 'Object?', kind: 'any' };
  }

  const unionBranches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (unionBranches && unionBranches.length > 0) {
    const unionName = reserveName(ctx, hintName);
    ctx.hoisted.push(emitDartUnion(unionName, unionBranches, schema.description, ctx));
    return { dartType: unionName, kind: 'union' };
  }

  if (Array.isArray(schema.type)) {
    return { dartType: 'Object?', kind: 'any' };
  }

  switch (schema.type) {
    case 'null':
      return { dartType: 'Null', kind: 'null' };
    case 'boolean':
      return { dartType: 'bool', kind: 'primitive' };
    case 'string':
      return { dartType: 'String', kind: 'primitive' };
    case 'integer':
      return { dartType: 'int', kind: 'primitive' };
    case 'number':
      return { dartType: 'double', kind: 'primitive' };
    case 'array': {
      if (schema.maxItems === 0) {
        return { dartType: 'List<Object?>', kind: 'list', element: { dartType: 'Object?', kind: 'any' } };
      }
      const itemRef = schema.items
        ? emitDartType(schema.items, `${hintName}Item`, ctx)
        : ({ dartType: 'Object?', kind: 'any' } as const);
      return { dartType: `List<${itemRef.dartType}>`, kind: 'list', element: itemRef };
    }
    case 'object':
    default: {
      const props = schema.properties ? Object.entries(schema.properties) : [];
      if (props.length > 0) {
        const className = reserveName(ctx, hintName);
        ctx.hoisted.push(emitDartClass(className, schema, ctx));
        return { dartType: className, kind: 'class' };
      }
      if (schema.maxProperties === 0 || schema.additionalProperties === false) {
        const emptyName = reserveName(ctx, hintName);
        ctx.hoisted.push(emitDartEmptyClass(emptyName, schema.description));
        return { dartType: emptyName, kind: 'class' };
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const valRef = emitDartType(schema.additionalProperties, `${hintName}Entry`, ctx);
        return { dartType: `Map<String, ${valRef.dartType}>`, kind: 'map', element: valRef };
      }
      if (schema.type === 'object') {
        return { dartType: 'Map<String, Object?>', kind: 'map', element: { dartType: 'Object?', kind: 'any' } };
      }
      return { dartType: 'Object?', kind: 'any' };
    }
  }
}

function emitDartEnum(
  name: string,
  values: readonly string[],
  description?: string,
): string {
  const lines = [
    ...dartDoc(description),
    `enum ${name} {`,
  ];
  values.forEach((val, idx) => {
    const suffix = idx === values.length - 1 ? ';' : ',';
    lines.push(`  ${dartIdent(toCamelCase(val))}(${dartString(val)})${suffix}`);
  });
  lines.push('');
  lines.push('  final String rawValue;');
  lines.push(`  const ${name}(this.rawValue);`);
  lines.push('');
  lines.push(`  static ${name} fromJson(Object? value) {`);
  lines.push(`    for (final item in ${name}.values) {`);
  lines.push('      if (item.rawValue == value) return item;');
  lines.push('    }');
  lines.push(`    throw FormatException('Invalid ${name} value: \$value');`);
  lines.push('  }');
  lines.push('}');
  return lines.join('\n');
}

function emitDartEmptyClass(name: string, description?: string): string {
  return [
    ...dartDoc(description),
    `class ${name} {`,
    `  const ${name}();`,
    '',
    `  factory ${name}.fromJson(Map<String, Object?> json) => const ${name}();`,
    '',
    '  Map<String, Object?> toJson() => const <String, Object?>{};',
    '}',
  ].join('\n');
}

function emitDartClass(
  name: string,
  schema: JsonSchemaObject,
  ctx: DartEmitContext,
): string {
  const entries = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  const fields: { jsonKey: string; fieldIdent: string; ref: DartTypeRef; isOptional: boolean }[] = [];

  for (const [key, propSchema] of entries) {
    const isOptional = !required.has(key);
    const ref = emitDartType(propSchema, `${name}${toPascalCase(key)}`, ctx);
    fields.push({ jsonKey: key, fieldIdent: dartIdent(key), ref, isOptional });
  }

  const lines = [
    ...dartDoc(schema.description),
    `class ${name} {`,
  ];
  for (const field of fields) {
    const nullable = field.isOptional && !field.ref.dartType.endsWith('?') && field.ref.dartType !== 'Null' ? '?' : '';
    lines.push(`  final ${field.ref.dartType}${nullable} ${field.fieldIdent};`);
  }
  lines.push('');
  lines.push(`  const ${name}({`);
  for (const field of fields) {
    const req = field.isOptional ? '' : 'required ';
    lines.push(`    ${req}this.${field.fieldIdent},`);
  }
  lines.push('  });');
  lines.push('');
  lines.push(`  factory ${name}.fromJson(Map<String, Object?> json) {`);
  lines.push(`    return ${name}(`);
  for (const field of fields) {
    const keyLit = dartString(field.jsonKey);
    const decoded = decodeExpr(field.ref, `json[${keyLit}]`);
    if (field.isOptional) {
      lines.push(`      ${field.fieldIdent}: json[${keyLit}] == null ? null : ${decoded},`);
    } else {
      lines.push(`      ${field.fieldIdent}: ${decoded},`);
    }
  }
  lines.push('    );');
  lines.push('  }');
  lines.push('');
  lines.push('  Map<String, Object?> toJson() => <String, Object?>{');
  for (const field of fields) {
    const keyLit = dartString(field.jsonKey);
    if (field.isOptional) {
      const encoded = encodeExpr(field.ref, `${field.fieldIdent}!`);
      lines.push(`        if (${field.fieldIdent} != null) ${keyLit}: ${encoded},`);
    } else {
      const encoded = encodeExpr(field.ref, field.fieldIdent);
      lines.push(`        ${keyLit}: ${encoded},`);
    }
  }
  lines.push('      };');
  lines.push('}');
  return lines.join('\n');
}

function emitDartUnion(
  name: string,
  branches: readonly JsonSchemaObject[],
  description: string | undefined,
  ctx: DartEmitContext,
): string {
  const discriminated = detectDiscriminatedUnion(branches);
  const variants: {
    subClassName: string;
    payloadRef: DartTypeRef;
    discriminatorValue?: string;
  }[] = [];

  if (discriminated) {
    for (const variant of discriminated.variants) {
      const payloadRef = emitDartType(
        variant.schema,
        `${name}${variant.variantName}Data`,
        ctx,
      );
      variants.push({
        subClassName: reserveName(ctx, `${name}${variant.variantName}`),
        payloadRef,
        discriminatorValue: variant.discriminatorValue,
      });
    }
  } else {
    for (let i = 0; i < branches.length; i += 1) {
      const payloadRef = emitDartType(branches[i]!, `${name}Variant${i + 1}Data`, ctx);
      variants.push({
        subClassName: reserveName(ctx, `${name}Variant${i + 1}`),
        payloadRef,
      });
    }
  }

  const lines = [
    ...dartDoc(description),
    `sealed class ${name} {`,
    `  const ${name}();`,
    '',
    '  Map<String, Object?> toJson();',
    '',
    `  factory ${name}.fromJson(Map<String, Object?> json) {`,
  ];

  const decodeVariantFromMap = (ref: DartTypeRef): string => {
    if (ref.kind === 'class' || ref.kind === 'union') return `${ref.dartType}.fromJson(json)`;
    if (ref.kind === 'map') return 'Map<String, Object?>.from(json)';
    return decodeExpr(ref, 'json');
  };

  if (discriminated) {
    const discKey = dartString(discriminated.field);
    lines.push(`    switch (json[${discKey}]) {`);
    for (const variant of variants) {
      lines.push(`      case ${dartString(variant.discriminatorValue!)}:`);
      lines.push(`        return ${variant.subClassName}(${decodeVariantFromMap(variant.payloadRef)});`);
    }
    lines.push('      default:');
    lines.push(`        throw FormatException('Unsupported ${name} variant: \${json[${discKey}]}');`);
    lines.push('    }');
  } else {
    for (const variant of variants) {
      lines.push('    try {');
      lines.push(`      return ${variant.subClassName}(${decodeVariantFromMap(variant.payloadRef)});`);
      lines.push('    } catch (_) {}');
    }
    lines.push(`    throw const FormatException('Unable to decode ${name}');`);
  }

  lines.push('  }');
  lines.push('}');

  for (const variant of variants) {
    lines.push('');
    lines.push(`final class ${variant.subClassName} extends ${name} {`);
    lines.push(`  final ${variant.payloadRef.dartType} value;`);
    lines.push(`  const ${variant.subClassName}(this.value);`);
    lines.push('');
    lines.push('  @override');
    const encoded = encodeExpr(variant.payloadRef, 'value');
    const toJsonExpr =
      variant.payloadRef.kind === 'class' || variant.payloadRef.kind === 'union' || variant.payloadRef.kind === 'map'
        ? encoded
        : `<String, Object?>{'value': ${encoded}}`;
    lines.push(`  Map<String, Object?> toJson() => ${toJsonExpr};`);
    lines.push('}');
  }

  return lines.join('\n');
}

function emitTopLevelDart(
  name: string,
  schema: JsonSchemaObject,
  ctx: DartEmitContext,
): { ref: DartTypeRef; decl: string } {
  const beforeCount = ctx.hoisted.length;
  const ref = emitDartType(schema, name, ctx);
  if (ref.dartType === name && ctx.hoisted.length > beforeCount) {
    return { ref, decl: ctx.hoisted.pop()! };
  }
  const decl = [
    ...dartDoc(schema.description),
    `typedef ${name} = ${ref.dartType};`,
  ].join('\n');
  return { ref: { ...ref, dartType: name }, decl };
}

export function generateDart(
  bundle: SpecBundle,
  options: DartEmitOptions = {},
): string {
  const packageImport =
    options.packageImport ?? 'package:open_jsbridge_flutter/open_jsbridge_flutter.dart';

  const sortedSchemas = [...bundle.schemas].sort((a, b) =>
    String(a.document.$id ?? '').localeCompare(String(b.document.$id ?? '')),
  );
  const sharedTypes = new Map<string, DartTypeRef>();
  const ctx: DartEmitContext = {
    sharedTypes,
    emittedNames: new Set(['GeneratedErrorCode', 'StandardMethod', 'StandardEvent']),
    hoisted: [],
  };

  const blocks: string[] = [
    '// GENERATED FROM spec/ — DO NOT EDIT.',
    '// Run `node scripts/codegen.mjs --target dart --out <file>` after modifying files under spec/.',
    '',
    `import ${dartString(packageImport)};`,
  ];

  const flushHoisted = () => {
    while (ctx.hoisted.length > 0) {
      blocks.push('', ctx.hoisted.shift()!);
    }
  };

  // 1. Shared schemas
  for (const { document } of sortedSchemas) {
    const typeName = resolveSharedTypeName(document);
    const { ref, decl } = emitTopLevelDart(typeName, document, ctx);
    flushHoisted();
    blocks.push('', decl);
    if (typeof document.$id === 'string') {
      sharedTypes.set(document.$id, ref);
    }
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
    paramsRef: DartTypeRef;
    resultRef: DartTypeRef;
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
      const paramsOut = emitTopLevelDart(
        paramsName,
        (document.params ?? { type: 'object' }) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', paramsOut.decl);

      const resultOut = emitTopLevelDart(
        resultName,
        (document.result ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', resultOut.decl);

      methodStubs.push({
        title,
        version,
        baseName,
        paramsRef: paramsOut.ref,
        resultRef: resultOut.ref,
      });
    } else if (kind === 'event') {
      const payloadName = `${baseName}Payload`;
      const payloadOut = emitTopLevelDart(
        payloadName,
        (document.payload ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', payloadOut.decl);
      eventNames.push({ constName: dartIdent(toCamelCase(title)), title });
    }
  }

  // 3. BridgeHandler<P, R> abstract stubs for open_jsbridge_flutter (skip bridge.* control methods)
  for (const stub of methodStubs) {
    if (stub.title.startsWith('bridge.')) continue;
    const paramsDecode =
      stub.paramsRef.kind === 'map'
        ? 'Map<String, Object?>.from(json)'
        : `${stub.paramsRef.dartType}.fromJson(json)`;
    const resultEncode = encodeExpr(stub.resultRef, 'result');
    blocks.push(
      '',
      [
        `abstract class ${stub.baseName}Handler extends BridgeHandler<${stub.paramsRef.dartType}, ${stub.resultRef.dartType}> {`,
        '  @override',
        `  String get method => ${dartString(stub.title)};`,
        '',
        '  @override',
        `  List<int> get versions => const <int>[${stub.version}];`,
        '',
        '  @override',
        `  ${stub.paramsRef.dartType} decode(Map<String, Object?> json) => ${paramsDecode};`,
        '',
        '  @override',
        `  Object? encode(${stub.resultRef.dartType} result) => ${resultEncode};`,
        '}',
      ].join('\n'),
    );
  }

  // 4. Method & Event constants
  const methodLines = ['abstract final class StandardMethod {'];
  const uniqueMethodTitles = [...new Set(methodStubs.map((m) => m.title))];
  for (const title of uniqueMethodTitles) {
    methodLines.push(`  static const String ${dartIdent(toCamelCase(title))} = ${dartString(title)};`);
  }
  methodLines.push('}');
  blocks.push('', methodLines.join('\n'));

  const eventLines = ['abstract final class StandardEvent {'];
  for (const ev of eventNames) {
    eventLines.push(`  static const String ${ev.constName} = ${dartString(ev.title)};`);
  }
  eventLines.push('}');
  blocks.push('', eventLines.join('\n'));

  // 5. Protocol ErrorCode constants
  const errorLines = ['abstract final class GeneratedErrorCode {'];
  for (const [name, entry] of Object.entries(bundle.errors.document)) {
    errorLines.push(`  static const int ${dartIdent(toCamelCase(name))} = ${entry.code};`);
  }
  errorLines.push('}');
  blocks.push('', errorLines.join('\n'));

  return `${blocks.join('\n').trimEnd()}\n`;
}
