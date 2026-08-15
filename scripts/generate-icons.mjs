#!/usr/bin/env node
/**
 * DeepSeek Harness Desktop — icon generation (clean-room, no extra deps).
 *
 * Renders build/deepseek-harness.svg to the PNG sizes required by macOS and
 * writes:
 *
 *   - build/icon.png      1024x1024 PNG
 *   - build/icon.icns     macOS icon (ICNS container built with the stdlib)
 *
 * Rendering strategy, in order of preference:
 *   1. sharp from harness/node_modules (already installed by `npm run setup`
 *      as part of the pinned @deepseek-ai/dsh dependency tree);
 *   2. a Chrome/Chromium headless screenshot when sharp is unavailable.
 * No extra npm dependency is added for icon generation.
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const HARNESS_ROOT = path.join(ROOT, 'harness')
const SVG_PATH = path.join(ROOT, 'build', 'deepseek-harness.svg')
const PNG_PATH = path.join(ROOT, 'build', 'icon.png')
const ICNS_PATH = path.join(ROOT, 'build', 'icon.icns')

const SIZES = [16, 32, 64, 128, 256, 512, 1024]

function fail(message) {
  console.error(`generate-icons: ${message}`)
  process.exit(1)
}

function loadSharp() {
  try {
    return require(path.join(HARNESS_ROOT, 'node_modules', 'sharp'))
  } catch {
    return null
  }
}

async function renderWithSharp(sharp) {
  const svg = readFileSync(SVG_PATH)
  const pngBySize = new Map()
  for (const size of SIZES) {
    pngBySize.set(size, await sharp(svg).resize(size, size).png().toBuffer())
  }
  return pngBySize
}

function findChrome() {
  const candidates = []
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    )
  }
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function renderWithChrome() {
  const browser = findChrome()
  if (!browser) {
    fail('sharp is not installed and no Chrome/Chromium was found (set CHROME_PATH to a Chromium-based browser)')
  }
  const svg = readFileSync(SVG_PATH, 'utf8')
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-icons-'))
  const pngBySize = new Map()
  try {
    for (const size of SIZES) {
      const html = [
        '<!doctype html><html><head><style>',
        'html, body { margin: 0; padding: 0; background: #ffffff; overflow: hidden; }',
        `body { width: ${size}px; height: ${size}px; }`,
        `img { width: ${size}px; height: ${size}px; display: block; }`,
        '</style></head><body>',
        `<img src="${svgUrl}" alt="" />`,
        '</body></html>',
      ].join('')
      const htmlPath = path.join(tempRoot, `icon-${size}.html`)
      const outputPath = path.join(tempRoot, `icon-${size}.png`)
      writeFileSync(htmlPath, html, 'utf8')
      const result = spawnSync(browser, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${size},${size}`,
        '--default-background-color=FFFFFFFF',
        `--screenshot=${outputPath}`,
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ], { stdio: 'ignore', timeout: 45_000 })
      if (result.error) fail(`failed to run Chrome headless: ${result.error.message}`)
      if (result.status !== 0) fail(`Chrome headless exited with status ${result.status}`)
      if (!existsSync(outputPath)) fail(`Chrome did not produce ${outputPath}`)
      pngBySize.set(size, readFileSync(outputPath))
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
  return pngBySize
}

/** Encode `data` as an ICNS chunk with a four-character type. */
function icnsChunk(type, data) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(8 + data.length, 4)
  return Buffer.concat([header, data])
}

function buildIcns(pngBySize) {
  const chunks = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ].map(([type, size]) => icnsChunk(type, pngBySize.get(size)))
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([header, body])
}

if (!existsSync(SVG_PATH)) fail(`icon SVG not found: ${SVG_PATH}`)

const sharp = loadSharp()
const pngBySize = sharp ? await renderWithSharp(sharp) : renderWithChrome()

mkdirSync(path.dirname(PNG_PATH), { recursive: true })
writeFileSync(PNG_PATH, pngBySize.get(1024))
writeFileSync(ICNS_PATH, buildIcns(pngBySize))

console.log(`Wrote ${path.relative(ROOT, PNG_PATH)} (${pngBySize.get(1024).length} bytes)`)
console.log(`Wrote ${path.relative(ROOT, ICNS_PATH)} (${readFileSync(ICNS_PATH).length} bytes)`)
