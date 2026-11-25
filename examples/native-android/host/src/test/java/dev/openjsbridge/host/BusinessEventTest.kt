package dev.openjsbridge.host

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BusinessEventTest {
    @Test
    fun validatesNamesAndSnapshotsRegistration() {
        for (name in listOf(
            "", "unqualified", "Acme.changed", "acme..changed", "acme.Changed", "acme.changed@1",
            "acme.changed\n", "bridge.changed", "conformance.echo", "ojsb.changed", "rpc.changed",
            "device.changed", "app.changed", "ui.changed", "storage.changed", "network.statusChanged", "network.changed", "media.changed",
        )) {
            assertThrows(name, IllegalArgumentException::class.java) { Client(listOf(name)) }
        }
        assertThrows(IllegalArgumentException::class.java) { Client(listOf(CONFIG, CONFIG)) }
        val names = mutableListOf(CONFIG, "bridgeApps.didChange")
        val client = Client(names)
        names.clear()
        client.commit()
        client.confirm()
        assertEquals(listOf(CONFIG, "bridgeApps.didChange"), client.hello())
    }

    @Test
    fun advertisesOnlyForAConfirmedRouteAndKeepsNetworkOptIn() {
        val client = Client(listOf(CONFIG), network = NetworkEvents { { } })
        assertFalse(client.emit())
        client.commit()
        for (attempt in listOf(
            { client.confirm(origin = "https://other.example.test") },
            { client.confirm(main = false) },
            { client.confirm(proxy = Any()) },
            { client.confirm(challenge = "previous-challenge") },
        )) {
            attempt()
            assertEquals(emptyList<String>(), client.hello())
            assertFalse(client.emit())
        }
        assertEquals("""{"subscribed":[],"denied":["$CONFIG"]}""", client.subscribe().toString())
        client.confirm()
        assertEquals(setOf(CONFIG, "network.statusChanged"), client.hello().toSet())
        assertFalse(client.emit()) // a previously denied subscribe is not retroactive
        assertFalse(client.transport.emit("network.statusChanged", JsonNull.INSTANCE)) // module-owned only
    }

    @Test
    fun partitionsCustomAndNetworkSubscriptionsEvenIfObserverCannotStart() {
        val client = Client(listOf(CONFIG), network = NetworkEvents { null })
        client.start()
        assertEquals(
            """{"subscribed":["$CONFIG"],"denied":["network.statusChanged","acme.app.unregistered"]}""",
            client.subscribe(listOf("network.statusChanged", CONFIG, "acme.app.unregistered")).toString(),
        )
        assertFalse(client.transport.emit("acme.app.unregistered", JsonNull.INSTANCE))
        assertTrue(client.emit())
    }

    @Test
    fun emitsPortablePayloadsAsNotificationsOnlyAfterSubscribeReplyIsPosted() {
        val client = Client(listOf(CONFIG))
        client.start()
        client.onReply = { assertFalse("still posting the acknowledgement", client.emit()) }
        assertEquals("""{"subscribed":["$CONFIG"],"denied":[]}""", client.subscribe().toString())
        client.onReply = null
        val payloads = listOf("null", "true", "1.25", "9007199254740991", "\"组织🚀\"", "[null,1,false]",
            """{"label":"中文😀","values":[true,null,"9007199254740993"]}""")
        for (raw in payloads) {
            assertTrue(client.emit(JsonParser.parseString(raw)))
            assertEquals(obj("""{"jsb":"1.0","meta":{"sid":"${client.sid}"},"rpc":{"jsonrpc":"2.0","method":"bridge.event","params":{"name":"$CONFIG","payload":$raw}}}"""),
                client.notifications.last())
        }
        assertEquals(payloads.size, client.notifications.size)
    }

    @Test
    fun invalidOrOversizePayloadReturnsFalseWithoutPoisoningSubscription() {
        val client = Client(listOf(CONFIG))
        client.start()
        client.subscribe()
        val circular = JsonArray().apply { add(this) }
        val overDepth = (0..253).fold<Int, JsonElement>(JsonNull.INSTANCE) { child, _ -> JsonArray().apply { add(child) } }
        for (value in listOf(circular, overDepth, JsonPrimitive(Double.NaN), JsonPrimitive(Double.POSITIVE_INFINITY),
            JsonPrimitive(9_007_199_254_740_992L), JsonPrimitive("界".repeat(32_768)))) {
            assertFalse(client.emit(value))
        }
        assertTrue(client.notifications.isEmpty())
        assertTrue(client.emit(JsonPrimitive("still subscribed")))
    }

    @Test
    fun duplicateSubscriptionIsIdempotentAndOldAcknowledgementCannotReviveNewSubscription() {
        val delayed = ArrayDeque<() -> Unit>()
        val client = Client(listOf(CONFIG), replies = delayed)
        client.start()
        client.subscribe()
        client.request("bridge.subscribe@1")
        assertTrue(client.emit()) // a duplicate cannot turn a live subscription back into a pending one
        client.request("bridge.unsubscribe")
        assertFalse(client.emit())
        client.request("bridge.subscribe")
        delayed.removeFirst()() // duplicate's receipt refers to the old subscription object
        delayed.removeFirst()() // unsubscribe receipt
        assertFalse(client.emit())
        delayed.removeFirst()()
        assertTrue(client.emit())
        client.unsubscribe()
        assertFalse(client.emit())
        assertEquals(2, client.notifications.size)
    }

    @Test
    fun reconfirmationSuspendsDeliveryUntilMatchingPushWithoutChangingSameDocumentSid() {
        val client = Client(listOf(CONFIG))
        client.start()
        client.subscribe()
        val sid = client.sid
        val previousChallenge = client.challenge
        val firstDelivered = client.notifications
        client.beginCommit()
        assertFalse(client.emit())
        client.completeCommit()
        assertFalse(client.emit())
        client.confirm(challenge = previousChallenge)
        assertFalse(client.emit())
        // A fresh push refreshes the route for the same (token, proxy, sid).
        client.confirm()
        assertEquals(listOf(CONFIG), client.hello())
        assertEquals(sid, client.sid)
        assertTrue(client.emit())
        assertTrue(firstDelivered.isEmpty())
        assertEquals(1, client.notifications.size)
    }

    @Test
    fun replacementDropsOldRouteSubscriptionsAndLateAcksEvenWithSameProxy() {
        val delayed = ArrayDeque<() -> Unit>()
        val client = Client(listOf(CONFIG), replies = delayed)
        client.start()
        client.subscribe()
        client.request("bridge.subscribe") // an acknowledgement still outstanding on the old document
        val oldSid = client.sid
        val oldToken = client.token
        val oldNotifications = client.notifications
        client.commit(token = "b".repeat(32))
        assertFalse(client.emit())
        client.confirm()
        delayed.removeFirst()() // the retired document's receipt
        client.hello()
        assertNotEquals(oldSid, client.sid)
        client.request("bridge.subscribe", sid = oldSid)
        client.request("bridge.subscribe", token = oldToken)
        assertTrue(delayed.isEmpty())
        assertFalse(client.emit())
        client.subscribe()
        client.request("bridge.unsubscribe", sid = oldSid)
        assertTrue(delayed.isEmpty())
        assertTrue(client.emit())
        assertTrue(oldNotifications.isEmpty())
        assertEquals(client.sid, client.notifications.single().getAsJsonObject("meta").get("sid").asString)
        client.transport.invalidate()
        assertFalse(client.emit())
    }

    private class Client(
        events: List<String>,
        network: NetworkEvents? = null,
        private val replies: ArrayDeque<() -> Unit>? = null,
    ) {
        val transport = DocumentTransport(listOf(ORIGIN), enableEcho = false, modules = BridgeModules(networkEvents = network), events = events) {
            if (replies == null) it() else replies.addLast(it)
        }
        val proxy = Any()
        var onReply: (() -> Unit)? = null
        var sid: String? = null
            private set
        var token = "a".repeat(32)
            private set
        lateinit var challenge: String
            private set
        private var nextId = 0
        private val responses = mutableMapOf<String, JsonObject>()
        var notifications = mutableListOf<JsonObject>()
            private set

        fun start() { commit(); confirm(); hello() }
        fun beginCommit(token: String = this.token) {
            this.token = token
            challenge = checkNotNull(transport.onPageCommitVisible(ORIGIN)).nonce
        }
        fun completeCommit() {
            val messages = mutableListOf<String>()
            transport.receive("commit:$challenge:$token", ORIGIN, true, proxy) { messages.add(it) }
            assertEquals(listOf("ready:$challenge:$token"), messages)
        }
        fun commit(token: String = this.token) { beginCommit(token); completeCommit() }

        fun confirm(challenge: String = this.challenge, proxy: Any = this.proxy, origin: String = ORIGIN, main: Boolean = true) {
            val routeToken = token
            val delivered = mutableListOf<JsonObject>()
            notifications = delivered
            transport.receive("push:$challenge:$routeToken", origin, main, proxy) {
                delivered += obj(it.removePrefix("rpc:$routeToken:"))
            }
        }

        fun hello(): List<String> = call("bridge.hello", """{"protocols":[1]}""", sid = null).let {
            sid = it.get("sid").asString
            it.getAsJsonObject("capabilities").getAsJsonArray("events").map(JsonElement::getAsString)
        }

        fun subscribe(names: List<String> = listOf(CONFIG)) =
            call("bridge.subscribe", JsonObject().apply { add("events", JsonArray().apply { names.forEach { add(it) } }) }.toString())

        fun unsubscribe() = call("bridge.unsubscribe", EVENTS)
        fun emit(value: JsonElement = JsonNull.INSTANCE) = transport.emit(CONFIG, value)

        fun request(method: String, params: String = EVENTS, sid: String? = this.sid, token: String = this.token): String {
            val id = "request-${nextId++}"
            val meta = sid?.let { """"meta":{"sid":"$it"},""" }.orEmpty()
            val raw = """{"jsb":"1.0",${meta}"rpc":{"jsonrpc":"2.0","method":"$method","id":"$id","params":$params}}"""
            transport.receive("rpc:$token:$raw", ORIGIN, true, proxy) {
                onReply?.invoke()
                responses[id] = obj(it.removePrefix("rpc:$token:")).getAsJsonObject("rpc")
            }
            return id
        }

        private fun call(method: String, params: String, sid: String? = this.sid): JsonObject {
            val id = request(method, params, sid)
            if (replies != null) replies.removeFirst()()
            return checkNotNull(checkNotNull(responses.remove(id)).getAsJsonObject("result"))
        }
    }

    private companion object {
        const val ORIGIN = "https://app.example.test"
        const val CONFIG = "acme.app.configChanged"
        const val EVENTS = """{"events":["$CONFIG"]}"""
        fun obj(raw: String) = JsonParser.parseString(raw).asJsonObject
    }
}
