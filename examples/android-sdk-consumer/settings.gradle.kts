pluginManagement {
    plugins {
        id("org.jetbrains.kotlin.android") version "2.0.21"
    }
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "com.android.application") {
                useModule("com.android.tools.build:gradle:8.7.3")
            }
        }
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val sdkRepository = providers.gradleProperty("ojsbSdkRepository")
    .map { file(it) }
    .orElse(file("../native-android/build/sdk-maven"))

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    name = "localOpenJSBridgeSdk"
                    url = uri(sdkRepository.get())
                }
            }
            filter { includeModule("io.github.josp3r", "open-jsbridge-android") }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "OpenJSBridgeAndroidSdkConsumer"
include(":app")
