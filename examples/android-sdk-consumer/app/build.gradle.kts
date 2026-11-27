plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.openjsbridge.sdkconsumer"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.openjsbridge.sdkconsumer"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    testBuildType = "release"
    buildTypes {
        release {
            // Test-only signing; the APK is still a non-debuggable Release build.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

@CacheableTask
abstract class StageConsumerPage : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val page: RegularFileProperty

    @get:OutputDirectory
    abstract val assetsDir: DirectoryProperty

    @TaskAction
    fun stage() {
        page.get().asFile.copyTo(assetsDir.file("ReleaseToast.html").get().asFile, overwrite = true)
    }
}

val stageConsumerPage by tasks.registering(StageConsumerPage::class) {
    page.fileProvider(providers.gradleProperty("ojsbConsumerPage")
        .map { rootProject.file(it) }
        .orElse(rootProject.file("../../dist/sdk-consumer/ReleaseToast.html")))
    assetsDir.set(layout.buildDirectory.dir("generated/ojsbConsumerPage/assets"))
}

@CacheableTask
abstract class StageConsumerMediaFixture @javax.inject.Inject constructor(
    private val files: FileSystemOperations,
) : DefaultTask() {
    @get:InputFile
    @get:Optional
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val fixture: RegularFileProperty

    @get:OutputDirectory
    abstract val assetsDir: DirectoryProperty

    @TaskAction
    fun stage() {
        // Sync also removes a previous staged fixture when the optional default is absent.
        files.sync {
            fixture.orNull?.let { from(it) { rename { "MediaFixture.png" } } }
            into(assetsDir)
        }
    }
}

val defaultMediaFixture = rootProject.file("../../dist/sdk-consumer/MediaFixture.png")
val stageConsumerMediaFixture by tasks.registering(StageConsumerMediaFixture::class) {
    fixture.fileProvider(providers.gradleProperty("ojsbConsumerMediaFixture")
        .map { rootProject.file(it) }
        .orElse(providers.provider { defaultMediaFixture.takeIf { it.isFile } }))
    assetsDir.set(layout.buildDirectory.dir("generated/ojsbConsumerMediaFixture/assets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(stageConsumerPage, StageConsumerPage::assetsDir)
        variant.androidTest?.sources?.assets?.addGeneratedSourceDirectory(
            stageConsumerMediaFixture, StageConsumerMediaFixture::assetsDir,
        )
    }
}

dependencies {
    implementation("io.github.josp3r:open-jsbridge-android:1.0.0")
    implementation("androidx.activity:activity:1.9.3")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
