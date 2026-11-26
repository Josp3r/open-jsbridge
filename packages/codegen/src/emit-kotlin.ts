import type { JsonSchemaObject, JsonSchemaValue, SpecBundle } from './schema.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const KOTLIN_KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if',
  'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this',
  'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
]);

export interface KotlinEmitOptions {
  packageName?: string;
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

function toScreamingSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function kotlinIdent(raw: string): string {
  const cleaned = IDENTIFIER_PATTERN.test(raw) ? raw : toCamelCase(raw);
  const safe = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || 'value';
  return KOTLIN_KEYWORDS.has(safe) ? `\`${safe}\`` : safe;
}

function kotlinDoc(description: string | undefined, indent = ''): string[] {
  if (!description) return [];
  const safe = description.replace(/\*\//g, '*\\/');
  return [`${indent}/** ${safe} */`];
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

function inferConstType(value: JsonSchemaValue): string {
  if (value === null) return 'Nothing?';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'boolean') return 'Boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Long' : 'Double';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'List<Any?>';
    const first = inferConstType(value[0] as JsonSchemaValue);
    const same = value.every((item) => inferConstType(item) === first);
    return `List<${same ? first : 'Any?'}>`;
  }
  return 'Map<String, Any?>';
}

interface KotlinEmitContext {
  sharedTypes: ReadonlyMap<string, string>;
  emittedNames: Set<string>;
  hoisted: string[];
}

function reserveName(ctx: KotlinEmitContext, preferred: string): string {
  let candidate = preferred;
  let counter = 2;
  while (ctx.emittedNames.has(candidate)) {
    candidate = `${preferred}${counter++}`;
  }
  ctx.emittedNames.add(candidate);
  return candidate;
}

function emitKotlinType(
  schema: JsonSchemaObject,
  hintName: string,
  ctx: KotlinEmitContext,
): string {
  if (typeof schema.$ref === 'string') {
    const target = ctx.sharedTypes.get(schema.$ref);
    if (!target) {
      throw new Error(`Cannot emit Kotlin for unresolved $ref "${schema.$ref}"`);
    }
    return target;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return inferConstType(schema.const as JsonSchemaValue);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (isStringEnum(schema.enum)) {
      const enumName = reserveName(ctx, hintName);
      ctx.hoisted.push(emitKotlinEnum(enumName, schema.enum, schema.description));
      return enumName;
    }
    return 'Any?';
  }

  const unionBranches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (unionBranches && unionBranches.length > 0) {
    const sealedName = reserveName(ctx, hintName);
    ctx.hoisted.push(emitKotlinSealedClass(sealedName, unionBranches, schema.description, ctx));
    return sealedName;
  }

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((item) => item !== 'null');
    if (nonNull.length === 1 && schema.type.includes('null')) {
      return `${emitKotlinType({ ...schema, type: nonNull[0] }, hintName, ctx)}?`;
    }
    return 'Any?';
  }

  switch (schema.type) {
    case 'null':
      return 'Unit?';
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'integer':
      return 'Long';
    case 'number':
      return 'Double';
    case 'array': {
      if (schema.maxItems === 0) return 'List<Any?>';
      const itemType = schema.items
        ? emitKotlinType(schema.items, `${hintName}Item`, ctx)
        : 'Any?';
      return `List<${itemType}>`;
    }
    case 'object':
    default: {
      const props = schema.properties ? Object.entries(schema.properties) : [];
      if (props.length > 0) {
        const className = reserveName(ctx, hintName);
        ctx.hoisted.push(emitKotlinDataClass(className, schema, ctx));
        return className;
      }
      if (schema.maxProperties === 0 || schema.additionalProperties === false) {
        const emptyName = reserveName(ctx, hintName);
        ctx.hoisted.push(emitKotlinEmptyClass(emptyName, schema.description));
        return emptyName;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const valType = emitKotlinType(schema.additionalProperties, `${hintName}Entry`, ctx);
        return `Map<String, ${valType}>`;
      }
      return schema.type === 'object' ? 'Map<String, Any?>' : 'Any?';
    }
  }
}

function emitKotlinEnum(
  name: string,
  values: readonly string[],
  description?: string,
): string {
  const lines = [
    ...kotlinDoc(description),
    `enum class ${name}(val rawValue: String) {`,
  ];
  values.forEach((val, idx) => {
    const suffix = idx === values.length - 1 ? ';' : ',';
    lines.push(`    ${toScreamingSnake(val)}(${JSON.stringify(val)})${suffix}`);
  });
  lines.push('');
  lines.push('    companion object {');
  lines.push(`        fun fromRawValue(value: String): ${name}? = entries.firstOrNull { it.rawValue == value }`);
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function emitKotlinEmptyClass(name: string, description?: string): string {
  return [
    ...kotlinDoc(description),
    `class ${name} {`,
    `    override fun equals(other: Any?): Boolean = other is ${name}`,
    `    override fun hashCode(): Int = ${JSON.stringify(name)}.hashCode()`,
    `    override fun toString(): String = ${JSON.stringify(`${name}()`) }`,
    '}',
  ].join('\n');
}

function emitKotlinDataClass(
  name: string,
  schema: JsonSchemaObject,
  ctx: KotlinEmitContext,
): string {
  const entries = schema.properties ? Object.entries(schema.properties) : [];
  const required = new Set(schema.required ?? []);
  const lines = [
    ...kotlinDoc(schema.description),
    `data class ${name}(`,
  ];
  entries.forEach(([key, propSchema], idx) => {
    const isOptional = !required.has(key);
    const baseType = emitKotlinType(propSchema, `${name}${toPascalCase(key)}`, ctx);
    const fullType = isOptional && !baseType.endsWith('?') ? `${baseType}?` : baseType;
    const defaultSuffix = isOptional ? ' = null' : '';
    const comma = idx === entries.length - 1 ? '' : ',';
    lines.push(`    val ${kotlinIdent(key)}: ${fullType}${defaultSuffix}${comma}`);
  });
  lines.push(')');
  return lines.join('\n');
}

function emitKotlinSealedClass(
  name: string,
  branches: readonly JsonSchemaObject[],
  description: string | undefined,
  ctx: KotlinEmitContext,
): string {
  const discriminated = detectDiscriminatedUnion(branches);
  const variants: { subName: string; payloadType: string }[] = [];

  if (discriminated) {
    for (const variant of discriminated.variants) {
      const payloadType = emitKotlinType(
        variant.schema,
        `${name}${variant.variantName}`,
        ctx,
      );
      variants.push({ subName: variant.variantName, payloadType });
    }
  } else {
    for (let i = 0; i < branches.length; i += 1) {
      const payloadType = emitKotlinType(branches[i]!, `${name}Variant${i + 1}`, ctx);
      variants.push({ subName: `Variant${i + 1}`, payloadType });
    }
  }

  const lines = [
    ...kotlinDoc(description),
    `sealed class ${name} {`,
  ];
  for (const variant of variants) {
    lines.push(`    data class ${variant.subName}(val value: ${variant.payloadType}) : ${name}()`);
  }
  lines.push('}');
  return lines.join('\n');
}

function emitTopLevelKotlin(
  name: string,
  schema: JsonSchemaObject,
  ctx: KotlinEmitContext,
): string {
  const beforeCount = ctx.hoisted.length;
  const resolved = emitKotlinType(schema, name, ctx);
  if (resolved === name && ctx.hoisted.length > beforeCount) {
    return ctx.hoisted.pop()!;
  }
  return [
    ...kotlinDoc(schema.description),
    `typealias ${name} = ${resolved}`,
  ].join('\n');
}

export function generateKotlin(
  bundle: SpecBundle,
  options: KotlinEmitOptions = {},
): string {
  const packageName = options.packageName ?? 'dev.openjsbridge.gen';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(packageName)) {
    throw new Error(`Invalid Kotlin package name "${packageName}"`);
  }

  const sortedSchemas = [...bundle.schemas].sort((a, b) =>
    String(a.document.$id ?? '').localeCompare(String(b.document.$id ?? '')),
  );
  const sharedTypes = new Map<string, string>();
  for (const { document } of sortedSchemas) {
    if (typeof document.$id === 'string') {
      sharedTypes.set(document.$id, resolveSharedTypeName(document));
    }
  }

  const ctx: KotlinEmitContext = {
    sharedTypes,
    emittedNames: new Set(['OjsbGeneratedHandler', 'OjsbErrorCode', 'OjsbMethods', 'OjsbEvents']),
    hoisted: [],
  };

  const blocks: string[] = [
    '// GENERATED FROM spec/ — DO NOT EDIT.',
    `// Run \`node scripts/codegen.mjs --target kotlin --package ${packageName} --out <file>\` after modifying files under spec/.`,
    '',
    `package ${packageName}`,
    '',
    [
      '/** Base handler interface implemented by generated per-method Kotlin handler stubs. */',
      'interface OjsbGeneratedHandler<P, R> {',
      '    val method: String',
      '    val versions: List<Int>',
      '    suspend fun handle(params: P): R',
      '}',
    ].join('\n'),
  ];

  const flushHoisted = () => {
    while (ctx.hoisted.length > 0) {
      blocks.push('', ctx.hoisted.shift()!);
    }
  };

  // 1. Shared schemas
  for (const { document } of sortedSchemas) {
    const typeName = resolveSharedTypeName(document);
    const decl = emitTopLevelKotlin(typeName, document, ctx);
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
      const paramsDecl = emitTopLevelKotlin(
        paramsName,
        (document.params ?? { type: 'object' }) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', paramsDecl);

      const resultDecl = emitTopLevelKotlin(
        resultName,
        (document.result ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', resultDecl);

      methodStubs.push({ title, version, baseName, paramsName, resultName });
    } else if (kind === 'event') {
      const payloadName = `${baseName}Payload`;
      const payloadDecl = emitTopLevelKotlin(
        payloadName,
        (document.payload ?? {}) as JsonSchemaObject,
        ctx,
      );
      flushHoisted();
      blocks.push('', payloadDecl);
      eventNames.push({ constName: toScreamingSnake(title), title });
    }
  }

  // 3. Handler abstract class stubs (skip internal bridge.* control methods)
  for (const stub of methodStubs) {
    if (stub.title.startsWith('bridge.')) continue;
    blocks.push(
      '',
      [
        `abstract class ${stub.baseName}Handler : OjsbGeneratedHandler<${stub.paramsName}, ${stub.resultName}> {`,
        `    override val method: String = ${JSON.stringify(stub.title)}`,
        `    override val versions: List<Int> = listOf(${stub.version})`,
        '}',
      ].join('\n'),
    );
  }

  // 4. Method & Event constants
  const methodLines = ['object OjsbMethods {'];
  const uniqueMethodTitles = [...new Set(methodStubs.map((m) => m.title))];
  for (const title of uniqueMethodTitles) {
    methodLines.push(`    const val ${toScreamingSnake(title)}: String = ${JSON.stringify(title)}`);
  }
  methodLines.push('}');
  blocks.push('', methodLines.join('\n'));

  const eventLines = ['object OjsbEvents {'];
  for (const ev of eventNames) {
    eventLines.push(`    const val ${ev.constName}: String = ${JSON.stringify(ev.title)}`);
  }
  eventLines.push('}');
  blocks.push('', eventLines.join('\n'));

  // 5. Protocol ErrorCode constants
  const errorLines = ['object OjsbErrorCode {'];
  for (const [name, entry] of Object.entries(bundle.errors.document)) {
    errorLines.push(`    const val ${toScreamingSnake(name)}: Int = ${entry.code}`);
  }
  errorLines.push('}');
  blocks.push('', errorLines.join('\n'));

  return `${blocks.join('\n').trimEnd()}\n`;
}
