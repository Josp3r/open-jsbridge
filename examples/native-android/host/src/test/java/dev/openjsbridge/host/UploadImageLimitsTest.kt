package dev.openjsbridge.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.Base64
import java.util.concurrent.CancellationException
import java.util.zip.GZIPInputStream

class UploadImageLimitsTest {
    @get:Rule val temporary = TemporaryFolder()
    private lateinit var original: File

    @Before fun retainOriginal() {
        original = temporary.newFile("original").apply { writeText("keep") }
    }

    @Test fun outputExactlyAtTheBudgetIsKept() {
        val output = writeUploadJpeg(temporary.root, {}) { stream ->
            writeTwentyMiB(stream)
            true
        }
        assertEquals(MAX_BYTES.toLong(), output.length())
        assertEquals(setOf(original, output), temporary.root.listFiles()!!.toSet())
        assertEquals("keep", original.readText())
    }

    @Test fun oneOversizedWriteFailsWithoutLeavingAnOutput() {
        val error = assertThrows(MediaFailure::class.java) {
            writeUploadJpeg(temporary.root, {}) { stream ->
                stream.write(ByteArray(MAX_BYTES + 1))
                true
            }
        }
        assertEquals(-32006, error.code)
        assertOnlyOriginalRemains()
    }

    @Test fun incrementalOverflowSurvivesAnEncoderThatConsumesTheStreamException() {
        val error = assertThrows(MediaFailure::class.java) {
            writeUploadJpeg(temporary.root, {}) { stream ->
                writeTwentyMiB(stream)
                // The write must stop here, even if the native encoder reduces the error to false.
                assertThrows(Exception::class.java) { stream.write(1) }
                false
            }
        }
        assertEquals(-32006, error.code)
        assertOnlyOriginalRemains()
    }

    @Test fun cancellationDuringOutputSurvivesAnEncoderThatReportsFailure() {
        var cancelled = false
        val checkCancelled = { if (cancelled) throw CancellationException() }
        assertThrows(CancellationException::class.java) {
            writeUploadJpeg(temporary.root, checkCancelled) { stream ->
                stream.write(1)
                cancelled = true
                assertThrows(Exception::class.java) { stream.write(2) }
                false
            }
        }
        assertOnlyOriginalRemains()
    }

    @Test fun cancellationAfterFinalWriteDiscardsTheCompletedOutput() {
        var cancelled = false
        assertThrows(CancellationException::class.java) {
            writeUploadJpeg(temporary.root, { if (cancelled) throw CancellationException() }) { stream ->
                stream.write(1)
                cancelled = true
                true
            }
        }
        assertOnlyOriginalRemains()
    }

    @Test fun encoderReturningFalseDiscardsThePartiallyWrittenFile() {
        assertThrows(Exception::class.java) {
            writeUploadJpeg(temporary.root, {}) { stream ->
                stream.write(1)
                false
            }
        }
        assertOnlyOriginalRemains()
    }

    @Test fun outOfRangeCompressionParametersFailWithoutCreatingAnOutput() {
        for ((edge, quality) in listOf(0 to 80, 4097 to 80, 2048 to 0, 2048 to 101)) {
            val error = assertThrows(MediaFailure::class.java) {
                AndroidUploadImage.prepare(original, temporary.root, maxEdge = edge, quality = quality)
            }
            assertEquals("maxEdge=$edge quality=$quality", -32602, error.code)
            assertOnlyOriginalRemains()
        }
    }

    @Test fun staticImageContainersMustBeComplete() {
        // One black pixel encoded as four ordinary, single-frame images.
        val images = mapOf(
            "image/jpeg" to SINGLE_PIXEL_JPEG,
            "image/png" to "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mNgAAAAAgAB5Sfe/AAAAABJRU5ErkJggg==",
            "image/gif" to "R0lGODdhAQABAIEAAAAAAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==",
            "image/webp" to "UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==",
        )
        val file = temporary.newFile()
        for ((mime, encoded) in images) {
            val complete = Base64.getDecoder().decode(encoded)
            file.writeBytes(complete)
            requireStaticUploadImage(file, mime)
            file.writeBytes(complete.copyOf(complete.size - 1))
            assertThrows(mime, IOException::class.java) { requireStaticUploadImage(file, mime) }
        }
    }

    @Test fun twoFrameImagesAreRejectedBeforeDecoding() {
        // Black and white 1x1 frames, saved with a 150 ms delay.
        val animations = mapOf(
            "image/gif" to ("R0lGODlhAQABAIEAAAAAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAAAQABAAAIBAABBAQA" +
                "IfkEAQ8AAQAsAAAAAAEAAQCB////AAAAAAAAAAAACAQAAQQEADs="),
            "image/png" to ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAB" +
                "AAAAAQAAAAAAAAAAAAMAFAAANgftygAAAApJREFUeNpjYAAAAAIAAeUn3vwAAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAA" +
                "AAAAMAFAAArXQHHgAAAA5mZEFUAAAAAnjaY/gPAAEBAQBur8dJAAAAAElFTkSuQmCC"),
            "image/webp" to ("UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAAAAAAAAABBTk1GJgAAAAAAAAAAAAAAAAAAAJYAAAJW" +
                "UDhMDgAAAC8AAAAABxAR/Q9ERP8DQU5NRioAAAAAAAAAAAAAAAAAAACWAAAAVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA="),
        )
        val file = temporary.newFile()
        for ((mime, encoded) in animations) {
            file.writeBytes(Base64.getDecoder().decode(encoded))
            assertThrows(mime, IOException::class.java) { requireStaticUploadImage(file, mime) }
        }
    }

    @Test fun acceptsCompleteSingleImageBmpAndRejectsTruncatedPixels() {
        // One black pixel in a 24-bit Windows BMP, including row padding.
        val bmp = Base64.getDecoder().decode(
            "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAADEDgAAxA4AAAAAAAAAAAAAAAAAAA==",
        )
        val file = temporary.newFile()
        file.writeBytes(bmp)
        requireStaticUploadImage(file, "image/bmp")
        file.writeBytes(bmp.copyOf(54)) // Complete headers, missing pixel row.
        assertThrows(IOException::class.java) { requireStaticUploadImage(file, "image/bmp") }
    }

    @Test fun rejectsMpoWithASecondIndependentView() {
        // Two 1x1 JPEGs (black and white). The MP index marks the second view as stereo disparity.
        val mpo = Base64.getDecoder().decode(
            "/9j/4AAQSkZJRgABAQAAAQABAAD/4gBoTVBGAElJKgAIAAAAAwAAsAcABAAAADAxMDABsAQAAQAAAAIAAAACsAcAIAAAADIA" +
                "AAAAAAAAAAADIAoBAAAAAAAAAAAAAAIAAgCgAAAA7gAAAAAAAAAgICAgICAgICAgICAgICAg/9sAQwAIBgYHBgUIBwcHCQkI" +
                "CgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/8AACwgAAQABAQERAP/EABQAAQAA" +
                "AAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AD+//9n/2P/gABBKRklGAAEBAAABAAEAAP/b" +
                "AEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/AAAsI" +
                "AAEAAQEBEQD/xAAUAAEAAAAAAAAAAAAAAAAAAAAH/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwB/f//Z",
        )
        val file = temporary.newFile().apply { writeBytes(mpo) }
        assertThrows(IOException::class.java) { requireStaticUploadImage(file, "image/jpeg") }
    }

    @Test fun acceptsAHdrGainmapAndRejectsAnAdditionalPhoto() {
        // Adobe Ultra HDR: the MP index points to a 527-byte grayscale JPEG with hdrgm XMP.
        // The primary JPEG's XMP container directory identifies this second JPEG as its gainmap.
        val compressed = Base64.getDecoder().decode(
            "H4sIAAAAAAACA+VU3U4TQRQ+Q6E/tgSqNUFSZBlMUEN32qUGu+nCBU21xiakGKOXwzJu17A/7C5pe+UD+DI8Ahc+hOCN+iLr" +
                "THfb0CKJxHjlJLt75pvvfOeczZcJv4Y/Zs66QeCqhNi+TI+cQybrjkX61CUVuUyg3lf7lmuxgEp969j21b6GhzSVxwImeKfu" +
                "HX1QO41mzOA7DceivV5P7m3JjmeQSq1WI2WFKEqJM0r+wA5ov2T767FAg/m6Z7qB6diS2NND5zTQMI5Vu0eeYY11J5rlRyWD" +
                "mnbJirvG0pCtvmWez+U0zMGRzp7D65o2865qGY5jHEdibtcJHH8oo4+oZJTcCph1mzyT88UPGhdVG6bH9MDxBtHQB+wkCo7N" +
                "4dAu9Xz2ZuAyDXeY75x6OptIFw1I4sUzLWoHpq7hfc+0qDfAEd42LZ7MEYORjy4zMNmpk6jCX1d6wY/a1L2pUgS/ZrYRdDX8" +
                "TNmeqE3G85Lf/g4yZYIY4b7i0diFO+FPeNfeb0Kr9RTSAJAAOEvBLI/KlXIZnc0C4vGMeDgu8a8Co5WQNmdhYi1woouiOPwO" +
                "i6+arSYgDiAhE36DPUgnk6nkXDqVSmUy6Tu5wnwum809uHtvobCyvPpwZblYlB7JGxLeXC8WH28/2SxXqtXq6kZNe67U5a2q" +
                "IkRQJpPJZXNL8/NLylpxTbn1Cs8hnxZNJRCGmTxK5FH4Be4PW51YSQ4XFqdREGQ0TU6mBDl/nXwJuQTiZRJ52IXPwE4+hRch" +
                "vyuQ/b/cFREW+71tcvgaSPl0lRH4stHZoy7VzWAwyb56EGX8udP/kR/PITu0EkJ54YsCTBtg7gYPXUJatLIL78OLXw3Ub7c7" +
                "BgAA",
        )
        val file = temporary.newFile()
        file.writeBytes(GZIPInputStream(compressed.inputStream()).use { it.readBytes() })
        requireStaticUploadImage(file, "image/jpeg")
        file.appendBytes(Base64.getDecoder().decode(SINGLE_PIXEL_JPEG))
        assertThrows(IOException::class.java) { requireStaticUploadImage(file, "image/jpeg") }
    }

    private fun writeTwentyMiB(stream: OutputStream) {
        val chunk = ByteArray(64 * 1024)
        repeat(MAX_BYTES / chunk.size) { stream.write(chunk, 0, chunk.size) }
    }

    private fun assertOnlyOriginalRemains() {
        assertEquals(listOf(original), temporary.root.listFiles()!!.toList())
        assertEquals("keep", original.readText())
    }

    private companion object {
        const val SINGLE_PIXEL_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIs" +
            "IxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAA" +
            "AAAAAAAAAAAAAAD/2gAIAQEAAD8AP7//2Q=="
        const val MAX_BYTES = 20 * 1024 * 1024
    }
}
