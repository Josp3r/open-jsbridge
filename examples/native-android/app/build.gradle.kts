plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val androidTestBuildType = providers.gradleProperty("ojsbTestBuildType").orElse("debug")

android {
    namespace = "dev.openjsbridge.example"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.openjsbridge.example"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    testBuildType = androidTestBuildType.get()

    buildTypes {
        release {
            if (testBuildType == "release") {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":host"))
    releaseImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
