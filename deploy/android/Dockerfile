# syntax=docker/dockerfile:1
# Builds the Logistics Pro Android app on your own server, without Expo's
# cloud: an APK for the download page and an app bundle for Google Play.
# Run it through deploy/build-android.sh.

FROM node:22-bookworm AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip zip && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/build-tools/36.0.0
# The SDK versions React Native 0.86 builds with.
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd /tmp \
 && curl -fsSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && unzip -q tools.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm tools.zip \
 && yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" > /dev/null

FROM toolchain AS build
WORKDIR /src
COPY . .
ARG EXPO_PUBLIC_API_URL
ARG ANDROID_VERSION_CODE=1
ARG ABIS=arm64-v8a,armeabi-v7a
ENV CI=1 EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL} ANDROID_VERSION_CODE=${ANDROID_VERSION_CODE}
RUN test -n "$EXPO_PUBLIC_API_URL" || (echo "EXPO_PUBLIC_API_URL is required" && exit 1)
RUN --mount=type=cache,target=/root/.npm npm ci
RUN cd apps/mobile && npx expo prebuild --platform android --no-install --clean
RUN --mount=type=cache,target=/root/.gradle cd apps/mobile/android \
 && ./gradlew assembleRelease bundleRelease --no-daemon -PreactNativeArchitectures=${ABIS} \
 && mkdir -p /out && cp app/build/outputs/apk/release/app-release.apk /out/built.apk \
 && cp app/build/outputs/bundle/release/app-release.aab /out/built.aab \
 && node -p "require('/src/apps/mobile/app.json').expo.version" > /out/version
COPY deploy/android/sign.sh /usr/local/bin/sign-apk
CMD ["sh", "/usr/local/bin/sign-apk"]
