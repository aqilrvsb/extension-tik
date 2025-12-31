const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawFireIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Create gradient background (dark blue)
  const bgGradient = ctx.createLinearGradient(0, 0, size, size);
  bgGradient.addColorStop(0, '#1a1a2e');
  bgGradient.addColorStop(1, '#16213e');

  // Draw rounded rectangle background
  const radius = size * 0.2;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, radius);
  ctx.fillStyle = bgGradient;
  ctx.fill();

  // Draw fire/flame
  const centerX = size / 2;
  const flameBottom = size * 0.85;
  const flameTop = size * 0.12;
  const flameWidth = size * 0.35;

  // Outer flame (orange/red gradient)
  const outerGradient = ctx.createLinearGradient(centerX, flameBottom, centerX, flameTop);
  outerGradient.addColorStop(0, '#ff4500');  // OrangeRed at bottom
  outerGradient.addColorStop(0.3, '#ff6b35');
  outerGradient.addColorStop(0.6, '#ff8c42');
  outerGradient.addColorStop(0.8, '#ffa500');
  outerGradient.addColorStop(1, '#ffcc00');  // Yellow at top

  ctx.beginPath();
  ctx.moveTo(centerX, flameBottom);

  // Left side of flame with wavy pattern
  ctx.quadraticCurveTo(
    centerX - flameWidth * 1.3, flameBottom - size * 0.2,
    centerX - flameWidth * 0.9, flameBottom - size * 0.35
  );
  ctx.quadraticCurveTo(
    centerX - flameWidth * 0.4, flameBottom - size * 0.45,
    centerX - flameWidth * 0.8, flameBottom - size * 0.52
  );
  ctx.quadraticCurveTo(
    centerX - flameWidth * 0.35, flameBottom - size * 0.62,
    centerX, flameTop
  );

  // Right side of flame (mirror)
  ctx.quadraticCurveTo(
    centerX + flameWidth * 0.35, flameBottom - size * 0.62,
    centerX + flameWidth * 0.8, flameBottom - size * 0.52
  );
  ctx.quadraticCurveTo(
    centerX + flameWidth * 0.4, flameBottom - size * 0.45,
    centerX + flameWidth * 0.9, flameBottom - size * 0.35
  );
  ctx.quadraticCurveTo(
    centerX + flameWidth * 1.3, flameBottom - size * 0.2,
    centerX, flameBottom
  );

  ctx.fillStyle = outerGradient;
  ctx.fill();

  // Inner flame (yellow/white hot core)
  const innerGradient = ctx.createLinearGradient(
    centerX, flameBottom - size * 0.1,
    centerX, flameBottom - size * 0.5
  );
  innerGradient.addColorStop(0, '#ffffff');  // White at bottom
  innerGradient.addColorStop(0.3, '#fffacd'); // Lemon chiffon
  innerGradient.addColorStop(0.6, '#ffeb3b'); // Yellow
  innerGradient.addColorStop(1, '#ffa000');   // Amber at top

  const innerWidth = flameWidth * 0.45;
  const innerBottom = flameBottom - size * 0.12;
  const innerTop = flameBottom - size * 0.42;

  ctx.beginPath();
  ctx.moveTo(centerX, innerBottom);
  ctx.quadraticCurveTo(
    centerX - innerWidth, innerBottom - size * 0.12,
    centerX, innerTop
  );
  ctx.quadraticCurveTo(
    centerX + innerWidth, innerBottom - size * 0.12,
    centerX, innerBottom
  );
  ctx.fillStyle = innerGradient;
  ctx.fill();

  return canvas;
}

// Generate icons
const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

// Ensure icons directory exists
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

sizes.forEach(size => {
  const canvas = drawFireIcon(size);
  const buffer = canvas.toBuffer('image/png');
  const filename = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filename, buffer);
  console.log(`Generated: ${filename}`);
});

console.log('\nFire icons generated successfully!');
