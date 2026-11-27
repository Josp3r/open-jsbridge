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
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets.getByName("test").resources.srcDir("../../../conformance-tests/fixtures")

    publishing {
        singleVariant("release") {
            withSourcesJar()
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
    api("com.google.code.gson:gson:2.12.1")
    implementation("androidx.activity:activity:1.9.3")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.lifecycle:lifecycle-process:2.6.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    androidTestImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}

val sdkGroup = "io.github.josp3r"
val sdkArtifactId = "open-jsbridge-android"
val sdkVersion = "0.2.0"
val projectUrl = "https://github.com/Josp3r/open-jsbridge"
val sdkRepository = providers.gradleProperty("ojsbSdkRepository")
    .map { rootProject.file(it) }
    .orElse(rootProject.layout.buildDirectory.dir("sdk-maven").map { it.asFile })

// Bundle the existing integration docs without pulling AGP's legacy Dokka toolchain.
val releaseDocumentationJar by tasks.registering(Jar::class) {
    archiveClassifier.set("javadoc")
    from(rootProject.file("README.md"))
    from(rootProject.file("../../docs/native-android.md"))
    from(rootProject.file("../../LICENSE")) { into("META-INF") }
}

tasks.withType<Jar>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = sdkGroup
            artifactId = sdkArtifactId
            version = sdkVersion
            pom {
                name.set("Open JSBridge Android")
                description.set("Android WebView host for the Open JSBridge protocol")
                url.set(projectUrl)
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/license/mit")
                    }
                }
                developers {
                    developer {
                        id.set("Josp3r")
                        name.set("Open JSBridge contributors")
                        url.set("$projectUrl/graphs/contributors")
                    }
                }
                scm {
                    connection.set("scm:git:$projectUrl.git")
                    developerConnection.set("scm:git:ssh://git@github.com/Josp3r/open-jsbridge.git")
                    url.set(projectUrl)
                }
            }
            artifact(releaseDocumentationJar)
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

tasks.register<Zip>("bundleUnsignedCentralRelease") {
    group = "publishing"
    description = "Assemble the unsigned Android release in Maven Central's bundle layout."
    dependsOn("publishReleasePublicationToLocalSdkRepository")

    val coordinatePath = "${sdkGroup.replace('.', '/')}/$sdkArtifactId/$sdkVersion"
    val artifactPrefix = "$sdkArtifactId-$sdkVersion"
    val publicationDir = sdkRepository.map { it.resolve(coordinatePath) }
    val bundleFiles = listOf(".aar", ".pom", ".module", "-sources.jar", "-javadoc.jar")
        .map { "$artifactPrefix$it" }
        .flatMap { listOf(it, "$it.md5", "$it.sha1") }
    from(publicationDir) {
        into(coordinatePath)
        include(bundleFiles)
    }
    doFirst {
        val missing = bundleFiles.filterNot { publicationDir.get().resolve(it).isFile }
        check(missing.isEmpty()) { "Missing Maven publication files: ${missing.joinToString()}" }
    }

    archiveFileName.set("$artifactPrefix-central-unsigned.zip")
    destinationDirectory.set(layout.buildDirectory.dir("central"))
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}
