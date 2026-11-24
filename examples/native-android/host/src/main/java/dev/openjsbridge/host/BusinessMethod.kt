package dev.openjsbridge.host

import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject

/**
 * A version 1 application-owned method with a qualified name such as `acme.app.getConfig`.
 * The handler receives a JSON object and returns a JSON value. Use [JsonNull.INSTANCE] for JSON null.
 */
class BusinessMethod(
    internal val name: String,
    internal val handler: suspend (JsonObject) -> JsonElement,
) {
    init {
        require(isQualifiedBusinessName(name)) {
            "Expected an unversioned qualified business method name outside reserved namespaces"
        }
    }
}

/** Throw from a [BusinessMethod] handler to signal invalid method parameters. */
class InvalidBusinessParamsException : IllegalArgumentException()

internal fun List<BusinessMethod>.indexBusinessMethods(): Map<String, BusinessMethod> =
    associateBy(BusinessMethod::name).also {
        require(it.size == size) { "Duplicate business method names" }
    }

internal fun List<String>.indexBusinessEvents(): Set<String> = toSet().also { names ->
    require(names.size == size) { "Duplicate business event names" }
    require(names.all(::isQualifiedBusinessName)) {
        "Expected unversioned qualified business event names outside reserved namespaces"
    }
}

private val RESERVED_NAMESPACES = setOf(
    "bridge", "conformance", "ojsb", "rpc", "device", "app", "ui", "storage", "network", "media",
)

private fun isQualifiedBusinessName(name: String): Boolean =
    name.substringBefore('.') !in RESERVED_NAMESPACES && isQualifiedBaseName(name)

private val METHOD_SEGMENT = Regex("[a-z][a-zA-Z0-9]*")

internal fun isQualifiedBaseName(name: String): Boolean =
    !name.startsWith("rpc.") && '.' in name && name.split('.').all(METHOD_SEGMENT::matches)
