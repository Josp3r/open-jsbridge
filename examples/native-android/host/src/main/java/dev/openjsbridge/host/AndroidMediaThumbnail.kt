package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.util.Size
import androidx.annotation.RequiresApi
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.IOException
import java.io.OutputStream

private data class DecodedPixels(val bitmap: Bitmap, val originalSize: Size)

internal fun androidMediaThumbnail(file: File): MediaThumbnail {
    val decoded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        imageDecoderPixels(file, MediaThumbnail.MAX_EDGE, forUpload = false)
    } else {
        bitmapFactoryPixels(file, MediaThumbnail.MAX_EDGE, forUpload = false)
    }
    return try {
        encodeThumbnail(decoded.bitmap, decoded.originalSize)
    } finally {
        decoded.bitmap.recycle()
    }
}

/** The caller owns the returned mutable, oriented software bitmap. */
internal fun decodeUploadPixels(file: File, maxEdge: Int): Bitmap {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return decodeLegacyUploadPixels(file, maxEdge)
    require(maxEdge in 1..4096)
    return imageDecoderPixels(file, maxEdge, forUpload = true).bitmap
}

internal fun decodeLegacyUploadPixels(file: File, maxEdge: Int): Bitmap {
    require(maxEdge in 1..4096)
    return bitmapFactoryPixels(file, maxEdge, forUpload = true).bitmap
}

@RequiresApi(Build.VERSION_CODES.P)
private fun imageDecoderPixels(file: File, maxEdge: Int, forUpload: Boolean): DecodedPixels {
    lateinit var originalSize: Size
    val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
        if (forUpload) {
            if (info.isAnimated) throw IOException("Expected a static image")
            requireStaticUploadImage(file, info.mimeType)
        }
        // ImageDecoder applies encoded orientation to both the header size and decoded pixels.
        originalSize = info.size
        val size = boundedSize(originalSize, maxEdge)
        if (size != originalSize) decoder.setTargetSize(size.width, size.height)
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE)
        decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
        if (forUpload) {
            decoder.setMutableRequired(true)
            decoder.setOnPartialImageListener { false }
        }
    }
    if (forUpload && Build.VERSION.SDK_INT >= 34 && bitmap.hasGainmap()) {
        // Bitmap.compress can otherwise emit the source's auxiliary HDR image in the JPEG.
        bitmap.setGainmap(null)
    }
    return DecodedPixels(bitmap, originalSize)
}

private fun bitmapFactoryPixels(file: File, maxEdge: Int, forUpload: Boolean): DecodedPixels {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) throw IOException("Could not read image dimensions")

    val mime = bounds.outMimeType
    if (forUpload) requireStaticUploadImage(file, mime)
    val exif = if (mime != null && ExifInterface.isSupportedMimeType(mime)) ExifInterface(file) else null
    val rotation = exif?.rotationDegrees ?: 0
    val flipped = exif?.isFlipped == true
    val swapsAxes = rotation == 90 || rotation == 270
    val originalSize = orientedSize(width, height, swapsAxes)
    val target = boundedSize(originalSize, maxEdge)
    val longestEdge = maxOf(width, height)
    val options = BitmapFactory.Options().apply {
        inScaled = false
        inPreferredConfig = Bitmap.Config.ARGB_8888
        inMutable = forUpload
        if (forUpload && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
        }
        inSampleSize = 1
        while (longestEdge / inSampleSize >= 2 * maxEdge) inSampleSize *= 2
    }
    // Preserve the highest power-of-two sample that still covers the target. For large
    // transforms, draw strips into the final bitmap instead of allocating a near-2x source.
    val sampledPixels = sampledPixelCount(width, height, options.inSampleSize)
    if (forUpload && (target != originalSize || flipped || rotation != 0) && sampledPixels > 6L * 1024 * 1024) {
        if (mime == "image/jpeg" || mime == "image/png" || mime == "image/webp") {
            val transform = pixelTransform(width, height, rotation, flipped, target)
            return DecodedPixels(decodeStrips(file, options, target, transform), originalSize)
        }
        // Codecs without region decoding trade some detail for a bounded intermediate
        // only when downsizing a source that would still occupy more than 4096² pixels.
        if (target != originalSize && sampledPixels > 4096L * 4096) options.inSampleSize *= 2
    }
    val sampled = BitmapFactory.decodeFile(file.path, options) ?: throw IOException("Image decoding failed")
    var result: Bitmap? = null
    try {
        val oriented = orientedSize(sampled.width, sampled.height, swapsAxes)
        // Thumbnail dimensions historically follow the decoder's sample rounding.
        val size = if (forUpload) target else boundedSize(oriented, maxEdge)
        val transform = pixelTransform(sampled.width, sampled.height, rotation, flipped, size)
        result = if (transform.isIdentity) sampled else
            Bitmap.createBitmap(sampled, 0, 0, sampled.width, sampled.height, transform, true)
        return DecodedPixels(result, originalSize)
    } finally {
        if (result !== sampled) sampled.recycle()
    }
}

private fun pixelTransform(width: Int, height: Int, rotation: Int, flipped: Boolean, target: Size): Matrix =
    Matrix().apply {
        // ExifInterface describes rotation after a horizontal flip.
        if (flipped) setScale(-1f, 1f)
        if (rotation != 0) postRotate(rotation.toFloat())
        val bounds = RectF(0f, 0f, width.toFloat(), height.toFloat())
        mapRect(bounds)
        postTranslate(-bounds.left, -bounds.top)
        postScale(target.width / bounds.width(), target.height / bounds.height())
    }

@Suppress("DEPRECATION") // The pre-API 31 overload is required on API 24–27.
private fun decodeStrips(file: File, options: BitmapFactory.Options, target: Size, transform: Matrix): Bitmap {
    val decoder = BitmapRegionDecoder.newInstance(file.path, false) ?: throw IOException("Image decoding failed")
    try {
        val result = Bitmap.createBitmap(target.width, target.height, Bitmap.Config.ARGB_8888)
        try {
            val canvas = Canvas(result)
            canvas.concat(transform)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            val sample = options.inSampleSize
            val sampledWidth = (decoder.width.toLong() + sample - 1) / sample
            // About 2 million sampled pixels per strip, plus one row on each side for filtering.
            val stride = (2L * 1024 * 1024 / sampledWidth * sample).coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
            var top = 0
            while (top < decoder.height) {
                val bottom = top + minOf(stride, decoder.height - top)
                val region = Rect(0, maxOf(0, top - sample), decoder.width, bottom + minOf(sample, decoder.height - bottom))
                val strip = decoder.decodeRegion(region, options) ?: throw IOException("Image decoding failed")
                try {
                    canvas.save()
                    canvas.clipRect(0, top, decoder.width, bottom)
                    canvas.drawBitmap(strip, null, region, paint)
                    canvas.restore()
                } finally {
                    strip.recycle()
                }
                top = bottom
            }
            return result
        } catch (error: Throwable) {
            result.recycle()
            throw error
        }
    } finally {
        decoder.recycle()
    }
}

private fun sampledPixelCount(width: Int, height: Int, sample: Int): Long =
    ((width.toLong() + sample - 1) / sample) * ((height.toLong() + sample - 1) / sample)

private fun orientedSize(width: Int, height: Int, swapsAxes: Boolean): Size =
    if (swapsAxes) Size(height, width) else Size(width, height)

private fun boundedSize(originalSize: Size, maxEdge: Int): Size {
    val longestEdge = maxOf(originalSize.width, originalSize.height)
    if (longestEdge <= maxEdge) return originalSize
    val width = (originalSize.width.toLong() * maxEdge / longestEdge).toInt()
    val height = (originalSize.height.toLong() * maxEdge / longestEdge).toInt()
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
