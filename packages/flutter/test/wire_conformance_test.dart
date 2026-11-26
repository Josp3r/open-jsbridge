import 'dart:convert';
import 'dart:io';

import 'package:open_jsbridge_flutter/open_jsbridge_flutter.dart';

import 'test_runner.dart';

File _resolveFixture(String relativePath) {
  final candidates = <String>[
    relativePath,
    '../../$relativePath',
    '${Directory.current.path}/$relativePath',
  ];
  for (final candidate in candidates) {
    final file = File(candidate);
    if (file.existsSync()) return file;
  }
  throw StateError('Unable to locate fixture $relativePath from ${Directory.current.path}');
}

void registerWireConformanceTests() {
  final fixture = jsonDecode(
    _resolveFixture('conformance-tests/fixtures/wire.json').readAsStringSync(),
  ) as Map<String, Object?>;

  final validCases = fixture['valid']! as List<Object?>;
  for (final entry in validCases) {
    final map = entry! as Map<String, Object?>;
    final name = map['name']! as String;
    final frame = map['frame']! as Map<String, Object?>;

    testCase('wire valid: $name', () {
      final raw = jsonEncode(frame);
      final envelope = decodeEnvelope(raw);
      final reencoded = encodeEnvelope(envelope);
      expectEqual(jsonDecode(reencoded), frame);
    });
  }

  final invalidCases = fixture['invalid']! as List<Object?>;
  for (final entry in invalidCases) {
    final map = entry! as Map<String, Object?>;
    final name = map['name']! as String;
    final expectedCode = (map['error']! as num).toInt();
    final raw = map.containsKey('raw')
        ? map['raw']! as String
        : jsonEncode(map['frame']);

    testCase('wire invalid: $name', () {
      final err = expectThrows<WireDecodeException>(() => decodeEnvelope(raw));
      expectEqual(err.code, expectedCode, 'wrong error code for $name');
    });
  }

  testCase('wire decode strips __proto__ recursively and preserves constructor & prototype', () {
    const raw =
        '{"jsb":"1.0","meta":{"sid":"s-1"},"rpc":{"jsonrpc":"2.0","id":"w-1","method":"conformance.echo","params":{"__proto__":{"polluted":true},"constructor":"keep-ctor","prototype":"keep-proto","nested":{"__proto__":1,"constructor":2,"prototype":3}}}}';
    final envelope = decodeEnvelope(raw);
    final req = envelope.rpc as RpcRequest;
    final params = req.params!;
    expectFalse(params.containsKey('__proto__'));
    expectEqual(params['constructor'], 'keep-ctor');
    expectEqual(params['prototype'], 'keep-proto');
    final nested = params['nested']! as Map<String, Object?>;
    expectFalse(nested.containsKey('__proto__'));
    expectEqual(nested['constructor'], 2);
    expectEqual(nested['prototype'], 3);
  });

  testCase('wire encode rejects cyclic objects and unsafe integers', () {
    final cyclic = <String, Object?>{};
    cyclic['self'] = cyclic;
    final cyclicErr = expectThrows<WireDecodeException>(
      () => encodeEnvelope(
        Envelope(
          rpc: RpcRequest(id: 'w-1', method: 'conformance.echo', params: cyclic),
        ),
      ),
    );
    expectEqual(cyclicErr.code, ErrorCode.invalidRequest);

    final unsafeErr = expectThrows<WireDecodeException>(
      () => encodeEnvelope(
        const Envelope(
          rpc: RpcSuccess(id: 'w-1', result: 9007199254740992),
        ),
      ),
    );
    expectEqual(unsafeErr.code, ErrorCode.invalidRequest);
  });
}

Future<void> main() async {
  registerWireConformanceTests();
  final failed = await runRegisteredTests();
  if (failed > 0) exitCode = 1;
}
