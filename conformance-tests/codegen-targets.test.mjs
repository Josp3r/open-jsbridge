import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  generateDart,
  generateKotlin,
  generateSwift,
} from '../dist/packages/codegen/src/index.js';
import { loadSpecBundle } from '../scripts/codegen.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = resolve(repoRoot, 'scripts/codegen.mjs');
const flutterPkgPath = resolve(repoRoot, 'packages/flutter');

function hasDartToolchain() {
  try {
    execFileSync('dart', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function keywordAndVersionBundle() {
  return {
    schemas: [
      {
        path: 'schemas/sample-item.json',
        document: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'ojsb:schema/sample.item',
          title: 'SampleItem',
          type: 'object',
          required: ['default', 'class'],
          additionalProperties: false,
          properties: {
            default: { type: 'string' },
            class: { type: 'integer' },
            object: { type: 'boolean' },
          },
        },
      },
    ],
    methods: [
      {
        path: 'methods/sample/get@2.json',
        document: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'ojsb:method/sample.get@2',
          title: 'sample.get',
          description: 'Fetch sample v2.',
          'x-ojsb-kind': 'method',
          'x-ojsb-version': 2,
          'x-ojsb-since': '1.0',
          params: { type: 'object', maxProperties: 0 },
          result: { $ref: 'ojsb:schema/sample.item' },
        },
      },
    ],
    errors: {
      path: 'protocol/errors.json',
      document: {
        ParseError: { code: -32700, message: 'Parse error' },
        Timeout: { code: -32001, message: 'Timeout' },
      },
    },
  };
}

test('Swift emitter generates Codable models, discriminated unions, handler protocols, and constants', () => {
  const bundle = loadSpecBundle();
  const swift = generateSwift(bundle);

  assert.equal(generateSwift(bundle), swift, 'Swift output must be deterministic');
  assert.match(swift, /public typealias MediaId = String/);
  assert.match(swift, /public enum NetworkStatusType: String, Codable, Sendable, Equatable, CaseIterable/);
  assert.match(swift, /public struct NetworkStatus: Codable, Sendable, Equatable/);
  assert.match(swift, /public struct DeviceGetInfoParams: Codable, Sendable, Equatable/);
  assert.match(swift, /public struct DeviceGetInfoResult: Codable, Sendable, Equatable/);
  assert.match(swift, /public enum MediaChooseMediaResult: Codable, Sendable, Equatable/);
  assert.match(swift, /case cancelled\(MediaChooseMediaResultCancelled\)/);
  assert.match(swift, /case selected\(MediaChooseMediaResultSelected\)/);
  assert.match(swift, /public protocol DeviceGetInfoHandler: OJSBGeneratedHandler where Params == DeviceGetInfoParams, Result == DeviceGetInfoResult/);
  assert.match(swift, /static var method: String \{ "device\.getInfo" \}/);
  assert.match(swift, /public enum OJSBErrorCode: Int, Sendable/);
  assert.match(swift, /case timeout = -32001/);
  assert.match(swift, /public enum OJSBEvent/);
  assert.match(swift, /networkStatusChanged = "network\.statusChanged"/);
  assert.doesNotMatch(swift, /public protocol BridgeHelloHandler/);
});

test('Kotlin emitter generates data classes, sealed unions, handler stubs, and respects packageName', () => {
  const bundle = loadSpecBundle();
  const kotlin = generateKotlin(bundle, { packageName: 'com.acme.bridge.gen' });

  assert.equal(generateKotlin(bundle, { packageName: 'com.acme.bridge.gen' }), kotlin);
  assert.match(kotlin, /^package com\.acme\.bridge\.gen$/m);
  assert.match(kotlin, /typealias MediaId = String/);
  assert.match(kotlin, /enum class NetworkStatusType\(val rawValue: String\)/);
  assert.match(kotlin, /data class NetworkStatus\(/);
  assert.match(kotlin, /sealed class MediaChooseMediaResult/);
  assert.match(kotlin, /data class Cancelled\(val value: MediaChooseMediaResultCancelled\) : MediaChooseMediaResult\(\)/);
  assert.match(kotlin, /data class Selected\(val value: MediaChooseMediaResultSelected\) : MediaChooseMediaResult\(\)/);
  assert.match(kotlin, /abstract class DeviceGetInfoHandler : OjsbGeneratedHandler<DeviceGetInfoParams, DeviceGetInfoResult>/);
  assert.match(kotlin, /override val method: String = "device\.getInfo"/);
  assert.match(kotlin, /const val TIMEOUT: Int = -32001/);
  assert.match(kotlin, /const val NETWORK_STATUS_CHANGED: String = "network\.statusChanged"/);
  assert.doesNotMatch(kotlin, /abstract class BridgeHelloHandler/);

  assert.throws(() => generateKotlin(bundle, { packageName: 'invalid..pkg!' }), /Invalid Kotlin package name/);
});

test('Dart emitter generates models, sealed unions, and open_jsbridge_flutter BridgeHandler stubs', () => {
  const bundle = loadSpecBundle();
  const dart = generateDart(bundle);

  assert.equal(generateDart(bundle), dart);
  assert.match(dart, /import 'package:open_jsbridge_flutter\/open_jsbridge_flutter\.dart';/);
  assert.match(dart, /typedef MediaId = String;/);
  assert.match(dart, /enum NetworkStatusType \{/);
  assert.match(dart, /sealed class MediaChooseMediaResult \{/);
  assert.match(dart, /abstract class DeviceGetInfoHandler extends BridgeHandler<DeviceGetInfoParams, DeviceGetInfoResult>/);
  assert.match(dart, /String get method => 'device\.getInfo';/);
  assert.match(dart, /static const int timeout = -32001;/);
  assert.match(dart, /static const String networkStatusChanged = 'network\.statusChanged';/);
  assert.doesNotMatch(dart, /abstract class BridgeHelloHandler/);
});

test('Swift, Kotlin, and Dart emitters escape language keywords and support @2 versions', () => {
  const bundle = keywordAndVersionBundle();

  const swift = generateSwift(bundle);
  assert.match(swift, /public let `default`: String/);
  assert.match(swift, /public let `class`: Int/);
  assert.match(swift, /public protocol SampleGetV2Handler/);
  assert.match(swift, /static var versions: \[Int\] \{ \[2\] \}/);

  const kotlin = generateKotlin(bundle);
  assert.match(kotlin, /val `class`: Long/);
  assert.match(kotlin, /val `object`: Boolean\? = null/);
  assert.match(kotlin, /abstract class SampleGetV2Handler/);
  assert.match(kotlin, /override val versions: List<Int> = listOf\(2\)/);

  const dart = generateDart(bundle);
  assert.match(dart, /final String defaultValue;/);
  assert.match(dart, /final int classValue;/);
  assert.match(dart, /defaultValue: json\['default'\]! as String/);
  assert.match(dart, /'default': defaultValue/);
  assert.match(dart, /abstract class SampleGetV2Handler/);
  assert.match(dart, /List<int> get versions => const <int>\[2\];/);
});

test('CLI supports --target swift, kotlin (--package), dart, and --check drift detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ojsb-codegen-cli-'));
  try {
    const swiftOut = join(dir, 'Generated.swift');
    const kotlinOut = join(dir, 'Generated.kt');
    const dartOut = join(dir, 'generated.dart');

    execFileSync(process.execPath, [cliPath, '--target', 'swift', '--out', swiftOut]);
    execFileSync(process.execPath, [cliPath, '--target', 'swift', '--out', swiftOut, '--check']);

    execFileSync(process.execPath, [cliPath, '--target', 'kotlin', '--package', 'com.acme.ojsb', '--out', kotlinOut]);
    execFileSync(process.execPath, [cliPath, '--target', 'kotlin', '--package', 'com.acme.ojsb', '--out', kotlinOut, '--check']);
    assert.match(readFileSync(kotlinOut, 'utf8'), /^package com\.acme\.ojsb$/m);

    execFileSync(process.execPath, [cliPath, '--target', 'dart', '--out', dartOut]);
    execFileSync(process.execPath, [cliPath, '--target', 'dart', '--out', dartOut, '--check']);

    // Mutating output causes --check to fail.
    writeFileSync(dartOut, `${readFileSync(dartOut, 'utf8')}\n// drift\n`, 'utf8');
    assert.throws(() => {
      execFileSync(process.execPath, [cliPath, '--target', 'dart', '--out', dartOut, '--check'], { stdio: 'pipe' });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Generated Dart output passes dart analyze --fatal-infos --fatal-warnings and executes against open_jsbridge_flutter', (t) => {
  if (!hasDartToolchain()) {
    t.skip('Dart SDK not installed in this environment');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'ojsb-codegen-dart-'));
  try {
    writeFileSync(
      join(dir, 'pubspec.yaml'),
      [
        'name: ojsb_codegen_smoke',
        'publish_to: none',
        'environment:',
        "  sdk: '>=3.4.0 <4.0.0'",
        'dependencies:',
        '  open_jsbridge_flutter:',
        `    path: ${flutterPkgPath}`,
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dir, 'analysis_options.yaml'),
      readFileSync(join(flutterPkgPath, 'analysis_options.yaml'), 'utf8'),
      'utf8',
    );

    const generatedPath = join(dir, 'lib/generated.dart');
    execFileSync(process.execPath, [cliPath, '--target', 'dart', '--out', generatedPath]);

    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(
      join(dir, 'bin/smoke.dart'),
      [
        "import 'package:open_jsbridge_flutter/open_jsbridge_flutter.dart';",
        "import 'package:ojsb_codegen_smoke/generated.dart';",
        '',
        'class _DeviceImpl extends DeviceGetInfoHandler {',
        '  @override',
        '  Future<DeviceGetInfoResult> handle(DeviceGetInfoParams params, BridgeContext ctx) async =>',
        "      const DeviceGetInfoResult(os: DeviceGetInfoResultOs.android, osVersion: '15');",
        '}',
        '',
        'Future<void> main() async {',
        '  final registry = HandlerRegistry()..register(_DeviceImpl());',
        '  final bridge = OJSBridge(registry: registry);',
        '  final hello = await bridge.receiveRaw(',
        '    \'{"jsb":"1.0","rpc":{"jsonrpc":"2.0","id":"h1","method":"bridge.hello","params":{"protocols":[1]}}}\',',
        '  );',
        "  if (hello == null || !hello.contains('device.getInfo')) {",
        "    throw StateError('Expected device.getInfo in hello capabilities');",
        '  }',
        '  final cancelled = MediaChooseMediaResult.fromJson(<String, Object?>{',
        "    'status': 'cancelled',",
        "    'files': <Object?>[],",
        '  });',
        "  if (cancelled is! MediaChooseMediaResultCancelled || cancelled.toJson()['status'] != 'cancelled') {",
        "    throw StateError('Discriminated union round-trip failed');",
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    execFileSync('dart', ['pub', 'get', '--offline'], { cwd: dir, stdio: 'pipe' });
    execFileSync('dart', ['analyze', '--fatal-infos', '--fatal-warnings'], { cwd: dir, stdio: 'pipe' });
    execFileSync('dart', ['run', 'bin/smoke.dart'], { cwd: dir, stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
