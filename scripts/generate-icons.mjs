#!/usr/bin/env node
/**
 * Generate SnCode app icons for all platforms.
 * Creates build/icon.png (1024x1024), build/icon.ico, build/icon.icns
 *
 * Design: Dark rounded-rectangle with a stylized "Sn" monogram + terminal cursor.
 * Matches the app's dark neutral palette (#141414 base).
 */

import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
mkdirSync(buildDir, { recursive: true });

const SIZE = 1024;

// SVG icon: dark rounded square with "Sn" text and a blinking cursor accent
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1e1e"/>
      <stop offset="100%" stop-color="#111111"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e0e0e0"/>
      <stop offset="100%" stop-color="#a0a0a0"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="12" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- Background rounded square -->
  <rect x="64" y="64" width="896" height="896" rx="180" ry="180"
        fill="url(#bg)" filter="url(#shadow)" stroke="#2a2a2a" stroke-width="3"/>

  <!-- Subtle inner border glow -->
  <rect x="80" y="80" width="864" height="864" rx="168" ry="168"
        fill="none" stroke="#ffffff08" stroke-width="2"/>

  <!-- Terminal angle bracket ">" on the left -->
  <polyline points="220,340 360,512 220,684"
            fill="none" stroke="#555555" stroke-width="48"
            stroke-linecap="round" stroke-linejoin="round"/>

  <!-- "Sn" text - the brand -->
  <text x="520" y="590" font-family="'SF Pro Display', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
        font-size="320" font-weight="700" letter-spacing="-8">
    <tspan fill="#ffffff">S</tspan><tspan fill="#555555">n</tspan>
  </text>

  <!-- Cursor line (blinking accent) -->
  <rect x="808" y="380" width="6" height="260" rx="3"
        fill="#666666"/>
</svg>
`;

async function generate() {
  console.log("Generating SnCode icons...");

  // Generate 1024x1024 PNG
  const png1024 = await sharp(Buffer.from(svg))
    .resize(1024, 1024)
    .png()
    .toBuffer();
  writeFileSync(join(buildDir, "icon.png"), png1024);
  console.log("  -> build/icon.png (1024x1024)");

  // Generate 512x512 PNG (for Linux)
  const png512 = await sharp(Buffer.from(svg))
    .resize(512, 512)
    .png()
    .toBuffer();
  writeFileSync(join(buildDir, "icon-512.png"), png512);
  console.log("  -> build/icon-512.png (512x512)");

  // Generate multiple sizes for ICO
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map((s) =>
      sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()
    )
  );

  // Write temp PNGs for ico generation, then create ICO
  const tempPngPaths = [];
  for (let i = 0; i < sizes.length; i++) {
    const p = join(buildDir, `_temp_${sizes[i]}.png`);
    writeFileSync(p, pngBuffers[i]);
    tempPngPaths.push(p);
  }

  const icoBuffer = await pngToIco(tempPngPaths);
  writeFileSync(join(buildDir, "icon.ico"), icoBuffer);
  console.log("  -> build/icon.ico (multi-size)");

  // Clean up temp files
  const { unlinkSync } = await import("fs");
  for (const p of tempPngPaths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }

  // Note: .icns generation requires platform-specific tools.
  // electron-builder can generate .icns from .png on macOS during packaging.
  // For CI, having icon.png is sufficient — electron-builder handles conversion.
  console.log("  -> build/icon.icns: skipped (electron-builder auto-generates from icon.png on macOS)");

  console.log("\nDone! Icons are in the build/ directory.");
}

generate().catch((err) => {
  console.error("Icon generation failed:", err);
  process.exit(1);
});
