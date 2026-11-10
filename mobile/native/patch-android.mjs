// Adds DriveAtlas's own Android code and settings to the Android project that `npx cap add android` creates.
// Run from mobile/ after `cap add android`:  node native/patch-android.mjs
// Fails loudly if the generated files do not look as expected, so a broken build is never published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(mobile, 'android');
const pkgDir = path.join(android, 'app', 'src', 'main', 'java', 'io', 'github', 'sulmanahmad', 'driveatlas');
const fail = (msg) => { console.error(`patch-android: ${msg}`); process.exit(1); };

if (!fs.existsSync(path.join(pkgDir, 'MainActivity.java'))) fail(`MainActivity.java not found in ${pkgDir}; was the appId changed?`);

// 1. Java sources: the storage plugin and a MainActivity that registers it.
const src = path.join(mobile, 'native', 'java', 'io', 'github', 'sulmanahmad', 'driveatlas');
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(pkgDir, f));

// 2. AndroidManifest.xml: permissions and app settings.
const manifestPath = path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  // Whole drives: the phone's storage, SD card and OTG drives (Android 11+), and the older permission before that.
  '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />'
];
if (!manifest.includes('</manifest>')) fail('AndroidManifest.xml has no </manifest>');
for (const p of permissions) if (!manifest.includes(p)) manifest = manifest.replace('</manifest>', `    ${p}\n</manifest>`);
if (!/<application\b/.test(manifest)) fail('AndroidManifest.xml has no <application> tag');
// Sync with the PC runs over your home Wi-Fi to a local address; every message is encrypted by DriveAtlas itself.
if (!manifest.includes('android:usesCleartextTraffic')) manifest = manifest.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
if (!manifest.includes('android:requestLegacyExternalStorage')) manifest = manifest.replace(/<application\b/, '<application\n        android:requestLegacyExternalStorage="true"');
// The QR scanner screen (linking with the PC) turns with the phone instead of staying sideways.
if (!manifest.includes('xmlns:tools')) manifest = manifest.replace(/<manifest\b/, '<manifest xmlns:tools="http://schemas.android.com/tools"');
if (!manifest.includes('com.journeyapps.barcodescanner.CaptureActivity')) {
  if (!manifest.includes('</application>')) fail('AndroidManifest.xml has no </application>');
  manifest = manifest.replace('</application>', '    <activity android:name="com.journeyapps.barcodescanner.CaptureActivity" android:screenOrientation="fullSensor" tools:replace="screenOrientation" />\n    </application>');
}
fs.writeFileSync(manifestPath, manifest);

// 3. app/build.gradle: the fingerprint library, and the QR code scanner (ZXing) for linking with the PC.
const gradlePath = path.join(android, 'app', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
for (const dep of ['implementation "androidx.biometric:biometric:1.1.0"', 'implementation "com.journeyapps:zxing-android-embedded:4.3.0"']) {
  if (gradle.includes(dep)) continue;
  const at = gradle.search(/\ndependencies\s*\{/);
  if (at < 0) fail('app/build.gradle has no dependencies block');
  const brace = gradle.indexOf('{', at);
  gradle = gradle.slice(0, brace + 1) + `\n    ${dep}` + gradle.slice(brace + 1);
}
// Android's style checker should not stop a release build over warnings; real compile errors still do.
if (!gradle.includes('checkReleaseBuilds')) {
  const at = gradle.search(/\nandroid\s*\{/);
  if (at < 0) fail('app/build.gradle has no android block');
  const brace = gradle.indexOf('{', at);
  gradle = gradle.slice(0, brace + 1) + '\n    lint {\n        checkReleaseBuilds false\n        abortOnError false\n    }' + gradle.slice(brace + 1);
}
fs.writeFileSync(gradlePath, gradle);

// 4. variables.gradle: Android 7.0 or newer (the QR scanner and the storage code need it).
const varsPath = path.join(android, 'variables.gradle');
let vars = fs.readFileSync(varsPath, 'utf8');
if (!/minSdkVersion\s*=\s*\d+/.test(vars)) fail('variables.gradle has no minSdkVersion');
vars = vars.replace(/minSdkVersion\s*=\s*(\d+)/, (m, n) => (Number(n) < 24 ? 'minSdkVersion = 24' : m));
fs.writeFileSync(varsPath, vars);

console.log('patch-android: plugin, permissions, fingerprint and QR libraries added');
