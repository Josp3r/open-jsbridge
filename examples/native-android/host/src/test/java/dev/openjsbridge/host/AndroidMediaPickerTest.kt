package dev.openjsbridge.host

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidMediaPickerTest {
    @Test
    fun acceptsOnlyAndroidxSystemPickerRoutes() {
        // Framework and extension picker, OEM backport, and Play services backport.
        assertTrue(isSystemPhotoPickerAction("android.provider.action.PICK_IMAGES"))
        assertTrue(isSystemPhotoPickerAction("androidx.activity.result.contract.action.PICK_IMAGES"))
        assertTrue(isSystemPhotoPickerAction("com.google.android.gms.provider.action.PICK_IMAGES"))

        assertFalse(isSystemPhotoPickerAction(Intent.ACTION_OPEN_DOCUMENT))
        assertFalse(isSystemPhotoPickerAction(Intent.ACTION_GET_CONTENT))
        assertFalse(isSystemPhotoPickerAction("example.picker.PICK_IMAGES"))
        assertFalse(isSystemPhotoPickerAction(null))
    }
}
