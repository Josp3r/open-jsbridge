package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.os.Build
import android.util.Size
import java.io.File
import java.io.IOException
import java.io.OutputStream

internal fun androidMediaThumbnail(file: File): MediaThumbnail {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) throw IOException("Thumbnail decoding unavailable")

    lateinit var originalSize: Size
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
        // ImageDecoder applies encoded orientation to both the header size and decoded pixels.
        originalSize = info.size
        val longestEdge = maxOf(originalSize.width, originalSize.height)
        if (longestEdge > MediaThumbnail.MAX_EDGE) {
            val width = (originalSize.width.toLong() * MediaThumbnail.MAX_EDGE / longestEdge).toInt()
            val height = (originalSize.height.toLong() * MediaThumbnail.MAX_EDGE / longestEdge).toInt()
            decoder.setTargetSize(width.coerceAtLeast(1), height.coerceAtLeast(1))
        }
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE)
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
    }

    try {
        val output = ThumbnailJpegOutput()
        for (quality in JPEG_QUALITIES) {
            output.reset()
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
                throw IOException("Thumbnail encoding failed")
            }
            val jpeg = output.bytesWithinLimit() ?: continue
            return MediaThumbnail(originalSize.width, originalSize.height, jpeg)
        }
        throw IOException("Thumbnail exceeds the JPEG byte limit")
    } finally {
        bitmap.recycle()
    }
}

private val JPEG_QUALITIES = intArrayOf(90, 75, 60, 45, 30)

private class ThumbnailJpegOutput : OutputStream() {
    // One extra byte distinguishes a full but valid JPEG from a truncated one.
    private val buffer = ByteArray(MediaThumbnail.MAX_BYTES + 1)
    private var size = 0

    override fun write(value: Int) {
        if (size < buffer.size) buffer[size++] = value.toByte()
    }

    override fun write(source: ByteArray, offset: Int, length: Int) {
        val count = minOf(length, buffer.size - size)
        source.copyInto(buffer, size, offset, offset + count)
        size += count
    }

    fun reset() {
        size = 0
    }

    fun bytesWithinLimit(): ByteArray? =
        if (size in 1..MediaThumbnail.MAX_BYTES) buffer.copyOf(size) else null
}
