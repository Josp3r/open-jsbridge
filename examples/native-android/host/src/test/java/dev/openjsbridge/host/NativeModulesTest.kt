package dev.openjsbridge.host

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeModulesTest {
    @Test
    fun methodsAdvertiseAndDispatchIndependently() {
        val device = Client(BridgeModules(device = DeviceModule("15")))
        device.commit()
        assertEquals(setOf("device.getInfo"), device.methods())
        assertEquals(obj("""{"os":"android","osVersion":"15"}"""), device.call("device.getInfo@1").result())
        assertEquals(obj("""{"os":"android","osVersion":"15"}"""), device.call("device.getInfo", "{}").result())
        assertEquals(-32601, device.call("device.getInfo@2").errorCode())
        assertEquals(-32601, device.call("network.getStatus").errorCode())

        var type = NetworkType.WIFI
        val network = Client(BridgeModules(network = NetworkModule { type }))
        network.commit()
        assertEquals(setOf("network.getStatus"), network.methods())
        assertEquals(obj("""{"type":"wifi"}"""), network.call("network.getStatus@1").result())
        type = NetworkType.CELLULAR
        assertEquals(obj("""{"type":"cellular"}"""), network.call("network.getStatus", "{}").result())
        assertEquals(-32601, network.call("device.getInfo").errorCode())
        assertEquals(-32601, network.call("network.getStatus@2").errorCode())
    }

    @Test
    fun nativeQueryParamsMustBeAbsentOrAnEmptyObject() {
        val client = Client(BridgeModules(DeviceModule("15"), NetworkModule { NetworkType.NONE }))
        client.commit()
        client.hello()
        for (method in listOf("device.getInfo", "network.getStatus")) {
            assertEquals(-32602, client.call(method, """{"unexpected":true}""").errorCode())
            assertEquals(-32600, client.call(method, "[]").errorCode())
            assertEquals(-32600, client.call(method, "null").errorCode())
        }
    }

    @Test
    fun toastIsAdvertisedOnlyWhenEnabledAndDispatchesBothVersionOneNames() {
        val disabled = Client(BridgeModules())
        disabled.commit()
        assertTrue(disabled.methods().isEmpty())
        assertEquals(-32601, disabled.call("ui.toast.show", """{"text":"Hello"}""").errorCode())

        val shown = mutableListOf<String>()
        val enabled = Client(BridgeModules(device = DeviceModule("15"), toast = ToastModule { shown.add(it) }))
        enabled.commit()
        assertEquals(setOf("device.getInfo", "ui.toast.show"), enabled.methods())
        assertEquals(obj("{}"), enabled.call("ui.toast.show", """{"text":"Hello"}""").result())
        val limit = "😀".repeat(120)
        assertEquals(obj("{}"), enabled.call("ui.toast.show@1", """{"text":"$limit"}""").result())
        assertEquals(-32601, enabled.call("ui.toast.show@2", """{"text":"Hello"}""").errorCode())
        assertEquals(listOf("Hello", limit), shown)
    }

    @Test
    fun toastRejectsMissingTextInvalidTextAndAdditionalFieldsBeforePresenting() {
        val shown = mutableListOf<String>()
        val client = Client(BridgeModules(toast = ToastModule { shown.add(it) }))
        client.commit()
        client.hello()

        val invalid = listOf(null, "{}", """{"text":null}""", """{"text":true}""", """{"text":7}""",
            """{"text":""}""", """{"text":"${"😀".repeat(121)}"}""", """{"text":"Hello","duration":2}""")
        for (params in invalid) {
            assertEquals(params, -32602, client.call("ui.toast.show", params).errorCode())
        }
        assertEquals(-32600, client.call("ui.toast.show", "[]").errorCode())
        assertTrue(shown.isEmpty())
    }

    @Test
    fun toastReturnsAnInternalErrorWhenPresentationFails() {
        val client = Client(BridgeModules(toast = ToastModule { throw IllegalStateException("No presenter") }))
        client.commit()
        client.hello()

        assertEquals(-32603, client.call("ui.toast.show@1", """{"text":"Hello"}""").errorCode())
    }

    @Test
    fun eventAdvertisesOnlyWithAnOptedInObserverAndConfirmedDocument() {
        val network = FakeNetworkEvents()
        val client = Client(BridgeModules(networkEvents = network))
        client.commit()
        assertEquals("[]", client.hello().getAsJsonArray("events").toString())
        assertEquals(obj("""{"subscribed":[],"denied":["network.changed"]}"""), client.subscribe().result())
        assertEquals(0, network.callbacks.size)

        client.confirm(proxy = Any())
        client.confirm(challenge = "not-current")
        assertEquals("[]", client.hello().getAsJsonArray("events").toString())
        client.confirm()
        val capabilities = client.hello()
        assertEquals("[\"network.changed\"]", capabilities.getAsJsonArray("events").toString())
        assertTrue(capabilities.getAsJsonObject("methods").keySet().isEmpty())
        assertEquals(0, network.callbacks.size)

        val disabled = Client(BridgeModules(network = NetworkModule { NetworkType.NONE }))
        disabled.commit()
        disabled.confirm()
        assertEquals("[]", disabled.hello().getAsJsonArray("events").toString())
    }

    @Test
    fun subscriptionControlsPartitionRequestsAndRequireValidNames() {
        val network = FakeNetworkEvents()
        val client = Client(BridgeModules(networkEvents = network))
        client.commit()
        client.confirm()
        client.hello()

        for (method in listOf("bridge.subscribe", "bridge.unsubscribe@1")) {
            for (params in listOf("{}", """{"events":[]}""", """{"events":["network.changed","network.changed"]}""",
                """{"events":["unqualified"]}""", """{"events":["rpc.reserved"]}""",
                """{"events":["network.changed@1"]}""", """{"events":[1]}""")) {
                assertEquals("$method $params", -32602, client.call(method, params).errorCode())
            }
        }
        assertEquals(0, network.callbacks.size)
        val names = """{"events":["acme.pay.orderChanged","network.changed","app.ready"]}"""
        assertEquals(obj("""{"subscribed":["network.changed"],"denied":["acme.pay.orderChanged","app.ready"]}"""),
            client.call("bridge.subscribe@1", names).result())
        client.subscribe()
        assertEquals(1, network.callbacks.size)
        repeat(2) {
            assertEquals(obj("""{"unsubscribed":["acme.pay.orderChanged","network.changed","app.ready"]}"""),
                client.call("bridge.unsubscribe@1", names).result())
        }
        assertEquals(listOf(0), network.stopped)
    }

    @Test
    fun callbacksRequirePostedAcknowledgementAndTheLiveSubscription() {
        val network = FakeNetworkEvents()
        val delayed = ArrayDeque<() -> Unit>()
        val client = Client(BridgeModules(networkEvents = network), delayed)
        client.commit()
        client.confirm()
        client.hello()
        client.request("bridge.subscribe", EVENTS)
        network.callbacks[0](NetworkType.WIFI)
        assertTrue(client.notifications.isEmpty())
        delayed.removeFirst()()
        network.callbacks[0](NetworkType.ETHERNET)
        assertEquals(obj("""{"jsb":"1.0","meta":{"sid":"${client.sid}"},"rpc":{"jsonrpc":"2.0","method":"bridge.event","params":{"name":"network.changed","payload":{"type":"ethernet"}}}}"""),
            client.notifications.single())

        client.call("bridge.unsubscribe", EVENTS)
        network.callbacks[0](NetworkType.NONE)
        client.subscribe()
        network.callbacks[0](NetworkType.UNKNOWN)
        assertEquals(1, client.notifications.size)
        network.callbacks[1](NetworkType.OTHER)
        assertEquals("other", client.notifications.last().getAsJsonObject("rpc").getAsJsonObject("params")
            .getAsJsonObject("payload").get("type").asString)
    }

    @Test
    fun replacingOrInvalidatingTheDocumentRetiresItsNetworkObserver() {
        val network = FakeNetworkEvents()
        val client = Client(BridgeModules(networkEvents = network))
        client.commit()
        client.confirm()
        client.hello()
        client.subscribe()
        val oldSid = client.sid
        val oldToken = client.token

        client.commit(token = "b".repeat(32))
        assertEquals(listOf(0), network.stopped)
        client.confirm()
        client.hello()
        assertNotEquals(oldSid, client.sid)
        network.callbacks[0](NetworkType.WIFI)
        assertTrue(client.notifications.isEmpty())

        client.subscribe()
        client.transport.receive("leave:$oldToken", ORIGIN, true, client.proxy) { error("No reply to leave") }
        assertEquals(listOf(0), network.stopped)
        client.transport.invalidate()
        assertEquals(listOf(0, 1), network.stopped)
        network.callbacks[1](NetworkType.NONE)
        assertTrue(client.notifications.isEmpty())
    }

    @Test
    fun observerRegistrationFailureDeniesTheEventWithoutLeavingASubscription() {
        val network = FakeNetworkEvents().apply { available = false }
        val client = Client(BridgeModules(networkEvents = network))
        client.commit()
        client.confirm()
        client.hello()

        assertEquals(obj("""{"subscribed":[],"denied":["network.changed"]}"""), client.subscribe().result())
        assertTrue(network.callbacks.isEmpty())
        network.available = true
        assertEquals(obj("""{"subscribed":["network.changed"],"denied":[]}"""), client.subscribe().result())
        assertFalse(network.callbacks.isEmpty())
    }

    @Test
    fun oversizedControlRepliesLeaveTheCurrentSubscriptionUnchanged() {
        val network = FakeNetworkEvents()
        val client = Client(BridgeModules(networkEvents = network))
        client.commit()
        client.confirm()
        client.hello()

        // A literal Unicode line separator takes three bytes on input and six
        // when Gson escapes it in a reply. The request fits the envelope limit.
        val params = """{"events":["network.changed","acme.${"a".repeat(64_970)}"]}"""
        val separators = "\u2028".repeat(127)
        assertEquals(-32006, client.call("bridge.subscribe", params, id = "s$separators").errorCode())
        assertTrue(network.callbacks.isEmpty())

        client.subscribe()
        assertEquals(-32006, client.call("bridge.unsubscribe", params, id = "u$separators").errorCode())
        assertTrue(network.stopped.isEmpty())
        network.callbacks.single()(NetworkType.WIFI)
        assertEquals(1, client.notifications.size)
    }

    private class FakeNetworkEvents : NetworkEvents {
        var available = true
        val callbacks = mutableListOf<(NetworkType) -> Unit>()
        val stopped = mutableListOf<Int>()

        override fun observe(onChange: (NetworkType) -> Unit): (() -> Unit)? {
            if (!available) return null
            val index = callbacks.size
            callbacks.add(onChange)
            return { stopped.add(index) }
        }
    }

    private class Client(modules: BridgeModules, private val delayed: ArrayDeque<() -> Unit>? = null) {
        val transport = DocumentTransport(ORIGIN, enableEcho = false, modules = modules) { reply ->
            if (delayed == null) reply() else delayed.addLast(reply)
        }
        val proxy = Any()
        val notifications = mutableListOf<JsonObject>()
        var sid: String? = null
            private set
        var token = "a".repeat(32)
            private set
        private val responses = ArrayDeque<JsonObject>()
        private lateinit var challenge: String
        private var nextId = 0

        fun commit(token: String = this.token) {
            this.token = token
            challenge = checkNotNull(transport.onPageCommitVisible(ORIGIN))
            val messages = mutableListOf<String>()
            transport.receive("commit:$challenge:$token", ORIGIN, true, proxy) { messages.add(it) }
            assertEquals(listOf("ready:$challenge:$token"), messages)
        }

        fun confirm(challenge: String = this.challenge, proxy: Any = this.proxy) {
            val token = this.token
            transport.receive("push:$challenge:$token", ORIGIN, true, proxy) {
                notifications.add(obj(it.removePrefix("rpc:$token:")))
            }
        }

        fun hello(): JsonObject = call("bridge.hello", """{"protocols":[1]}""", useSid = false).result().let {
            sid = it.get("sid").asString
            it.getAsJsonObject("capabilities")
        }

        fun methods(): Set<String> = hello().getAsJsonObject("methods").entrySet().map { (name, version) ->
            assertEquals(obj("""{"versions":[1]}"""), version)
            name
        }.toSet()

        fun subscribe() = call("bridge.subscribe", EVENTS)

        fun request(method: String, params: String?, useSid: Boolean = true, id: String = (nextId++).toString()) {
            val token = this.token
            val meta = if (useSid) """"meta":{"sid":"$sid"},""" else ""
            val args = params?.let { ""","params":$it""" }.orEmpty()
            val payload = """{"jsb":"1.0",${meta}"rpc":{"jsonrpc":"2.0","id":"$id","method":"$method"$args}}"""
            transport.receive("rpc:$token:$payload", ORIGIN, true, proxy) {
                responses.addLast(obj(it.removePrefix("rpc:$token:")).getAsJsonObject("rpc"))
            }
        }

        fun call(method: String, params: String? = null, useSid: Boolean = true, id: String = (nextId++).toString()): JsonObject {
            request(method, params, useSid, id)
            delayed?.removeFirst()?.invoke()
            return responses.removeLast()
        }
    }

    private companion object {
        const val ORIGIN = "https://example.test"
        const val EVENTS = """{"events":["network.changed"]}"""
        fun obj(raw: String): JsonObject = JsonParser.parseString(raw).asJsonObject
        fun JsonObject.result(): JsonObject = getAsJsonObject("result")
        fun JsonObject.errorCode(): Int = getAsJsonObject("error").get("code").asInt
    }
}
