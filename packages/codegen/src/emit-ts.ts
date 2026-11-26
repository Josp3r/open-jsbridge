import type { JsonSchemaObject, JsonSchemaValue, SpecBundle } from './schema.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function toPascalCase(dotted: string): string {
  return dotted
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function formatPropertyKey(key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? key : JSON.stringify(key);
}

function formatLiteral(value: JsonSchemaValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatLiteral(item)).join(', ')}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return 'Record<string, never>';
  return `{ ${entries.map(([k, v]) => `${formatPropertyKey(k)}: ${formatLiteral(v as JsonSchemaValue)}`).join('; ')} }`;
}

function formatJsDoc(description: string | undefined, indent = ''): string[] {
  if (!description) return [];
  const safe = description.replace(/\*\//g, '*\\/');
  return [`${indent}/** ${safe} */`];
}

interface EmitContext {
  sharedTypes: ReadonlyMap<string, string>;
}

function emitSchemaType(schema: JsonSchemaObject, ctx: EmitContext, indent = ''): string {
  if (typeof schema.$ref === 'string') {
    const target = ctx.sharedTypes.get(schema.$ref);
    if (!target) {
      throw new Error(`Cannot emit TypeScript for unresolved $ref "${schema.$ref}"`);
    }
    return target;
  }

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    return formatLiteral(schema.const as JsonSchemaValue);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((item) => formatLiteral(item)).join(' | ');
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map((branch) => wrapUnionMember(emitSchemaType(branch, ctx, indent))).join(' | ');
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map((branch) => wrapUnionMember(emitSchemaType(branch, ctx, indent))).join(' | ');
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((branch) => wrapUnionMember(emitSchemaType(branch, ctx, indent))).join(' & ');
  }

  if (Array.isArray(schema.type)) {
    return schema.type
      .map((singleType) => emitSchemaType({ ...schema, type: singleType }, ctx, indent))
      .join(' | ');
  }

  switch (schema.type) {
    case 'null':
      return 'null';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return emitArrayType(schema, ctx, indent);
    case 'object':
      return emitObjectType(schema, ctx, indent);
    default:
      if (schema.properties || schema.additionalProperties !== undefined || schema.maxProperties === 0) {
        return emitObjectType(schema, ctx, indent);
      }
      return 'unknown';
  }
}

function wrapUnionMember(rendered: string): string {
  return rendered.includes(' & ') ? `(${rendered})` : rendered;
}

function emitArrayType(schema: JsonSchemaObject, ctx: EmitContext, indent: string): string {
  if (schema.maxItems === 0) return '[]';
  const itemType = schema.items ? emitSchemaType(schema.items, ctx, indent) : 'unknown';
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems === schema.maxItems && schema.minItems <= 4) {
    return `[${Array.from({ length: schema.minItems }, () => itemType).join(', ')}]`;
  }
  const needsParens = itemType.includes(' | ') || itemType.includes(' & ');
  return needsParens ? `(${itemType})[]` : `${itemType}[]`;
}

function emitObjectType(schema: JsonSchemaObject, ctx: EmitContext, indent: string): string {
  const properties = schema.properties ? Object.entries(schema.properties) : [];
  if (schema.maxProperties === 0 && properties.length === 0) {
    return 'Record<string, never>';
  }

  const additional = schema.additionalProperties;
  if (properties.length === 0) {
    if (additional && typeof additional === 'object') {
      return `Record<string, ${emitSchemaType(additional, ctx, indent)}>`;
    }
    if (additional === false) {
      return 'Record<string, never>';
    }
    return 'Record<string, unknown>';
  }

  const required = new Set(schema.required ?? []);
  const innerIndent = `${indent}  `;
  const lines: string[] = ['{'];
  for (const [key, propSchema] of properties) {
    const optional = required.has(key) ? '' : '?';
    const propType = emitSchemaType(propSchema, ctx, innerIndent);
    lines.push(`${innerIndent}${formatPropertyKey(key)}${optional}: ${propType};`);
  }
  if (additional && typeof additional === 'object') {
    lines.push(`${innerIndent}[key: string]: ${emitSchemaType(additional, ctx, innerIndent)};`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function resolveSharedTypeName(schema: JsonSchemaObject): string {
  if (typeof schema.title === 'string' && IDENTIFIER_PATTERN.test(schema.title)) {
    return schema.title;
  }
  const id = typeof schema.$id === 'string' ? schema.$id : '';
  const local = id.startsWith('ojsb:schema/') ? id.slice('ojsb:schema/'.length) : id;
  return toPascalCase(local);
}

function versionSuffix(version: number): string {
  return version > 1 ? `V${version}` : '';
}

function methodMapKey(title: string, version: number): string {
  return version > 1 ? `${title}@${version}` : title;
}

function canEmitAsInterface(schema: JsonSchemaObject): boolean {
  if (
    typeof schema.$ref === 'string' ||
    Object.prototype.hasOwnProperty.call(schema, 'const') ||
    Array.isArray(schema.enum) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.allOf) ||
    Array.isArray(schema.type)
  ) {
    return false;
  }
  const properties = schema.properties ? Object.keys(schema.properties) : [];
  return properties.length > 0 && (schema.type === 'object' || schema.type === undefined);
}

function emitNamedDeclaration(name: string, schema: JsonSchemaObject, ctx: EmitContext): string {
  const rendered = emitSchemaType(schema, ctx);
  if (canEmitAsInterface(schema) && rendered.startsWith('{')) {
    return `export interface ${name} ${rendered}`;
  }
  return `export type ${name} = ${rendered};`;
}

export function generateTypeScript(bundle: SpecBundle): string {
  const sortedSchemas = [...bundle.schemas].sort((a, b) =>
    String(a.document.$id ?? '').localeCompare(String(b.document.$id ?? '')),
  );
  const sharedTypes = new Map<string, string>();
  for (const { document } of sortedSchemas) {
    if (typeof document.$id === 'string') {
      sharedTypes.set(document.$id, resolveSharedTypeName(document));
    }
  }
  const ctx: EmitContext = { sharedTypes };

  const lines: string[] = [
    '// GENERATED FROM spec/ — DO NOT EDIT.',
    '// Run `npm run codegen:ts` after modifying files under spec/.',
    '',
  ];

  // 1. Shared schemas
  for (const { document } of sortedSchemas) {
    const typeName = resolveSharedTypeName(document);
    lines.push(...formatJsDoc(document.description));
    lines.push(emitNamedDeclaration(typeName, document, ctx));
    lines.push('');
  }

  // 2. Methods & Events
  const methods: { title: string; version: number; description?: string; paramsName: string; resultName: string }[] = [];
  const events: { title: string; version: number; description?: string; payloadName: string }[] = [];

  const sortedSpecs = [...bundle.methods].sort((a, b) => {
    const titleDiff = String(a.document.title ?? '').localeCompare(String(b.document.title ?? ''));
    if (titleDiff !== 0) return titleDiff;
    return Number(a.document['x-ojsb-version'] ?? 1) - Number(b.document['x-ojsb-version'] ?? 1);
  });

  for (const { document } of sortedSpecs) {
    const kind = document['x-ojsb-kind'];
    const title = String(document.title ?? '');
    const version = Number(document['x-ojsb-version'] ?? 1);
    const baseName = `${toPascalCase(title)}${versionSuffix(version)}`;

    if (kind === 'method') {
      const paramsName = `${baseName}Params`;
      const resultName = `${baseName}Result`;
      const paramsSchema = (document.params ?? { type: 'object' }) as JsonSchemaObject;
      const resultSchema = (document.result ?? {}) as JsonSchemaObject;

      lines.push(...formatJsDoc(document.description));
      lines.push(emitNamedDeclaration(paramsName, paramsSchema, ctx));
      lines.push('');

      lines.push(emitNamedDeclaration(resultName, resultSchema, ctx));
      lines.push('');

      methods.push({
        title,
        version,
        description: document.description,
        paramsName,
        resultName,
      });
    } else if (kind === 'event') {
      const payloadName = `${baseName}Payload`;
      const payloadSchema = (document.payload ?? {}) as JsonSchemaObject;

      lines.push(...formatJsDoc(document.description));
      lines.push(emitNamedDeclaration(payloadName, payloadSchema, ctx));
      lines.push('');

      events.push({
        title,
        version,
        description: document.description,
        payloadName,
      });
    }
  }

  // 3. Aggregate MethodMap & EventMap (extensible via module augmentation)
  lines.push('export interface MethodMap {');
  for (const entry of methods) {
    lines.push(
      `  ${JSON.stringify(methodMapKey(entry.title, entry.version))}: { params: ${entry.paramsName}; result: ${entry.resultName} };`,
    );
  }
  lines.push('}');
  lines.push('');

  lines.push('export interface EventMap {');
  for (const entry of events) {
    lines.push(`  ${JSON.stringify(methodMapKey(entry.title, entry.version))}: ${entry.payloadName};`);
  }
  lines.push('}');
  lines.push('');

  // 4. Protocol ErrorCodeMap from spec/protocol/errors.json
  lines.push('export interface ErrorCodeMap {');
  for (const [name, entry] of Object.entries(bundle.errors.document)) {
    lines.push(`  readonly ${formatPropertyKey(name)}: ${entry.code};`);
  }
  lines.push('}');
  lines.push('');

  return `${lines.join('\n').trimEnd()}\n`;
}
