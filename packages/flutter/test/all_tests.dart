import 'dart:io';

import 'flutter_host_test.dart';
import 'host_inbound_raw_conformance_test.dart';
import 'test_runner.dart';
import 'wire_conformance_test.dart';

Future<void> main() async {
  registerWireConformanceTests();
  registerHostInboundRawConformanceTests();
  registerFlutterHostTests();
  final failed = await runRegisteredTests();
  if (failed > 0) exitCode = 1;
}
