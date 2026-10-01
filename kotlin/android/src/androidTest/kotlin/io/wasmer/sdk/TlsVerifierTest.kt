package io.wasmer.sdk

import androidx.test.platform.app.InstrumentationRegistry
import java.net.URL
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import org.junit.Assume.assumeTrue
import org.junit.Test
import kotlin.test.assertEquals

/** Exercise the production verifier, including the no-OCSP compatibility fix. */
class TlsVerifierTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun untrusted() = instrumentation.context.assets.open("untrusted.der").use { it.readBytes() }

    private fun verify(chain: Array<ByteArray>, time: Long = System.currentTimeMillis(), staple: ByteArray? = null): Int {
        val method = Class.forName("org.rustls.platformverifier.CertificateVerifier")
            .declaredMethods.single { it.name == "verifyCertificateChain" }.apply { isAccessible = true }
        val result = method.invoke(null, instrumentation.targetContext, "cdn.wasmer.io", "RSA",
            arrayOf("1.3.6.1.5.5.7.3.1"), staple, time, chain)
        return result.javaClass.getDeclaredField("code").apply { isAccessible = true }.getInt(result)
    }

    @Test fun rejectsUntrustedCertificate() {
        val bytes = untrusted()
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(bytes.inputStream()) as X509Certificate
        assertEquals(3, verify(arrayOf(bytes), cert.notBefore.time + 1000))
    }

    @Test fun rejectsExpiredCertificate() {
        val bytes = untrusted()
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(bytes.inputStream()) as X509Certificate
        assertEquals(2, verify(arrayOf(bytes), cert.notAfter.time + 1000))
    }

    @Test fun rejectsMalformedCertificate() {
        assertEquals(5, verify(arrayOf(byteArrayOf(1, 2, 3))))
    }

    @Test fun acceptsPublicCdnWithoutOcsp() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("integration") == "true")
        val connection = URL("https://cdn.wasmer.io/").openConnection() as HttpsURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        try {
            connection.connect()
            val chain = connection.serverCertificates.map { it.encoded }.toTypedArray()
            assertEquals(0, verify(chain))
        } finally { connection.disconnect() }
    }
}
