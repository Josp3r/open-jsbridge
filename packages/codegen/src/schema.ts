export type JsonPrimitive = null | boolean | number | string;
export type JsonSchemaValue = JsonPrimitive | JsonSchemaObject | JsonSchemaValue[];

export interface JsonSchemaObject {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchemaObject>;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: JsonSchemaValue;
  enum?: JsonSchemaValue[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  maxProperties?: number;
  items?: JsonSchemaObject;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  if?: JsonSchemaObject;
  then?: JsonSchemaObject;
  else?: JsonSchemaObject;
  not?: JsonSchemaObject;
  default?: JsonSchemaValue;
  deprecated?: boolean;
  [keyword: string]: unknown;
}

export interface SpecFile<T = JsonSchemaObject> {
  /** Relative POSIX path from the spec root, e.g. "methods/device/getInfo.json". */
  path: string;
  document: T;
}

export interface ErrorRegistryEntry {
  code: number;
  message: string;
}

export type ErrorRegistry = Record<string, ErrorRegistryEntry>;

export interface SpecBundle {
  schemas: readonly SpecFile<JsonSchemaObject>[];
  methods: readonly SpecFile<JsonSchemaObject>[];
  errors: SpecFile<ErrorRegistry>;
}

export interface LintIssue {
  file: string;
  rule: string;
  message: string;
}
