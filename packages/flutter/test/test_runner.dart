import 'dart:async';
import 'dart:io';

typedef TestBody = FutureOr<void> Function();

class TestFailure implements Exception {
  final String message;
  const TestFailure(this.message);

  @override
  String toString() => 'TestFailure: $message';
}

class _TestCase {
  final String name;
  final TestBody body;
  const _TestCase(this.name, this.body);
}

final List<_TestCase> _cases = <_TestCase>[];

void testCase(String name, TestBody body) {
  _cases.add(_TestCase(name, body));
}

void expectEqual(Object? actual, Object? expected, [String? reason]) {
  if (!_deepEquals(actual, expected)) {
    final prefix = reason == null ? '' : '$reason: ';
    throw TestFailure('${prefix}expected <$expected>, got <$actual>');
  }
}

void expectTrue(bool condition, [String? reason]) {
  if (!condition) {
    throw TestFailure(reason ?? 'expected condition to be true');
  }
}

void expectFalse(bool condition, [String? reason]) {
  if (condition) {
    throw TestFailure(reason ?? 'expected condition to be false');
  }
}

void expectNull(Object? value, [String? reason]) {
  if (value != null) {
    final prefix = reason == null ? '' : '$reason: ';
    throw TestFailure('${prefix}expected null, got <$value>');
  }
}

void expectNotNull(Object? value, [String? reason]) {
  if (value == null) {
    throw TestFailure(reason ?? 'expected non-null value');
  }
}

T expectThrows<T extends Object>(void Function() fn, [String? reason]) {
  try {
    fn();
  } on T catch (error) {
    return error;
  } catch (error) {
    final prefix = reason == null ? '' : '$reason: ';
    throw TestFailure('${prefix}expected $T, got ${error.runtimeType}: $error');
  }
  final prefix = reason == null ? '' : '$reason: ';
  throw TestFailure('${prefix}expected $T to be thrown, but nothing threw');
}

Future<T> expectThrowsAsync<T extends Object>(
  Future<Object?> Function() fn, [
  String? reason,
]) async {
  try {
    await fn();
  } on T catch (error) {
    return error;
  } catch (error) {
    final prefix = reason == null ? '' : '$reason: ';
    throw TestFailure('${prefix}expected $T, got ${error.runtimeType}: $error');
  }
  final prefix = reason == null ? '' : '$reason: ';
  throw TestFailure('${prefix}expected $T to be thrown, but nothing threw');
}

bool deepEquals(Object? a, Object? b) => _deepEquals(a, b);

bool _deepEquals(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is num && b is num) {
    if (a.isNaN && b.isNaN) return true;
    return a == b;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (!b.containsKey(entry.key)) return false;
      if (!_deepEquals(entry.value, b[entry.key])) return false;
    }
    return true;
  }
  return a == b;
}

Future<int> runRegisteredTests() async {
  var passed = 0;
  var failed = 0;
  final toRun = List<_TestCase>.of(_cases);
  _cases.clear();

  for (final item in toRun) {
    try {
      await item.body();
      passed += 1;
    } catch (error, stackTrace) {
      failed += 1;
      stderr.writeln('FAIL: ${item.name}');
      stderr.writeln('  $error');
      stderr.writeln(stackTrace);
    }
  }

  stdout.writeln('Dart tests: $passed passed, $failed failed (${toRun.length} total)');
  return failed;
}
