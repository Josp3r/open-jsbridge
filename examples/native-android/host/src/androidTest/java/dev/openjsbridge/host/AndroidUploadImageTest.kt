package dev.openjsbridge.host

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageDecoder
import android.os.Build
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class AndroidUploadImageTest {
    @get:Rule val temporary = TemporaryFolder(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)

    @Test fun rotatesAndMirrorsPixelsBeforeScalingAndDropsSourceMetadata() {
        val output = temporary.newFolder()
        val red = Color.RED
        val green = Color.GREEN
        val blue = Color.BLUE
        val yellow = Color.YELLOW
        val corners = listOf(
            listOf(red, green, blue, yellow), listOf(green, red, yellow, blue),
            listOf(yellow, blue, green, red), listOf(blue, yellow, red, green),
            listOf(red, blue, green, yellow), listOf(blue, red, yellow, green),
            listOf(yellow, green, blue, red), listOf(green, yellow, red, blue),
        )
        val source = image(96, 64, Bitmap.CompressFormat.JPEG) { x, y ->
            corners.first()[(if (y < 32) 0 else 2) + (if (x < 48) 0 else 1)]
        }
        for ((index, expected) in corners.withIndex()) {
            val orientation = index + 1
            ExifInterface(source).apply {
                setAttribute(ExifInterface.TAG_ORIENTATION, orientation.toString())
                setAttribute(ExifInterface.TAG_MODEL, "Private camera")
                setLatLong(12.5, -97.25)
                saveAttributes()
            }
            assertNotNull(ExifInterface(source).latLong)
            val result = AndroidUploadImage.prepare(source, output, maxEdge = 48)
            val jpeg = decodeJPEG(result)
            assertEquals(if (orientation <= 4) 48 else 32, jpeg.width)
            assertEquals(if (orientation <= 4) 32 else 48, jpeg.height)
            for ((corner, color) in expected.withIndex()) {
                val x = (corner % 2 * 2 + 1) * jpeg.width / 4
                val y = (corner / 2 * 2 + 1) * jpeg.height / 4
                assertColor(color, jpeg.getPixel(x, y), "orientation $orientation, corner $corner")
            }
            jpeg.recycle()
            val metadata = ExifInterface(result)
            val storedOrientation = metadata.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_UNDEFINED)
            assertTrue(storedOrientation == ExifInterface.ORIENTATION_UNDEFINED || storedOrientation == ExifInterface.ORIENTATION_NORMAL)
            assertNull(metadata.latLong)
            assertNull(metadata.getAttribute(ExifInterface.TAG_MODEL))
            assertTrue(result.delete())
        }
    }

    @Test fun compositesPngOnWhiteWithoutUpscalingAndGivesCallerSeparateFiles() {
        val output = temporary.newFolder()
        val source = image(96, 32, Bitmap.CompressFormat.PNG) { x, _ ->
            when (x) {
                in 0..31 -> Color.TRANSPARENT
                in 32..63 -> Color.argb(128, 255, 0, 0)
                else -> Color.BLUE
            }
        }
        val original = source.readBytes()
        val first = AndroidUploadImage.prepare(source, output)
        val second = AndroidUploadImage.prepare(source, output)
        assertNotEquals(first, second)
        assertEquals(setOf(first, second), output.listFiles()!!.toSet())
        assertTrue(first.delete())
        val jpeg = decodeJPEG(second)
        assertEquals(96, jpeg.width)
        assertEquals(32, jpeg.height)
        assertColor(Color.WHITE, jpeg.getPixel(16, 16))
        val pink = jpeg.getPixel(48, 16)
        assertTrue(Color.red(pink) >= 240 && Color.green(pink) in 110..200)
        assertTrue(abs(Color.green(pink) - Color.blue(pink)) < 16)
        assertColor(Color.BLUE, jpeg.getPixel(80, 16))
        jpeg.recycle()
        assertTrue(second.delete())
        assertArrayEquals(original, source.readBytes())
    }

    @Test fun defaultLongEdgeAndMinimumEdgeKeepNonzeroDimensions() {
        val source = image(3072, 48, Bitmap.CompressFormat.PNG) { _, _ -> Color.GREEN }
        val output = temporary.newFolder()
        val normal = decodeJPEG(AndroidUploadImage.prepare(source, output))
        assertEquals(2048, normal.width)
        assertEquals(32, normal.height)
        normal.recycle()
        val smallest = decodeJPEG(AndroidUploadImage.prepare(source, output, maxEdge = 1))
        assertEquals(1, smallest.width)
        assertEquals(1, smallest.height)
        smallest.recycle()
    }

    @Test fun legacyDecoderPreservesSinglePixelStripesWhenMirroringASixMegapixelImage() {
        val width = 3072
        val height = 2056
        val source = temporary.newFile("stripes.png")
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
        try {
            bitmap.eraseColor(Color.WHITE)
            val stripes = IntArray(32 * 16) { if (it % 2 == 0) Color.BLACK else Color.WHITE }
            bitmap.setPixels(stripes, 0, 32, 100, height / 2 - 8, 32, 16)
            source.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        } finally {
            bitmap.recycle()
        }
        ExifInterface(source).apply {
            setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_FLIP_HORIZONTAL.toString())
            saveAttributes()
        }

        val mirrored = decodeLegacyUploadPixels(source, maxEdge = 4096)
        try {
            assertEquals(width, mirrored.width)
            assertEquals(height, mirrored.height)
            for (sourceX in 100 until 132) {
                val expected = if (sourceX % 2 == 0) Color.BLACK else Color.WHITE
                assertEquals("source x=$sourceX", expected, mirrored.getPixel(width - 1 - sourceX, height / 2))
            }
        } finally {
            mirrored.recycle()
        }
    }

    @Test fun preparesStaticHeicWhenTheDeviceCanDecodeIt() {
        // One 64 x 32 magenta frame, encoded with libx265's Main profile.
        val heic = Base64.decode(
            "AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABQm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAA" +
            "AAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABYgAAABMAAAAqaWluZgAAAAAAAQAAABxpbmZlAgAA" +
            "AAABAABodmMxcHJpbWFyeQAAAAC/aXBycAAAAKFpcGNvAAAAdWh2Y0MBAWAAAACQAAAAAAAe8AD8/fj4AAAPA6AAAQAY" +
            "QAEMAf//AWAAAAMAkAAAAwAAAwAelZQJoQABAClCAQEBYAAAAwCQAAADAAADAB6gIIIWWVlSkwvAWgIAAAMAAgAAAwAy" +
            "EKIAAQAGRAHAc8CJAAAAFGlzcGUAAAAAAAAAQAAAACAAAAAQcGl4aQAAAAADCAgIAAAAFmlwbWEAAAAAAAAAAQABA4EC" +
            "AwAAABttZGF0AAAADygBrHYkK/7cl3H3BZsSmA==",
            Base64.DEFAULT,
        )
        val source = temporary.newFile("magenta.heic").apply { writeBytes(heic) }
        val output = temporary.newFolder()
        val platformBitmap = if (Build.VERSION.SDK_INT >= 28) {
            try {
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(source))
            } catch (_: IOException) {
                null
            }
        } else null // Public HEIF collection and orientation metadata are available from API 28.
        if (platformBitmap == null) {
            val failure = assertThrows(MediaFailure::class.java) { AndroidUploadImage.prepare(source, output) }
            assertEquals(-32602, failure.code)
            assertEquals("unsupported_image", failure.message)
            assertTrue(output.listFiles()!!.isEmpty())
        } else {
            platformBitmap.recycle()
            val jpeg = decodeJPEG(AndroidUploadImage.prepare(source, output))
            assertEquals(64, jpeg.width)
            assertEquals(32, jpeg.height)
            assertColor(Color.MAGENTA, jpeg.getPixel(32, 16))
            jpeg.recycle()
        }
        assertArrayEquals(heic, source.readBytes())
    }

    @Test fun rejectsCorruptAndAnimatedImagesWithoutLeavingOutput() {
        // Two 1x1 GIF frames, one black and one white.
        val animated = Base64.decode(
            "R0lGODlhAQABAIAAAAAAAP///yH5BAABAAAALAAAAAABAAEAAAICRAEAIfkEAAEAAAAsAAAAAAEAAQAAAgJMAQA7",
            Base64.DEFAULT,
        )
        val png = image(96, 64, Bitmap.CompressFormat.PNG) { _, _ -> Color.BLUE }
        val output = temporary.newFolder()
        for (bytes in listOf(byteArrayOf(), png.readBytes().copyOf(33), animated)) {
            val source = temporary.newFile().apply { writeBytes(bytes) }
            val failure = assertThrows(MediaFailure::class.java) { AndroidUploadImage.prepare(source, output) }
            assertEquals(-32602, failure.code)
            assertTrue(output.listFiles()!!.isEmpty())
            assertArrayEquals(bytes, source.readBytes())
        }
    }

    private fun image(width: Int, height: Int, format: Bitmap.CompressFormat, pixel: (Int, Int) -> Int): File {
        val pixels = IntArray(width * height) { pixel(it % width, it / width) }
        val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
        val source = temporary.newFile()
        source.outputStream().use { assertTrue(bitmap.compress(format, 100, it)) }
        bitmap.recycle()
        return source
    }

    private fun decodeJPEG(file: File): Bitmap {
        val options = BitmapFactory.Options()
        val bitmap = checkNotNull(BitmapFactory.decodeFile(file.path, options))
        assertEquals("image/jpeg", options.outMimeType)
        return bitmap
    }

    private fun assertColor(expected: Int, actual: Int, message: String = "") {
        val delta = maxOf(abs(Color.red(expected) - Color.red(actual)),
            abs(Color.green(expected) - Color.green(actual)), abs(Color.blue(expected) - Color.blue(actual)))
        assertTrue("$message: expected ${Color.red(expected)},${Color.green(expected)},${Color.blue(expected)}; " +
            "got ${Color.red(actual)},${Color.green(actual)},${Color.blue(actual)}", delta <= 20)
    }
}
