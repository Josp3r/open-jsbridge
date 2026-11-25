package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.os.Build
import android.util.Size
import androidx.annotation.RequiresApi
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.IOException
import java.io.OutputStream

internal fun androidMediaThumbnail(file: File): MediaThumbnail =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) imageDecoderThumbnail(file) else bitmapFactoryThumbnail(file)

@RequiresApi(Build.VERSION_CODES.P)
private fun imageDecoderThumbnail(file: File): MediaThumbnail {
    lateinit var originalSize: Size
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
        // ImageDecoder applies encoded orientation to both the header size and decoded pixels.
        originalSize = info.size
        val size = thumbnailSize(originalSize)
        if (size != originalSize) decoder.setTargetSize(size.width, size.height)
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE)
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
    }
    return try {
        encodeThumbnail(bitmap, originalSize)
    } finally {
        bitmap.recycle()
    }
}

private fun bitmapFactoryThumbnail(file: File): MediaThumbnail {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) throw IOException("Could not read image dimensions")

    val mime = bounds.outMimeType
    val exif = if (mime != null && ExifInterface.isSupportedMimeType(mime)) ExifInterface(file) else null
    val rotation = exif?.rotationDegrees ?: 0
    val swapsAxes = rotation == 90 || rotation == 270
    val originalSize = orientedSize(width, height, swapsAxes)

    val longestEdge = maxOf(width, height)
    val options = BitmapFactory.Options().apply {
        inSampleSize = 1
        inScaled = false
        inPreferredConfig = Bitmap.Config.ARGB_8888
        // Leave the sampled long edge between 256 and 512 pixels when downscaling.
        while (longestEdge / inSampleSize >= 2 * MediaThumbnail.MAX_EDGE) inSampleSize *= 2
    }
    val sampled = BitmapFactory.decodeFile(file.path, options) ?: throw IOException("Thumbnail decoding failed")
    try {
        val oriented = orientedSize(sampled.width, sampled.height, swapsAxes)
        val target = thumbnailSize(oriented)
        val transform = Matrix().apply {
            // ExifInterface describes rotation after a horizontal flip.
            if (exif?.isFlipped == true) setScale(-1f, 1f)
            if (rotation != 0) postRotate(rotation.toFloat())
            if (target != oriented) postScale(target.width.toFloat() / oriented.width, target.height.toFloat() / oriented.height)
        }
        val thumbnail = if (transform.isIdentity) sampled else
            Bitmap.createBitmap(sampled, 0, 0, sampled.width, sampled.height, transform, true)
        return try {
            encodeThumbnail(thumbnail, originalSize)
        } finally {
            if (thumbnail !== sampled) thumbnail.recycle()
        }
    } finally {
        sampled.recycle()
    }
}

private fun orientedSize(width: Int, height: Int, swapsAxes: Boolean): Size =
    if (swapsAxes) Size(height, width) else Size(width, height)

private fun thumbnailSize(originalSize: Size): Size {
    val longestEdge = maxOf(originalSize.width, originalSize.height)
    if (longestEdge <= MediaThumbnail.MAX_EDGE) return originalSize
    val width = (originalSize.width.toLong() * MediaThumbnail.MAX_EDGE / longestEdge).toInt()
    val height = (originalSize.height.toLong() * MediaThumbnail.MAX_EDGE / longestEdge).toInt()
    return Size(width.coerceAtLeast(1), height.coerceAtLeast(1))
}

private fun encodeThumbnail(bitmap: Bitmap, originalSize: Size): MediaThumbnail {
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
