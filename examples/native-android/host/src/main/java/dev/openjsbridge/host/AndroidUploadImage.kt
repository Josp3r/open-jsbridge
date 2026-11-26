package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.PorterDuff
import android.media.MediaMetadataRetriever
import android.os.Build
import java.io.DataInputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile

private const val MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024

/** Run on a worker with a resolved session image and an existing private output directory.
 * The caller owns the returned JPEG and must delete it when the upload finishes or is cancelled.
 */
internal object AndroidUploadImage {
    fun prepare(
        source: File,
        outputDirectory: File,
        maxEdge: Int = 2048,
        quality: Int = 80,
        checkCancelled: () -> Unit = {},
    ): File {
        checkCancelled()
        if (maxEdge !in 1..4096 || quality !in 1..100) throw MediaFailure(-32602, "Invalid compression parameters")
        if (source.length() > MAX_UPLOAD_IMAGE_BYTES) throw MediaFailure(-32006, "Payload too large")
        val pixels = try {
            decodeUploadPixels(source, maxEdge)
        } catch (_: IOException) {
            throw MediaFailure(-32602, "unsupported_image")
        } catch (_: IllegalArgumentException) {
            throw MediaFailure(-32602, "unsupported_image")
        }
        try {
            checkCancelled()
            if (pixels.hasAlpha()) {
                Canvas(pixels).drawColor(Color.WHITE, PorterDuff.Mode.DST_OVER)
                pixels.setHasAlpha(false)
            }
            return writeUploadJpeg(outputDirectory, checkCancelled) { stream ->
                pixels.compress(Bitmap.CompressFormat.JPEG, quality, stream)
            }
        } catch (_: IOException) {
            throw MediaFailure(-32603, "JPEG encoding failed")
        } finally {
            pixels.recycle()
        }
    }
}

internal fun writeUploadJpeg(directory: File, checkCancelled: () -> Unit, encode: (OutputStream) -> Boolean): File {
    checkCancelled()
    val file = File.createTempFile("ojsb-upload-", ".jpg", directory)
    var complete = false
    try {
        file.outputStream().use { output ->
            val stream = UploadJpegStream(output, checkCancelled)
            val encoded = try {
                encode(stream)
            } finally {
                // Some native encoders turn an exception from OutputStream into a false return.
                stream.failure?.let { throw it }
            }
            checkCancelled()
            if (!encoded || stream.written == 0) throw MediaFailure(-32603, "JPEG encoding failed")
        }
        complete = true
        return file
    } finally {
        if (!complete) file.delete()
    }
}

private class UploadJpegStream(private val output: OutputStream, private val checkCancelled: () -> Unit) : OutputStream() {
    var failure: Exception? = null
        private set
    var written = 0
        private set

    override fun write(value: Int) = writeChecked(1) { output.write(value) }

    override fun write(bytes: ByteArray, offset: Int, length: Int) =
        writeChecked(length) { output.write(bytes, offset, length) }

    private inline fun writeChecked(length: Int, write: () -> Unit) {
        failure?.let { throw it }
        try {
            checkCancelled()
            if (length > MAX_UPLOAD_IMAGE_BYTES - written) throw MediaFailure(-32006, "Payload too large")
            write()
            written += length
        } catch (error: Exception) {
            failure = error
            throw error
        }
    }
}

/** Container framing only. The platform decoder still validates and decodes the pixels. */
internal fun requireStaticUploadImage(source: File, mime: String?) {
    when (mime) {
        "image/jpeg" -> requireCompleteJpeg(source)
        "image/bmp", "image/x-ms-bmp" -> RandomAccessFile(source, "r").use { bmp ->
            if (bmp.readUnsignedShort() != 0x424d) invalidUploadImage() // BM, not a bitmap array.
            val size = Integer.reverseBytes(bmp.readInt()).toLong() and 0xffff_ffffL
            bmp.readInt() // Reserved fields.
            val pixels = Integer.reverseBytes(bmp.readInt()).toLong() and 0xffff_ffffL
            if (pixels !in 14L until size || size > bmp.length()) invalidUploadImage()
        }
        "image/png" -> RandomAccessFile(source, "r").use(::requireStaticPng)
        "image/webp" -> RandomAccessFile(source, "r").use(::requireStaticWebP)
        "image/gif" -> RandomAccessFile(source, "r").use(::requireStaticGif)
        "image/heif", "image/heic", "image/avif" -> {
            if (Build.VERSION.SDK_INT < 28) invalidUploadImage()
            val metadata = MediaMetadataRetriever()
            try {
                source.inputStream().use { metadata.setDataSource(it.fd) }
                if (metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_IMAGE_COUNT) != "1" ||
                    metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes") invalidUploadImage()
            } catch (error: RuntimeException) {
                throw IOException("Could not inspect image collection", error)
            } finally {
                metadata.release()
            }
        }
        else -> invalidUploadImage()
    }
}

private fun invalidUploadImage(): Nothing = throw IOException("Unsupported or incomplete image")

private fun requireCompleteJpeg(source: File) {
    DataInputStream(source.inputStream().buffered()).use { input ->
        val hasPictureIndex = readJpeg(input, 0xe2..0xe2) { _, header -> header.startsWith("MPF\u0000") }
        if (hasPictureIndex) {
            // Ultra HDR uses MPF for a base image and one auxiliary JPEG gainmap. Other
            // indexed collections, including stereo MPO, are outside the single-photo contract.
            val hasGainmap = readJpeg(input, 0xe1..0xe2) { marker, header ->
                when (marker) {
                    0xe1 -> header.startsWith("http://ns.adobe.com/xap/1.0/\u0000") &&
                        header.contains("http://ns.adobe.com/hdr-gain-map/1.0/")
                    else -> {
                        val identifier = "urn:iso:std:iso:ts:21496:-1\u0000"
                        // A base image can carry just the two 16-bit version fields.
                        header.startsWith(identifier) && header.length > identifier.length + 4
                    }
                }
            }
            if (!hasGainmap || input.read() != -1) invalidUploadImage()
        }
    }
}

/** Consume one complete JPEG and identify its role from the selected APP headers. */
private inline fun readJpeg(
    input: DataInputStream,
    appMarkers: IntRange,
    matches: (Int, String) -> Boolean,
): Boolean {
    if (input.readUnsignedShort() != 0xffd8) invalidUploadImage()
    var inScan = false
    var sawScan = false
    var matched = false
    while (true) {
        var prefix = input.readUnsignedByte()
        if (inScan) while (prefix != 0xff) prefix = input.readUnsignedByte()
        if (prefix != 0xff) invalidUploadImage()
        var marker = input.readUnsignedByte()
        while (marker == 0xff) marker = input.readUnsignedByte()
        when (marker) {
            0xd9 -> if (sawScan) return matched else invalidUploadImage()
            0xd8 -> invalidUploadImage()
            0x00, in 0xd0..0xd7 -> if (!inScan) invalidUploadImage() // Stuffed byte or restart.
            0x01 -> Unit // Standalone TEM marker.
            else -> {
                val payload = input.readUnsignedShort() - 2
                if (payload < 0) invalidUploadImage()
                if (!matched && marker in appMarkers) {
                    val header = String(ByteArray(payload).also(input::readFully), Charsets.ISO_8859_1)
                    matched = matches(marker, header)
                } else if (input.skipBytes(payload) != payload) invalidUploadImage()
                inScan = marker == 0xda || (inScan && marker == 0xdc)
                if (marker == 0xda) sawScan = true
            }
        }
    }
}

private fun RandomAccessFile.fourCC(): String =
    String(ByteArray(4).also(::readFully), Charsets.US_ASCII)

private fun RandomAccessFile.skipWithin(bytes: Long, end: Long) {
    if (bytes < 0 || bytes > end - filePointer) invalidUploadImage()
    seek(filePointer + bytes)
}

private fun requireStaticPng(input: RandomAccessFile) = with(input) {
    val end = length()
    seek(8) // The platform identified the PNG signature.
    var sawData = false
    while (filePointer < end) {
        val size = readInt().toLong() and 0xffff_ffffL
        val type = fourCC()
        if (type == "acTL" || type == "fcTL" || type == "fdAT") invalidUploadImage()
        skipWithin(size + 4, end) // Payload and CRC.
        if (type == "IDAT") sawData = true
        if (type == "IEND") {
            if (!sawData || size != 0L) invalidUploadImage()
            return@with
        }
    }
    invalidUploadImage()
}

private fun requireStaticWebP(input: RandomAccessFile) = with(input) {
    if (fourCC() != "RIFF") invalidUploadImage()
    val end = 8 + (Integer.reverseBytes(readInt()).toLong() and 0xffff_ffffL)
    if (end > length() || fourCC() != "WEBP") invalidUploadImage()
    var images = 0
    while (filePointer < end) {
        val type = fourCC()
        val size = Integer.reverseBytes(readInt()).toLong() and 0xffff_ffffL
        if (type == "ANIM" || type == "ANMF") invalidUploadImage()
        if (type == "VP8 " || type == "VP8L") images++
        if (type == "VP8X") {
            if (size != 10L || readUnsignedByte() and 2 != 0) invalidUploadImage()
            skipWithin(size - 1, end)
        } else {
            skipWithin(size + size % 2, end) // RIFF chunks are word-aligned.
        }
    }
    if (images != 1) invalidUploadImage()
}

private fun requireStaticGif(input: RandomAccessFile) = with(input) {
    val end = length()
    fun colorTable(flags: Int) {
        if (flags and 0x80 != 0) skipWithin(6L shl (flags and 7), end)
    }
    seek(10) // Skip signature, version and logical dimensions.
    val screenFlags = readUnsignedByte()
    skipWithin(2, end)
    colorTable(screenFlags)
    var sawFrame = false
    while (true) {
        when (readUnsignedByte()) {
            0x3b -> if (sawFrame) return@with else invalidUploadImage()
            0x21 -> readUnsignedByte() // Extension label, then data sub-blocks.
            0x2c -> {
                if (sawFrame) invalidUploadImage()
                sawFrame = true
                skipWithin(8, end)
                colorTable(readUnsignedByte())
                readUnsignedByte() // LZW minimum code size.
            }
            else -> invalidUploadImage()
        }
        var block = readUnsignedByte()
        while (block != 0) {
            skipWithin(block.toLong(), end)
            block = readUnsignedByte()
        }
    }
}
