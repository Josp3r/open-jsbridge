plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.openjsbridge.host"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    sourceSets.getByName("test").resources.srcDir("../../../conformance-tests/fixtures")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api("com.google.code.gson:gson:2.12.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.1")
    testImplementation("junit:junit:4.13.2")
}
