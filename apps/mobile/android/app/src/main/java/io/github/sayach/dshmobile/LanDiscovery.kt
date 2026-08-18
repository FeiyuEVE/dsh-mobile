package io.github.sayach.dshmobile

import android.content.Context
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal data class DiscoveredHarness(
    val deviceName: String,
    val origin: GatewayOrigin,
    val instanceId: String,
)

private data class LocalSubnet(val first: Int, val second: Int, val third: Int, val ownHosts: Set<Int>)

/** Concurrent passive NSD/UDP discovery with active UDP and HTTPS compatibility fallbacks. */
internal object LanDiscovery {
    fun scan(context: Context, port: Int = 3443, canceled: AtomicBoolean? = null): List<DiscoveredHarness> {
        if (canceled?.get() == true) return emptyList()
        val subnets = localSubnets()
        val discoveryExecutor = Executors.newFixedThreadPool(2)
        val discovered = try {
            discoveryExecutor.invokeAll(
                listOf(
                    Callable { udpDiscovery(port, subnets, canceled) },
                    Callable { NsdDiscovery.scan(context, PASSIVE_TIMEOUT_MS, canceled) },
                ),
                PASSIVE_TIMEOUT_MS + 1_000,
                TimeUnit.MILLISECONDS,
            ).flatMap { future ->
                if (future.isCancelled) emptyList() else runCatching { future.get() }.getOrDefault(emptyList())
            }
        } finally {
            discoveryExecutor.shutdownNow()
        }
        if (discovered.isNotEmpty()) return mergeByInstance(discovered)
        if (subnets.isEmpty()) return emptyList()

        val probeExecutor = Executors.newFixedThreadPool(32)
        return try {
            val tasks = subnets.flatMap { subnet ->
                (1..254).filter { it !in subnet.ownHosts }.map { host ->
                    Callable {
                        if (canceled?.get() == true) null
                        else probe("${subnet.first}.${subnet.second}.${subnet.third}.$host", port)
                    }
                }
            }
            mergeByInstance(probeExecutor.invokeAll(tasks, 12, TimeUnit.SECONDS).mapNotNull { future ->
                if (future.isCancelled) null else runCatching { future.get() }.getOrNull()
            })
        } finally {
            probeExecutor.shutdownNow()
        }
    }

    private fun mergeByInstance(found: List<DiscoveredHarness>): List<DiscoveredHarness> =
        found.fold(linkedMapOf<String, DiscoveredHarness>()) { entries, harness ->
            entries.putIfAbsent(harness.instanceId, harness)
            entries
        }.values.toList()

    private fun udpDiscovery(port: Int, subnets: List<LocalSubnet>, canceled: AtomicBoolean? = null): List<DiscoveredHarness> {
        val targets = buildSet {
            add("255.255.255.255")
            add("192.168.43.255")
            add("192.168.223.255")
            add("192.168.232.255")
            add("172.20.10.255")
            subnets.forEach { add("${it.first}.${it.second}.${it.third}.255") }
        }
        return runCatching {
            DatagramSocket(null).use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(port))
                socket.broadcast = true
                val query = DISCOVERY_QUERY.toByteArray(Charsets.US_ASCII)
                targets.forEach { target ->
                    socket.send(DatagramPacket(query, query.size, InetAddress.getByName(target), port))
                }
                val deadline = System.currentTimeMillis() + PASSIVE_TIMEOUT_MS
                val found = mutableListOf<DiscoveredHarness>()
                while (System.currentTimeMillis() < deadline && canceled?.get() != true) {
                    socket.soTimeout = (deadline - System.currentTimeMillis()).coerceIn(1, 400).toInt()
                    val buffer = ByteArray(1_024)
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        socket.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        continue
                    }
                    parseAnnouncement(String(packet.data, 0, packet.length, Charsets.UTF_8), packet.address.hostAddress)
                        ?.let(found::add)
                }
                mergeByInstance(found)
            }
        }.getOrDefault(emptyList())
    }

    internal fun parseAnnouncement(source: String, remoteAddress: String?): DiscoveredHarness? = runCatching {
        val body = JSONObject(source)
        if (body.length() != 5 || body.optInt("protocol") != PROTOCOL) return@runCatching null
        val instanceId = body.optString("instanceId")
        if (!INSTANCE_ID.matches(instanceId)) return@runCatching null
        val deviceName = body.optString("deviceName").takeIf { it.isNotBlank() && it.length <= 63 }
            ?: return@runCatching null
        val origin = GatewayOrigin.parse(body.optString("origin")) ?: return@runCatching null
        if (body.optInt("port") != origin.port || remoteAddress == null || origin.host != remoteAddress) {
            return@runCatching null
        }
        DiscoveredHarness(deviceName, origin, instanceId)
    }.getOrNull()

    private fun localSubnets(): List<LocalSubnet> {
        val addresses = runCatching {
            Collections.list(NetworkInterface.getNetworkInterfaces()).asSequence()
                .filter { network -> runCatching { network.isUp && !network.isLoopback }.getOrDefault(false) }
                .flatMap { network -> Collections.list(network.inetAddresses).asSequence() }
                .filterIsInstance<Inet4Address>()
                .filter(::isPrivateLanAddress)
                .toList()
        }.getOrDefault(emptyList())
        return addresses.groupBy { address ->
            val bytes = address.address
            Triple(unsigned(bytes[0]), unsigned(bytes[1]), unsigned(bytes[2]))
        }.entries.take(MAX_SUBNETS).map { (prefix, members) ->
            LocalSubnet(prefix.first, prefix.second, prefix.third, members.map { unsigned(it.address[3]) }.toSet())
        }
    }

    private fun isPrivateLanAddress(address: Inet4Address): Boolean {
        if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isMulticastAddress) return false
        if (address.isSiteLocalAddress) return true
        val bytes = address.address
        return unsigned(bytes[0]) == 100 && unsigned(bytes[1]) in 64..127
    }

    private fun unsigned(value: Byte): Int = value.toInt().and(0xff)

    private fun probe(host: String, port: Int): DiscoveredHarness? {
        val origin = GatewayOrigin.parse("https://$host:$port") ?: return null
        return runCatching {
            val body = NativeAuthClient.fetchDiscovery(origin)
            if (body.length() != 5 || body.optInt("protocol") != PROTOCOL) return null
            val instanceId = body.optString("instanceId")
            val deviceName = body.optString("deviceName")
            val advertisedOrigin = GatewayOrigin.parse(body.optString("origin")) ?: return null
            if (!INSTANCE_ID.matches(instanceId) || deviceName.isBlank() || deviceName.length > 63
                || advertisedOrigin != origin || body.optInt("port") != origin.port) return null
            DiscoveredHarness(deviceName, origin, instanceId)
        }.getOrNull()
    }

    private const val MAX_SUBNETS = 4
    private const val PASSIVE_TIMEOUT_MS = 3_000L
    private const val PROTOCOL = 1
    private const val DISCOVERY_QUERY = "DSH_MOBILE_DISCOVER_V1"
    internal val INSTANCE_ID = Regex("^[a-f0-9]{64}$")
}
