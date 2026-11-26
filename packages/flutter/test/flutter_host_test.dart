import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:open_jsbridge_flutter/open_jsbridge_flutter.dart';

import 'test_runner.dart';

class _DeviceGetInfoHandler extends BridgeHandler<Map<String, Object?>, Map<String, Object?>> {
  @override
  String get method => 'device.getInfo';

  @override
  bool get allowDegraded => true;

  @override
  Map<String, Object?> decode(Map<String, Object?> json) => json;

  @override
  Object? encode(Map<String, Object?> result) => result;

  @override
  Future<Map<String, Object?>> handle(
    Map<String, Object?> params,
    BridgeContext ctx,
  ) async =>
      <String, Object?>{'os': 'android', 'osVersion': '15'};
}

String _helloFrame({String id = 'h-1', String? sid}) => jsonEncode(<String, Object?>{
      'jsb': '1.0',
      if (sid != null) 'meta': <String, Object?>{'sid': sid},
      'rpc': <String, Object?>{
        'jsonrpc': '2.0',
        'id': id,
        'method': 'bridge.hello',
        'params': <String, Object?>{
          'protocols': <int>[1],
          'sdk': <String, Object?>{'name': 'open-jsbridge', 'version': '0.2.0'},
          'wants': <String>['cancel', 'events', 'callbacks', 'reverse'],
        },
      },
    });

String _reqFrame({
  required String sid,
  required String id,
  required String method,
  Map<String, Object?>? params,
}) =>
    jsonEncode(<String, Object?>{
      'jsb': '1.0',
      'meta': <String, Object?>{'sid': sid},
      'rpc': <String, Object?>{
        'jsonrpc': '2.0',
        'id': id,
        'method': method,
        if (params != null) 'params': params,
      },
    });

String _extractEnvelopeFromScript(String script) {
  const prefix = 'window.__OJSB_RECEIVE__&&window.__OJSB_RECEIVE__(';
  const suffix = ');';
  expectTrue(script.startsWith(prefix), 'unexpected script prefix: $script');
  expectTrue(script.endsWith(suffix), 'unexpected script suffix: $script');
  final literal = script.substring(prefix.length, script.length - suffix.length);
  return jsonDecode(literal) as String;
}

void registerFlutterHostTests() {
  testCase('OriginAllowlist enforces exact HTTPS origins and rejects prefixes, ports, http, and wildcards', () {
    final acl = OriginAllowlist(<String>['https://m.acme.com', 'https://app.acme.com:8443']);
    expectTrue(acl.allowsUrl('https://m.acme.com/home?a=1#top'));
    expectTrue(acl.allowsUrl('https://M.ACME.COM:443/path'));
    expectTrue(acl.allowsUrl('https://app.acme.com:8443/checkout'));
    expectFalse(acl.allowsUrl('https://m.acme.com.evil.test/'));
    expectFalse(acl.allowsUrl('https://m.acme.com:8443/'));
    expectFalse(acl.allowsUrl('http://m.acme.com/'));
    expectFalse(acl.allowsUrl('file:///etc/passwd'));
    expectFalse(acl.allowsUrl('data:text/html,hi'));
    expectFalse(acl.allowsUrl('about:blank'));
    expectFalse(acl.allowsUrl('https://user:pass@m.acme.com/'));

    expectThrows<ArgumentError>(() => OriginAllowlist(<String>[]));
    expectThrows<ArgumentError>(() => OriginAllowlist(<String>['http://m.acme.com']));
    expectThrows<ArgumentError>(() => OriginAllowlist(<String>['https://*.acme.com']));
    expectThrows<ArgumentError>(() => OriginAllowlist(<String>['https://m.acme.com/path']));
    expectThrows<ArgumentError>(() => OriginAllowlist(<String>['https://m.acme.com?q=1']));
    expectThrows<ArgumentError>(() => OriginAllowlist(<String>['https://m.acme.com#frag']));
  });

  testCase('S2 degraded transport is disabled by default (no shim, no handshake)', () async {
    final delivered = <String>[];
    final transport = InAppWebViewTransport(
      evaluateJavascript: (script) async => delivered.add(script),
    );
    final bridge = OJSBridge(
      registry: HandlerRegistry()..register(_DeviceGetInfoHandler()),
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
    )..attachTransport(transport);

    expectFalse(bridge.isTransportEnabled(transport));
    expectNull(bridge.shimFor(transport, initialUrl: Uri.parse('https://m.acme.com/')));

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/app'));
    final reply = await transport.handleCallHandler(_helloFrame());
    expectNull(reply);
    expectNull(bridge.sid);
    expectEqual(delivered.length, 0);

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('S2 degraded opt-in exposes only allowDegraded methods and hides caller origin/frame', () async {
    final delivered = <String>[];
    final transport = InAppWebViewTransport(
      evaluateJavascript: (script) async => delivered.add(script),
    );
    BridgeContext? capturedCtx;
    final registry = HandlerRegistry()
      ..register(_DeviceGetInfoHandler())
      ..on(
        'acme.publicInfo',
        (params, ctx) {
          capturedCtx = ctx;
          return <String, Object?>{'ok': true};
        },
        allowDegraded: true,
      )
      ..on(
        'acme.privileged',
        (params, ctx) => <String, Object?>{'secret': true},
        allowDegraded: false,
      );

    final bridge = OJSBridge(
      registry: registry,
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
      allowDegradedTransport: true,
    )..attachTransport(transport);

    expectTrue(bridge.isTransportEnabled(transport));
    expectNotNull(bridge.shimFor(transport, initialUrl: Uri.parse('https://m.acme.com/')));
    expectNull(bridge.shimFor(transport, initialUrl: Uri.parse('https://evil.example/')));

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/app'));
    final helloRaw = await transport.handleCallHandler(
      _helloFrame(),
      origin: Uri.parse('https://spoofed.example'),
      isMainFrame: true,
    );
    expectNotNull(helloRaw);
    final hello = jsonDecode(helloRaw!) as Map<String, Object?>;
    final result = (hello['rpc']! as Map<String, Object?>)['result']! as Map<String, Object?>;
    final sid = result['sid']! as String;
    final methods = (result['capabilities']! as Map<String, Object?>)['methods']! as Map<String, Object?>;

    expectTrue(methods.containsKey('device.getInfo'));
    expectTrue(methods.containsKey('acme.publicInfo'));
    expectFalse(methods.containsKey('acme.privileged'));

    final okRaw = await transport.handleCallHandler(
      _reqFrame(sid: sid, id: 'r-1', method: 'acme.publicInfo'),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    expectNotNull(okRaw);
    expectNotNull(capturedCtx);
    expectEqual(capturedCtx!.trust, Trust.degraded);
    expectNull(capturedCtx!.origin);
    expectNull(capturedCtx!.isMainFrame);

    final deniedRaw = await transport.handleCallHandler(
      _reqFrame(sid: sid, id: 'r-2', method: 'acme.privileged'),
    );
    expectNotNull(deniedRaw);
    final deniedErr =
        ((jsonDecode(deniedRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['error']!
            as Map<String, Object?>;
    expectEqual(deniedErr['code'], ErrorCode.permissionDenied);

    // Navigating to disallowed origin drops messages.
    transport.onDocumentCommit(Uri.parse('https://m.acme.com.evil.test/'));
    expectNull(bridge.sid);
    expectNull(await transport.handleCallHandler(_helloFrame(id: 'h-2')));

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('S1 full trust verifies origin and main frame, rejecting subframes and wrong origins', () async {
    final transport = InAppWebViewTransport(
      evaluateJavascript: (script) async {},
      trust: Trust.full,
    );
    BridgeContext? captured;
    final registry = HandlerRegistry()
      ..on('acme.secure', (params, ctx) {
        captured = ctx;
        return <String, Object?>{'origin': ctx.origin.toString()};
      });

    final bridge = OJSBridge(
      registry: registry,
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
    )..attachTransport(transport);

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/home'));

    // Subframe rejected.
    expectNull(
      await transport.handleCallHandler(
        _helloFrame(id: 'h-sub'),
        origin: Uri.parse('https://m.acme.com'),
        isMainFrame: false,
      ),
    );
    // Untrusted origin rejected.
    expectNull(
      await transport.handleCallHandler(
        _helloFrame(id: 'h-bad'),
        origin: Uri.parse('https://other.acme.com'),
        isMainFrame: true,
      ),
    );
    // Verified main frame + exact origin succeeds.
    final helloRaw = await transport.handleCallHandler(
      _helloFrame(id: 'h-ok'),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    expectNotNull(helloRaw);
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    final replyRaw = await transport.handleCallHandler(
      _reqFrame(sid: sid, id: 'r-1', method: 'acme.secure'),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    expectNotNull(replyRaw);
    expectEqual(captured!.trust, Trust.full);
    expectEqual(captured!.origin.toString(), 'https://m.acme.com');
    expectEqual(captured!.isMainFrame, true);

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('WebviewFlutterTransport delivers double-encoded replies and escapes U+2028/U+2029', () async {
    final scripts = <String>[];
    final transport = WebviewFlutterTransport(
      runJavaScript: (script) async => scripts.add(script),
    );
    final registry = HandlerRegistry()
      ..on(
        'conformance.echo',
        (params, ctx) => params ?? <String, Object?>{},
        allowDegraded: true,
      );
    final bridge = OJSBridge(
      registry: registry,
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
      allowDegradedTransport: true,
    )..attachTransport(transport);

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/'));
    await transport.handleJavaScriptMessage(_helloFrame());
    expectEqual(scripts.length, 1);

    final helloEnv = jsonDecode(_extractEnvelopeFromScript(scripts.first)) as Map<String, Object?>;
    final sid = ((helloEnv['rpc']! as Map<String, Object?>)['result']! as Map<String, Object?>)['sid']! as String;

    const tricky = 'line1\n"quote"\\slash\u2028sep1\u2029sep2</script>';
    await transport.handleJavaScriptMessage(
      _reqFrame(
        sid: sid,
        id: 'e-1',
        method: 'conformance.echo',
        params: <String, Object?>{'text': tricky},
      ),
    );
    expectEqual(scripts.length, 2);
    expectFalse(scripts[1].contains('\u2028'));
    expectFalse(scripts[1].contains('\u2029'));

    final echoEnv = jsonDecode(_extractEnvelopeFromScript(scripts[1])) as Map<String, Object?>;
    final echoResult = (echoEnv['rpc']! as Map<String, Object?>)['result']! as Map<String, Object?>;
    expectEqual(echoResult['text'], tricky);

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('Events subscribe/unsubscribe/emit and denied events respect session isolation', () async {
    final scripts = <String>[];
    final transport = InAppWebViewTransport(
      evaluateJavascript: (script) async => scripts.add(script),
      trust: Trust.full,
    );
    final bridge = OJSBridge(
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
      events: <String>['network.statusChanged'],
      deniedEvents: <String>['acme.restricted'],
    )..attachTransport(transport);

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/'));
    final helloRaw = await transport.handleCallHandler(
      _helloFrame(),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    // Emit before subscribing does nothing.
    expectFalse(await bridge.emit('network.statusChanged', <String, Object?>{'type': 'wifi'}));
    expectEqual(scripts.length, 0);

    // Subscribe to both allowed and denied events.
    final subRaw = await transport.handleCallHandler(
      _reqFrame(
        sid: sid,
        id: 's-1',
        method: 'bridge.subscribe',
        params: <String, Object?>{
          'events': <String>['network.statusChanged', 'acme.restricted'],
        },
      ),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    final subResult =
        ((jsonDecode(subRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>;
    expectEqual(subResult, <String, Object?>{
      'subscribed': <String>['network.statusChanged'],
      'denied': <String>['acme.restricted'],
    });

    expectTrue(await bridge.emit('network.statusChanged', <String, Object?>{'type': 'wifi'}));
    expectEqual(scripts.length, 1);
    final evtEnv = jsonDecode(_extractEnvelopeFromScript(scripts.first)) as Map<String, Object?>;
    expectEqual((evtEnv['meta']! as Map<String, Object?>)['sid'], sid);
    expectEqual((evtEnv['rpc']! as Map<String, Object?>)['method'], 'bridge.event');
    expectEqual((evtEnv['rpc']! as Map<String, Object?>)['params'], <String, Object?>{
      'name': 'network.statusChanged',
      'payload': <String, Object?>{'type': 'wifi'},
    });

    // Unsubscribe stops delivery.
    await transport.handleCallHandler(
      _reqFrame(
        sid: sid,
        id: 'u-1',
        method: 'bridge.unsubscribe',
        params: <String, Object?>{
          'events': <String>['network.statusChanged'],
        },
      ),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    expectFalse(await bridge.emit('network.statusChanged', <String, Object?>{'type': 'cellular'}));
    expectEqual(scripts.length, 1);

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('bridge.progress delivers ordered chunks and bridge.cancel aborts inflight handler', () async {
    final pushed = <Map<String, Object?>>[];
    final gate = Completer<void>();
    var cancelObserved = false;

    final registry = HandlerRegistry()
      ..on('conformance.stream', (params, ctx) {
        expectTrue(ctx.callback(<String, Object?>{'step': 0}));
        expectTrue(ctx.callback(<String, Object?>{'step': 1}));
        return <String, Object?>{'done': 2};
      })
      ..on('conformance.delay', (params, ctx) async {
        ctx.cancel.addListener((_) => cancelObserved = true);
        await gate.future;
        return <String, Object?>{'late': true};
      });

    final bridge = OJSBridge(registry: registry)
      ..setRawDeliver((raw) async {
        pushed.add(jsonDecode(raw) as Map<String, Object?>);
      });

    final helloRaw = await bridge.receiveRaw(_helloFrame());
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    // Progress callbacks.
    final streamReplyRaw = await bridge.receiveRaw(
      _reqFrame(sid: sid, id: 'st-1', method: 'conformance.stream'),
    );
    expectEqual(
      ((jsonDecode(streamReplyRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result'],
      <String, Object?>{'done': 2},
    );
    expectEqual(pushed.length, 2);
    expectEqual((pushed[0]['rpc']! as Map<String, Object?>)['method'], 'bridge.progress');
    expectEqual((pushed[0]['rpc']! as Map<String, Object?>)['params'], <String, Object?>{
      'requestId': 'st-1',
      'seq': 0,
      'chunk': <String, Object?>{'step': 0},
    });
    expectEqual((pushed[1]['rpc']! as Map<String, Object?>)['params'], <String, Object?>{
      'requestId': 'st-1',
      'seq': 1,
      'chunk': <String, Object?>{'step': 1},
    });

    // Cancellation.
    final delayFuture = bridge.receiveRaw(
      _reqFrame(sid: sid, id: 'dl-1', method: 'conformance.delay'),
    );
    await Future<void>.delayed(Duration.zero);

    final cancelReply = await bridge.receiveRaw(
      jsonEncode(<String, Object?>{
        'jsb': '1.0',
        'meta': <String, Object?>{'sid': sid},
        'rpc': <String, Object?>{
          'jsonrpc': '2.0',
          'method': 'bridge.cancel',
          'params': <String, Object?>{'requestId': 'dl-1', 'reason': 'abort'},
        },
      }),
    );
    expectNull(cancelReply);
    expectTrue(cancelObserved);
    expectTrue(bridge.wasCancelled('dl-1'));

    gate.complete();
    final cancelledResponse = jsonDecode((await delayFuture)!) as Map<String, Object?>;
    expectEqual(
      ((cancelledResponse['rpc']! as Map<String, Object?>)['error']! as Map<String, Object?>)['code'],
      ErrorCode.cancelled,
    );
  });

  testCase('Serial concurrency returns Busy (-32010) and document navigation drops stale replies (L2)', () async {
    final firstGate = Completer<void>();
    var firstCancelled = false;
    final scripts = <String>[];
    final transport = InAppWebViewTransport(
      evaluateJavascript: (script) async => scripts.add(script),
      trust: Trust.full,
    );

    final registry = HandlerRegistry()
      ..on(
        'conformance.serial',
        (params, ctx) async {
          ctx.cancel.addListener((_) => firstCancelled = true);
          await firstGate.future;
          return <String, Object?>{'ok': true};
        },
        concurrency: ConcurrencyMode.serial,
      );

    final bridge = OJSBridge(
      registry: registry,
      allowedOrigins: OriginAllowlist(<String>['https://m.acme.com']),
    )..attachTransport(transport);

    transport.onDocumentCommit(Uri.parse('https://m.acme.com/page1'));
    final helloRaw = await transport.handleCallHandler(
      _helloFrame(),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    final firstFuture = transport.handleCallHandler(
      _reqFrame(sid: sid, id: 'ser-1', method: 'conformance.serial'),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    await Future<void>.delayed(Duration.zero);

    final secondRaw = await transport.handleCallHandler(
      _reqFrame(sid: sid, id: 'ser-2', method: 'conformance.serial'),
      origin: Uri.parse('https://m.acme.com'),
      isMainFrame: true,
    );
    expectEqual(
      (((jsonDecode(secondRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['error']!
          as Map<String, Object?>)['code'],
      ErrorCode.busy,
    );

    // Navigate to page2 while ser-1 is inflight: cancels handler and drops stale response!
    transport.onDocumentCommit(Uri.parse('https://m.acme.com/page2'));
    await Future<void>.delayed(Duration.zero);
    expectTrue(firstCancelled);
    expectNull(bridge.sid);

    firstGate.complete();
    expectNull(await firstFuture);
    expectEqual(scripts.length, 0);

    bridge.detachTransport();
    transport.dispose();
  });

  testCase('Host -> Web callWeb sends request, resolves reply, handles timeout & invalidation', () async {
    final sentToWeb = <Map<String, Object?>>[];
    final bridge = OJSBridge();
    bridge.setRawDeliver((raw) async {
      sentToWeb.add(jsonDecode(raw) as Map<String, Object?>);
    });

    final helloRaw = await bridge.receiveRaw(_helloFrame());
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    // Web announces its reverse methods.
    final regRaw = await bridge.receiveRaw(
      _reqFrame(
        sid: sid,
        id: 'reg-1',
        method: 'bridge.registerWebMethods',
        params: <String, Object?>{
          'methods': <String>['page.getShareInfo'],
        },
      ),
    );
    expectEqual(
      ((jsonDecode(regRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result'],
      <String, Object?>{
        'registered': <String>['page.getShareInfo'],
      },
    );
    expectTrue(bridge.webMethods.contains('page.getShareInfo'));

    // 1. Successful reverse call.
    final callFuture = bridge.callWeb(
      'page.getShareInfo',
      params: <String, Object?>{'channel': 'link'},
      timeout: const Duration(seconds: 2),
    );
    await Future<void>.delayed(Duration.zero);
    expectEqual(sentToWeb.length, 1);
    final reqRpc = sentToWeb.first['rpc']! as Map<String, Object?>;
    expectEqual(reqRpc['method'], 'page.getShareInfo');
    final reqId = reqRpc['id']! as String;

    await bridge.receiveRaw(
      jsonEncode(<String, Object?>{
        'jsb': '1.0',
        'meta': <String, Object?>{'sid': sid},
        'rpc': <String, Object?>{
          'jsonrpc': '2.0',
          'id': reqId,
          'result': <String, Object?>{'title': 'Open JSBridge'},
        },
      }),
    );
    expectEqual(await callFuture, <String, Object?>{'title': 'Open JSBridge'});

    // 2. Timeout sends bridge.cancel and rejects -32001.
    final timedOut = await expectThrowsAsync<BridgeException>(
      () => bridge.callWeb('page.getShareInfo', timeout: const Duration(milliseconds: 25)),
    );
    expectEqual(timedOut.code, ErrorCode.timeout);
    await Future<void>.delayed(Duration.zero);
    final lastRpc = sentToWeb.last['rpc']! as Map<String, Object?>;
    expectEqual(lastRpc['method'], 'bridge.cancel');

    // 3. Session invalidation cancels pending callWeb with -32002.
    final pendingFuture = bridge.callWeb('page.getShareInfo', timeout: const Duration(seconds: 5));
    await Future<void>.delayed(Duration.zero);
    bridge.invalidate('navigation');
    final cancelled = await expectThrowsAsync<BridgeException>(() => pendingFuture);
    expectEqual(cancelled.code, ErrorCode.cancelled);
  });

  testCase('Error isolation hides internal exceptions and respects maxMessageBytes (-32006)', () async {
    final registry = HandlerRegistry()
      ..on('conformance.throw', (params, ctx) => throw StateError('secret stack detail'))
      ..on('conformance.big', (params, ctx) => <String, Object?>{'blob': 'x' * 512});

    final bridge = OJSBridge(
      registry: registry,
      limits: const BridgeLimits(maxMessageBytes: 256),
    );

    final helloRaw = await bridge.receiveRaw(_helloFrame());
    final sid =
        (((jsonDecode(helloRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['result']!
            as Map<String, Object?>)['sid']! as String;

    final throwRaw = await bridge.receiveRaw(_reqFrame(sid: sid, id: 't-1', method: 'conformance.throw'));
    final throwErr =
        ((jsonDecode(throwRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['error']!
            as Map<String, Object?>;
    expectEqual(throwErr['code'], ErrorCode.internalError);
    expectFalse((throwErr['message']! as String).contains('secret'));

    final bigRaw = await bridge.receiveRaw(_reqFrame(sid: sid, id: 'b-1', method: 'conformance.big'));
    final bigErr =
        ((jsonDecode(bigRaw!) as Map<String, Object?>)['rpc']! as Map<String, Object?>)['error']!
            as Map<String, Object?>;
    expectEqual(bigErr['code'], ErrorCode.payloadTooLarge);
  });
}

Future<void> main() async {
  registerFlutterHostTests();
  final failed = await runRegisteredTests();
  if (failed > 0) exitCode = 1;
}
