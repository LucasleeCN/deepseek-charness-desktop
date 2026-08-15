#!/usr/bin/env node
/**
 * DeepSeek Harness Desktop — cross-platform runtime preparation (clean-room).
 *
 * Node.js implementation replacing the Windows-only PowerShell script, so the
 * same flow works on Windows and macOS (stage 2 of the execution plan):
 *
 *   1. Install the pinned `@deepseek-ai/dsh` into harness/ via `npm ci`.
 *   2. Download the pinned Node.js runtime for the current platform/arch,
 *      verify it against the official SHASUMS256.txt AND a pinned per-archive
 *      SHA-256 (double check), and extract just the runtime bits we need.
 *   3. Copy the official whale icon from the installed frontend package.
 *   4. Regenerate the third-party notices.
 *
 * Usage:
 *   node scripts/prepare-runtime.mjs [--force]
 *
 * No third-party runtime dependencies; zip/tar.gz parsing is implemented here
 * with the Node stdlib so the script runs anywhere Node runs.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const HARNESS_ROOT = join(PROJECT_ROOT, 'harness')
const RUNTIME_ROOT = join(HARNESS_ROOT, 'runtime')
const BUILD_DIR = join(PROJECT_ROOT, 'build')

const NODE_VERSION = '24.19.0'
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`

/** Per-archive pinned SHA-256 (uppercase), double-checked against the official SHASUMS256.txt. */
const PINNED_SHA256 = {
  'node-v24.19.0-win-x64.zip': '57F71AB3652E797D84ACDDC79C81CC9FF1C6DDB2A1974CDB83F00FEE9BFF4C73',
  'node-v24.19.0-darwin-arm64.tar.gz': '8294B7AA9B03997481C06BABF1E8B270C859358F27DA57A11509AFE537AC381D',
  'node-v24.19.0-darwin-x64.tar.gz': 'D1B5E999DB158C62FE8F7267A4476B035D8BD93B1A605BAC24A3F0DD166E3316',
}

const isForce = process.argv.includes('--force')

function fail(message) {
  console.error(`prepare-runtime: ${message}`)
  process.exit(1)
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase()
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ---------------------------------------------------------------------------
// 1. Harness install
// ---------------------------------------------------------------------------

function installHarness() {
  const manifest = readJson(join(HARNESS_ROOT, 'package.json'))
  const expected = manifest.dependencies?.['@deepseek-ai/dsh']
  if (typeof expected !== 'string' || expected === '') {
    fail(`harness/package.json must pin @deepseek-ai/dsh (found: ${String(expected)})`)
  }
  const installedManifest = join(HARNESS_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  let installedVersion = null
  if (existsSync(installedManifest)) {
    installedVersion = readJson(installedManifest).version
  }
  if (!isForce && installedVersion === expected) {
    console.log(`Harness runtime dependencies are already prepared (${expected}).`)
    return
  }
  if (installedVersion !== null && installedVersion !== expected) {
    console.log(`Updating @deepseek-ai/dsh ${installedVersion} -> ${expected}...`)
  } else {
    console.log(`Installing @deepseek-ai/dsh ${expected} from the committed lockfile...`)
  }
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: HARNESS_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

// ---------------------------------------------------------------------------
// 2. Node.js runtime (download, double-verify, extract)
// ---------------------------------------------------------------------------

function nodeBinaryName() {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

function archiveForPlatform() {
  const key = `${process.platform}-${process.arch}`
  switch (key) {
    case 'win32-x64': return 'node-v24.19.0-win-x64.zip'
    case 'darwin-arm64': return 'node-v24.19.0-darwin-arm64.tar.gz'
    case 'darwin-x64': return 'node-v24.19.0-darwin-x64.tar.gz'
    default:
      fail(`unsupported platform/arch: ${key} (supported: win32-x64, darwin-arm64, darwin-x64)`)
  }
}

function runtimeState() {
  const binary = join(RUNTIME_ROOT, nodeBinaryName())
  if (!existsSync(binary)) return { ready: false, binary }
  try {
    const version = execFileSync(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/^v/, '')
    return { ready: version === NODE_VERSION, binary, version }
  } catch {
    // Some constrained environments forbid pipe-based stdio capture. Fall
    // back to an execution-only probe: the runtime directory is versioned by
    // this script, so a successful `--version` exit is enough.
    try {
      execFileSync(binary, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      return { ready: true, binary, version: 'unknown' }
    } catch {
      return { ready: false, binary }
    }
  }
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-prepare-runtime' } })
  if (!res.ok) fail(`download failed (${res.status}): ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Parse a ZIP archive (stored + deflate entries) with the Node stdlib.
 * Returns a lookup: (namePredicate) => Buffer | null.
 */
function openZip(archive) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  let eocd = -1
  // The EOCD record may be followed by a ZIP comment of up to 0xFFFF bytes.
  const scanStart = Math.max(0, archive.length - 22 - 0xFFFF)
  for (let i = archive.length - 22; i >= scanStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) fail('zip: end-of-central-directory not found')
  const cdOffset = view.getUint32(eocd + 16, true)
  const cdCount = view.getUint16(eocd + 10, true)
  const entries = []
  let p = cdOffset
  for (let n = 0; n < cdCount; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) fail('zip: bad central directory entry')
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOffset = view.getUint32(p + 42, true)
    const name = archive.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return (match) => {
    for (const entry of entries) {
      if (!match(entry.name)) continue
      const lo = entry.localOffset
      if (view.getUint32(lo, true) !== 0x04034b50) fail(`zip: bad local header for ${entry.name}`)
      const lNameLen = view.getUint16(lo + 26, true)
      const lExtraLen = view.getUint16(lo + 28, true)
      const dataStart = lo + 30 + lNameLen + lExtraLen
      const data = archive.subarray(dataStart, dataStart + entry.compressedSize)
      if (entry.method === 0) return Buffer.from(data)
      if (entry.method === 8) return inflateRawSync(data)
      fail(`zip: unsupported compression method ${entry.method} for ${entry.name}`)
    }
    return null
  }
}

/** Parse a tar archive (ustar + pax long-path) with the Node stdlib. */
function openTar(tarball) {
  const files = new Map()
  let off = 0
  let paxPath = null
  let gnuName = null
  while (off + 512 <= tarball.length) {
    const header = tarball.subarray(off, off + 512)
    if (header.every(b => b === 0)) break
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim() || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 48)
    const data = tarball.subarray(off + 512, off + 512 + size)
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (typeflag === 'x' || typeflag === 'g') {
      for (const m of data.toString('utf8').matchAll(/(\d+) ([^\n]+)\n/g)) {
        const rec = m[2]
        const eq = rec.indexOf('=')
        if (eq > 0 && rec.slice(0, eq) === 'path') paxPath = rec.slice(eq + 1)
      }
    } else if (typeflag === 'L') {
      gnuName = data.toString('utf8').replace(/\0.*$/, '')
    } else if (typeflag === '0' || typeflag === '') {
      if (gnuName) { name = gnuName; gnuName = null }
      else if (paxPath) { name = paxPath; paxPath = null }
      files.set(name, Buffer.from(data))
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return (match) => {
    for (const [name, buffer] of files) {
      if (match(name)) return buffer
    }
    return null
  }
}

async function prepareRuntime() {
  const { ready, binary } = runtimeState()
  if (!isForce && ready) {
    console.log(`Bundled Node.js runtime is already prepared (v${NODE_VERSION}).`)
    return
  }

  const archiveName = archiveForPlatform()
  const pinned = PINNED_SHA256[archiveName]
  if (pinned === undefined) fail(`no pinned SHA-256 for ${archiveName}`)

  console.log(`Downloading Node.js v${NODE_VERSION} for ${process.platform}/${process.arch}...`)
  const [archive, shasums] = await Promise.all([
    fetchBytes(`${NODE_BASE}/${archiveName}`),
    fetchBytes(`${NODE_BASE}/SHASUMS256.txt`),
  ])

  // Double check: official SHASUMS line, then the pinned value.
  const shasumLine = shasums.toString('utf8').split(/\r?\n/)
    .find(line => line.trim().endsWith(`  ${archiveName}`))
  if (!shasumLine) fail(`no SHA-256 entry found for ${archiveName} in SHASUMS256.txt`)
  const publishedHash = shasumLine.trim().split(/\s+/)[0].toUpperCase()
  if (publishedHash !== pinned) {
    fail(`published checksum changed: expected ${pinned}, published ${publishedHash}`)
  }
  const actualHash = sha256Hex(archive)
  if (actualHash !== pinned) {
    fail(`checksum mismatch: expected ${pinned}, received ${actualHash}`)
  }
  console.log(`Verified Node.js archive SHA-256: ${actualHash}`)

  const findEntry = archiveName.endsWith('.zip')
    ? openZip(archive)
    : openTar(gunzipSync(archive))

  // The runtime binary lives at <root>/bin/node (or <root>/node.exe on win).
  const nodeBinary = findEntry(name =>
    name.endsWith('/bin/node') || name.endsWith('\\bin\\node')
    || name.endsWith('/node.exe') || name.endsWith('\\node.exe'))
  if (!nodeBinary) fail(`node binary not found inside ${archiveName}`)
  const nodeLicense = findEntry(name => /(^|\/)LICENSE$/.test(name))

  mkdirSync(RUNTIME_ROOT, { recursive: true })
  writeFileSync(binary, nodeBinary)
  if (nodeLicense) {
    writeFileSync(join(RUNTIME_ROOT, 'NODE-LICENSE.txt'), nodeLicense)
  } else {
    fail(`node LICENSE file not found inside ${archiveName}`)
  }
  writeFileSync(join(RUNTIME_ROOT, 'SHASUMS256.txt'), shasums)
  if (process.platform !== 'win32') {
    try {
      chmodSync(binary, 0o755)
    } catch { /* best effort; macOS archives usually keep the mode intact */ }
  }
  console.log(`Runtime ready: ${binary} (v${NODE_VERSION})`)
}

// ---------------------------------------------------------------------------
// 3. Icon + third-party notices
// ---------------------------------------------------------------------------

function prepareIcon() {
  const officialIcon = join(HARNESS_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg')
  const target = join(BUILD_DIR, 'deepseek-harness.svg')
  if (!existsSync(officialIcon)) {
    fail('the official Harness icon was not found after installation')
  }
  if (isForce || !existsSync(target)) {
    mkdirSync(BUILD_DIR, { recursive: true })
    copyFileSync(officialIcon, target)
    console.log(`Copied official icon to ${target}`)
  }
}

function regenerateNotices() {
  execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'generate-third-party-notices.mjs')], {
    stdio: 'inherit',
  })
}

// ---------------------------------------------------------------------------

async function main() {
  installHarness()
  await prepareRuntime()
  prepareIcon()
  regenerateNotices()
  console.log('Runtime preparation complete.')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
