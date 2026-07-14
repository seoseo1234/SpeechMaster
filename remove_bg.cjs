const { Jimp, rgbaToInt, intToRGBA } = require('jimp');

async function processImage(inputPath, outputPath) {
  try {
    const image = await Jimp.read(inputPath);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    // Get background color from top-left pixel
    const bgHex = image.getPixelColor(0, 0);
    const bgRgba = intToRGBA(bgHex);

    const visited = new Set();
    const queue = [];

    for (let x = 0; x < w; x++) {
      queue.push([x, 0]);
      queue.push([x, h - 1]);
    }
    for (let y = 0; y < h; y++) {
      queue.push([0, y]);
      queue.push([w - 1, y]);
    }

    // Increased tolerance to catch gradients/compression artifacts in the background
    const tolerance = 60; 
    const isBg = (r, g, b) => {
      return Math.abs(r - bgRgba.r) < tolerance &&
             Math.abs(g - bgRgba.g) < tolerance &&
             Math.abs(b - bgRgba.b) < tolerance;
    };
    
    // Some models leave a slight edge, so we'll also replace pixels that are somewhat close
    const isEdgeBg = (r, g, b) => {
      return Math.abs(r - bgRgba.r) < tolerance * 1.5 &&
             Math.abs(g - bgRgba.g) < tolerance * 1.5 &&
             Math.abs(b - bgRgba.b) < tolerance * 1.5;
    };

    const getKey = (x, y) => `${x},${y}`;

    let head = 0;
    while (head < queue.length) {
      const [x, y] = queue[head++];
      if (x < 0 || x >= w || y < 0 || y >= h) continue;

      const key = getKey(x, y);
      if (visited.has(key)) continue;
      visited.add(key);

      const hex = image.getPixelColor(x, y);
      const rgba = intToRGBA(hex);

      if (isBg(rgba.r, rgba.g, rgba.b) || isEdgeBg(rgba.r, rgba.g, rgba.b)) {
        // Set transparent
        image.setPixelColor(rgbaToInt(0, 0, 0, 0), x, y);

        // Add neighbors
        queue.push([x + 1, y]);
        queue.push([x - 1, y]);
        queue.push([x, y + 1]);
        queue.push([x, y - 1]);
      }
    }

    await image.write(outputPath);
    console.log('Successfully processed ' + outputPath);
  } catch (err) {
    console.error(err);
  }
}

const cloudSrc = 'C:\\Users\\user\\.gemini\\antigravity-ide\\brain\\2cecdbcc-3710-4270-81cd-9df2370edf7e\\cloud_green_bg_1784033506615.png';
const starSrc = 'C:\\Users\\user\\.gemini\\antigravity-ide\\brain\\2cecdbcc-3710-4270-81cd-9df2370edf7e\\star_green_bg_1784033492276.png';

processImage(cloudSrc, 'public/cloud_fairy.png').then(() => {
  processImage(starSrc, 'public/star_fairy.png');
});
