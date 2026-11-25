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
        versionName = "0.1.0"
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

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(stageConsumerPage, StageConsumerPage::assetsDir)
    }
}

dependencies {
    implementation("io.github.josp3r:open-jsbridge-android:0.1.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
