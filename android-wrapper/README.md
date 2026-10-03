# Tally Android wrapper

Source for the Capacitor Android app. The parent directory contains the web app shared with iPhone/browser users. Signing keys, private handoffs, backups, generated web assets, and phone verification data are excluded.

Use Java 21 and an Android SDK. Run npm ci and npm run sync here, then android/gradlew assembleDebug. Debug installs as Tally Test (io.github.tallymy.dev). For signed release builds, set TALLY_KEYSTORE and TALLY_KEYSTORE_PASSWORD locally; never commit either secret. Play App Signing handles the installed release signature.
