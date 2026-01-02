/**
 * Build script for TikTok Order Exporter Extension
 * Creates obfuscated version in /dist folder
 */

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// Files to obfuscate
const jsFiles = ['background.js', 'content.js', 'popup.js'];

// Files to copy as-is
const copyFiles = [
  'manifest.json',
  'popup.html',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'lib/xlsx.full.min.js'
];

// Obfuscation options - strong protection
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
};

// Create dist directory
const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Create subdirectories
const iconsDir = path.join(distDir, 'icons');
const libDir = path.join(distDir, 'lib');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });

console.log('Building obfuscated extension...\n');

// Obfuscate JS files
jsFiles.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    console.log(`Obfuscating ${file}...`);
    const code = fs.readFileSync(filePath, 'utf8');

    try {
      const obfuscatedCode = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
      fs.writeFileSync(path.join(distDir, file), obfuscatedCode.getObfuscatedCode());

      // Show size comparison
      const originalSize = Buffer.byteLength(code, 'utf8');
      const obfuscatedSize = Buffer.byteLength(obfuscatedCode.getObfuscatedCode(), 'utf8');
      console.log(`  Original: ${(originalSize / 1024).toFixed(1)}KB -> Obfuscated: ${(obfuscatedSize / 1024).toFixed(1)}KB`);
    } catch (error) {
      console.error(`  Error obfuscating ${file}:`, error.message);
    }
  } else {
    console.log(`  Warning: ${file} not found`);
  }
});

console.log('');

// Copy other files
copyFiles.forEach(file => {
  const srcPath = path.join(__dirname, file);
  const destPath = path.join(distDir, file);

  if (fs.existsSync(srcPath)) {
    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied ${file}`);
  } else {
    console.log(`Warning: ${file} not found`);
  }
});

console.log('\n========================================');
console.log('Build complete!');
console.log('Obfuscated extension is in: ./dist/');
console.log('========================================\n');
