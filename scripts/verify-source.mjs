import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requiredFiles = [
  '.github/workflows/macos-release.yml',
  '.github/workflows/source-check.yml',
  '.github/workflows/windows-release.yml',
  '.gitignore',
  'LICENSE',
  'README.md',
  'README.en.md',
  'THIRD_PARTY_NOTICES.md',
  'build/deepseek-harness.svg',
  'build/icon.icns',
  'build/icon.png',
  'harness/package-lock.json',
  'harness/package.json',
  'harmonyos/AppScope/app.json5',
  'harmonyos/AppScope/resources/base/element/string.json',
  'harmonyos/AppScope/resources/base/media/app_icon.png',
  'harmonyos/README.md',
  'harmonyos/build-profile.json5',
  'harmonyos/entry/build-profile.json5',
  'harmonyos/entry/hvigorfile.ts',
  'harmonyos/entry/oh-package.json5',
  'harmonyos/entry/src/main/ets/entryability/EntryAbility.ets',
  'harmonyos/entry/src/main/ets/pages/Index.ets',
  'harmonyos/entry/src/main/module.json5',
  'harmonyos/entry/src/main/resources/base/element/color.json',
  'harmonyos/entry/src/main/resources/base/element/string.json',
  'harmonyos/entry/src/main/resources/base/media/icon.png',
  'harmonyos/entry/src/main/resources/base/media/startIcon.png',
  'harmonyos/entry/src/main/resources/base/profile/main_pages.json',
  'harmonyos/hvigor/hvigor-config.json5',
  'harmonyos/hvigorfile.ts',
  'harmonyos/oh-package.json5',
  'main.js',
  'package-lock.json',
  'package.json',
  'preload.js',
  'scripts/build-windows.ps1',
  'scripts/build.sh',
  'scripts/generate-icons.mjs',
  'scripts/package-source.ps1',
  'scripts/prepare-runtime.mjs',
  'scripts/prepare-runtime.ps1',
  'scripts/verify-macos.sh',
  'shell.html',
]

for (const relativePath of requiredFiles) {
  await fs.access(path.join(projectRoot, relativePath))
}

const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
const harnessManifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'harness/package.json'), 'utf8'))

if (manifest.devDependencies?.electron !== '43.4.0') {
  throw new Error('Electron must remain pinned to 43.4.0 for this release.')
}
if (harnessManifest.dependencies?.['@deepseek-ai/dsh'] !== '0.1.0-rc.6') {
  throw new Error('DeepSeek Harness must remain pinned to 0.1.0-rc.6 for this release.')
}

const expectedInstallScripts = {
  '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.6': true,
  '@google/genai@1.52.0': true,
  'koffi@3.1.4': true,
  'node-pty@1.1.0': true,
  'protobufjs@7.6.5': true,
}
if (JSON.stringify(harnessManifest.allowScripts) !== JSON.stringify(expectedInstallScripts)) {
  throw new Error('The audited Harness install-script allowlist has changed.')
}
if (manifest.build?.win?.signExecutable !== false) {
  throw new Error('Unsigned community builds must explicitly set win.signExecutable=false.')
}
// Cross-platform runtime preparation: Windows and macOS must both go through
// the audited Node implementation (the PowerShell script is kept only as the
// legacy Windows entry point).
if (manifest.scripts?.setup !== 'node scripts/prepare-runtime.mjs') {
  throw new Error('npm run setup must use the cross-platform scripts/prepare-runtime.mjs.')
}
// macOS packaging policy (stage 2.4): dmg for the host architecture, no
// developer identity at build time (ad-hoc signing happens in build.sh), and
// the committed ICNS icon.
if (JSON.stringify(manifest.build?.mac?.target) !== JSON.stringify([{ target: 'dmg' }])) {
  throw new Error('macOS packaging must target dmg only (host architecture).')
}
if (manifest.build?.mac?.identity !== null) {
  throw new Error('mac.identity must be null: release builds are ad-hoc signed by scripts/build.sh.')
}
if (manifest.build?.mac?.icon !== 'build/icon.icns') {
  throw new Error('macOS packaging must use the committed build/icon.icns.')
}
if (manifest.build?.mac?.hardenedRuntime !== false || manifest.build?.mac?.gatekeeperAssess !== false) {
  throw new Error('macOS packaging must disable hardened runtime and Gatekeeper assessment for self-use ad-hoc builds.')
}
{
  const icns = await fs.readFile(path.join(projectRoot, 'build/icon.icns'))
  if (icns.subarray(0, 4).toString('ascii') !== 'icns') {
    throw new Error('build/icon.icns is not a valid ICNS container.')
  }
}
// HarmonyOS thin client policy (stage 3.2/3.3): one Web-based entry ability,
// INTERNET permission, and the ArkWeb host-address flow must stay wired.
{
  const moduleJson5 = await fs.readFile(path.join(projectRoot, 'harmonyos/entry/src/main/module.json5'), 'utf8')
  if (!moduleJson5.includes('ohos.permission.INTERNET')) {
    throw new Error('The HarmonyOS module must declare ohos.permission.INTERNET.')
  }
  const indexEts = await fs.readFile(path.join(projectRoot, 'harmonyos/entry/src/main/ets/pages/Index.ets'), 'utf8')
  if (!indexEts.includes('Web({ src')) {
    throw new Error('The HarmonyOS page must host the ArkWeb Web component.')
  }
  if (!indexEts.includes('getPreferencesSync')) {
    throw new Error('The HarmonyOS page must persist the host URL with Preferences.')
  }
  const rootBuildProfile = await fs.readFile(path.join(projectRoot, 'harmonyos/build-profile.json5'), 'utf8')
  if (!rootBuildProfile.includes('compatibleSdkVersion')) {
    throw new Error('harmonyos/build-profile.json5 must declare compatibleSdkVersion.')
  }
}
// Installer policy (user decision 2026-08-15): the install path is user
// selectable, defaults to a non-system drive, and C: is rejected. Enforced by
// build/installer.nsh; these assertions keep the policy from drifting.
if (manifest.build?.nsis?.allowToChangeInstallationDirectory !== true) {
  throw new Error('The installer must allow choosing the installation directory (nsis.allowToChangeInstallationDirectory=true).')
}
if (manifest.build?.nsis?.include !== 'build/installer.nsh') {
  throw new Error('The installer policy header build/installer.nsh must be wired via nsis.include.')
}
{
  const installerPolicy = await fs.readFile(path.join(projectRoot, 'build/installer.nsh'), 'utf8')
  if (!installerPolicy.includes('NonCDrivePickDefault')) {
    throw new Error('build/installer.nsh must define the non-system-drive default (NonCDrivePickDefault).')
  }
}

const publicFiles = ['main.js', 'preload.js', 'shell.html', 'README.md', 'README.en.md', 'harmonyos/README.md', '.env.example', 'scripts/build.sh', 'scripts/verify-macos.sh']
for (const relativePath of publicFiles) {
  const content = await fs.readFile(path.join(projectRoot, relativePath), 'utf8')
  if (/C:\\Users\\[^\\]+/i.test(content)) {
    throw new Error(`A user-specific Windows path was found in ${relativePath}.`)
  }
  if (/DEEPSEEK_API_KEY\s*=\s*\S+/i.test(content)) {
    throw new Error(`A populated DEEPSEEK_API_KEY was found in ${relativePath}.`)
  }
}

console.log('Source verification passed.')
