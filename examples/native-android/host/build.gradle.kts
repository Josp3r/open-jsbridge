plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

android {
    namespace = "dev.openjsbridge.host"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    sourceSets.getByName("test").resources.srcDir("../../../conformance-tests/fixtures")

    publishing {
        singleVariant("release")
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
    api("com.google.code.gson:gson:2.12.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.lifecycle:lifecycle-process:2.6.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.1")
    testImplementation("junit:junit:4.13.2")
}

val sdkRepository = providers.gradleProperty("ojsbSdkRepository")
    .map { rootProject.file(it) }
    .orElse(rootProject.layout.buildDirectory.dir("sdk-maven").map { it.asFile })

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "io.github.josp3r"
            artifactId = "open-jsbridge-android"
            version = "0.1.0"
            // Use AGP's release component so API/runtime scopes are exported to the POM and module metadata.
            afterEvaluate { from(components["release"]) }
        }
    }
    repositories {
        maven {
            name = "localSdk"
            url = uri(sdkRepository.get())
        }
    }
}
