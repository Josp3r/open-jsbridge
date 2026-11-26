import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  generateDart,
  generateKotlin,
  generateSwift,
  generateTypeScript,
  lintSpecBundle,
} from '../dist/packages/codegen/src/index.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultSpecDir = resolve(repoRoot, 'spec');
const defaultTsOut = resolve(repoRoot, 'packages/web-sdk/src/generated/spec.ts');

function walkJsonFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results.sort();
}

function toPosixRelative(baseDir, filePath) {
  return relative(baseDir, filePath).split('\\').join(posix.sep);
}

export function loadSpecBundle(specDir = defaultSpecDir) {
  const readSpecFile = (absPath) => ({
    path: toPosixRelative(specDir, absPath),
    document: JSON.parse(readFileSync(absPath, 'utf8')),
  });

  const schemas = walkJsonFiles(resolve(specDir, 'schemas')).map(readSpecFile);
  const methods = walkJsonFiles(resolve(specDir, 'methods')).map(readSpecFile);
  const errors = readSpecFile(resolve(specDir, 'protocol/errors.json'));
  return { schemas, methods, errors };
}

export function validateSpecSchemasWithAjv(bundle) {
  const issues = [];
  const ajv = new Ajv2020({ allErrors: true, strictRequired: true });

  for (const { path: file, document } of bundle.schemas) {
    try {
      ajv.addSchema(document);
    } catch (error) {
      issues.push({
        file,
        rule: 'ajv-schema',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const { path: file, document } of bundle.methods) {
    const kind = document['x-ojsb-kind'];
    const subSchemas =
      kind === 'method'
        ? [
            ['params', document.params],
            ['result', document.result],
          ]
        : kind === 'event'
          ? [['payload', document.payload]]
          : [];

    for (const [section, schema] of subSchemas) {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue;
      try {
        ajv.compile(schema);
      } catch (error) {
        issues.push({
          file,
          rule: `ajv-${section}`,
          message: `Invalid JSON Schema in ${section}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return issues;
}

export function generateForTarget(bundle, target, options = {}) {
  switch (target) {
    case 'ts':
      return generateTypeScript(bundle);
    case 'swift':
      return generateSwift(bundle);
    case 'kotlin':
      return generateKotlin(bundle, { packageName: options.packageName });
    case 'dart':
      return generateDart(bundle, { packageImport: options.packageImport });
    default:
      throw new Error(`Unsupported target "${target}" (supported: ts, swift, kotlin, dart)`);
  }
}

function parseArgs(argv) {
  const options = {
    specDir: defaultSpecDir,
    lint: false,
    target: undefined,
    out: undefined,
    packageName: undefined,
    packageImport: undefined,
    check: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lint') options.lint = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--spec') options.specDir = resolve(argv[++i] ?? '');
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--out') options.out = resolve(argv[++i] ?? '');
    else if (arg === '--package') options.packageName = argv[++i];
    else if (arg === '--dart-import') options.packageImport = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = loadSpecBundle(options.specDir);

  if (options.lint || options.check) {
    const issues = [
      ...lintSpecBundle(bundle),
      ...validateSpecSchemasWithAjv(bundle),
    ];
    if (issues.length > 0) {
      for (const issue of issues) {
        console.error(`[spec-lint] ${issue.file} (${issue.rule}): ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `Spec lint passed: ${bundle.schemas.length} schemas, ${bundle.methods.length} method/event specs, ${Object.keys(bundle.errors.document).length} error codes.`,
    );
  }

  if (options.target === undefined) return;
  const outPath = options.out ?? (options.target === 'ts' ? defaultTsOut : undefined);
  if (!outPath) {
    throw new Error(`Missing required --out <path> for target "${options.target}"`);
  }

  const generated = generateForTarget(bundle, options.target, {
    packageName: options.packageName,
    packageImport: options.packageImport,
  });

  if (options.check) {
    let existing = '';
    try {
      existing = readFileSync(outPath, 'utf8');
    } catch {
      console.error(`[codegen] Missing generated file: ${outPath}.`);
      process.exitCode = 1;
      return;
    }
    if (existing !== generated) {
      console.error(`[codegen] Out-of-date generated file: ${outPath}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Codegen check passed: ${relative(repoRoot, outPath)} is up to date.`);
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, generated, 'utf8');
  console.log(`Generated ${relative(repoRoot, outPath)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
