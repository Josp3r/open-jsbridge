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

OJSBridge _createEchoHost() {
  final registry = HandlerRegistry()
    ..on('conformance.echo', (params, ctx) => params ?? <String, Object?>{});
  return OJSBridge(registry: registry);
}

final RegExp _quotedTokenPattern = RegExp(r'"(?:[^"\\]|\\[\s\S])*"');

class _SessionState {
  String? sid;
  String? oldSid;
}

Future<void> _verifyStep(
  OJSBridge host,
  Map<String, Object?> step,
  _SessionState state,
  String label,
) async {
  final template = step['raw']! as String;
  final raw = template.replaceAllMapped(_quotedTokenPattern, (match) {
    final token = match.group(0)!;
    if (token != r'"$SID"' && token != r'"$OLD_SID"') return token;
    final sid = token == r'"$SID"' ? state.sid : state.oldSid;
    expectNotNull(sid, '$label: unbound $token');
    return jsonEncode(sid);
  });

  final accept = (step['accept']! as List<Object?>)
      .cast<Map<String, Object?>>();
  final reply = await host.receiveRaw(raw);

  if (reply == null) {
    expectTrue(
      accept.any((entry) => entry['kind'] == 'none'),
      '$label: unexpected silence; expected $accept',
    );
    return;
  }

  final frame = jsonDecode(reply) as Map<String, Object?>;
  expectEqual(frame['jsb'], '1.0', '$label: invalid envelope $reply');
  final meta = frame['meta'];
  expectTrue(meta == null || meta is Map<String, Object?>, '$label: invalid meta');
  final rpc = frame['rpc']! as Map<String, Object?>;
  expectEqual(rpc['jsonrpc'], '2.0', '$label: invalid jsonrpc');
  expectFalse(rpc.containsKey('method'), '$label: expected response, got $reply');

  final hasResult = rpc.containsKey('result');
  final hasError = rpc.containsKey('error');
  expectTrue(hasResult != hasError, '$label: expected result XOR error');

  final replySid = meta is Map<String, Object?> ? meta['sid'] : null;

  Map<String, Object?>? matched;
  for (final entry in accept) {
    if (entry['kind'] == 'none') continue;
    if (!rpc.containsKey('id') || rpc['id'] != entry['id']) continue;

    if (entry['kind'] == 'hello') {
      final result = rpc['result'];
      if (hasResult &&
          result is Map<String, Object?> &&
          result['jsb'] == '1.0' &&
          result['sid'] is String &&
          (result['sid']! as String).isNotEmpty &&
          (state.sid == null || result['sid'] == state.sid) &&
          (replySid == null || replySid == result['sid'])) {
        matched = entry;
        break;
      }
      continue;
    }

    final expectedSid = entry['sid'];
    final sidMatches = expectedSid == r'$SID'
        ? state.sid != null && replySid == state.sid
        : expectedSid == null && replySid == null;
    if (!sidMatches) continue;

    if (entry['kind'] == 'result') {
      if (hasResult && deepEquals(rpc['result'], entry['value'])) {
        matched = entry;
        break;
      }
      continue;
    }

    if (entry['kind'] == 'error' && hasError) {
      final error = rpc['error'];
      if (error is Map<String, Object?> &&
          error['code'] == entry['code'] &&
          error['message'] is String &&
          (!entry.containsKey('data') ||
              deepEquals(error['data'], entry['data']))) {
        matched = entry;
        break;
      }
    }
  }

  expectNotNull(matched, '$label: got $reply; expected $accept');
  if (matched!['kind'] == 'hello') {
    state.sid = (rpc['result']! as Map<String, Object?>)['sid']! as String;
  }
}

void registerHostInboundRawConformanceTests() {
  final fixture = jsonDecode(
    _resolveFixture('conformance-tests/fixtures/host-inbound-raw.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;

  expectEqual(fixture['version'], 1);
  final bootstrap = fixture['bootstrap']! as Map<String, Object?>;
  final cases = (fixture['cases']! as List<Object?>).cast<Map<String, Object?>>();

  for (final testCaseData in cases) {
    final name = testCaseData['name']! as String;
    final initial = testCaseData['initial']! as String;
    final steps = (testCaseData['steps']! as List<Object?>)
        .cast<Map<String, Object?>>();

    testCase('raw host: $name', () async {
      final host = _createEchoHost();
      final state = _SessionState();

      if (initial == 'replaced') {
        final previousState = _SessionState();
        await _verifyStep(
          _createEchoHost(),
          bootstrap,
          previousState,
          '$name: previous bootstrap',
        );
        state.oldSid = previousState.sid;
      }
      if (initial != 'fresh') {
        await _verifyStep(host, bootstrap, state, '$name: bootstrap');
        expectTrue(
          state.sid != state.oldSid,
          '$name: expected distinct session id',
        );
      }

      for (var i = 0; i < steps.length; i++) {
        await _verifyStep(host, steps[i], state, '$name: step ${i + 1}');
      }
    });
  }
}

Future<void> main() async {
  registerHostInboundRawConformanceTests();
  final failed = await runRegisteredTests();
  if (failed > 0) exitCode = 1;
}
