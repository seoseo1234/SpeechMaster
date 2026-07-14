const { Jimp, rgbaToInt, intToRGBA } = require('jimp');

async function processImage(inputPath, outputPath) {
  try {
    const image = await Jimp.read(inputPath);
    const w = image.bitmap.width;
    const h = image.bitmap.height;

    // Use a queue for flood fill to remove contiguous white background starting from the edges
    const visited = new Set();
    const queue = [];

    // Push edge pixels to queue
    for (let x = 0; x < w; x++) {
      queue.push([x, 0]);
      queue.push([x, h - 1]);
    }
    for (let y = 0; y < h; y++) {
      queue.push([0, y]);
      queue.push([w - 1, y]);
    }

    const isWhite = (r, g, b) => r > 240 && g > 240 && b > 240;
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

      if (isWhite(rgba.r, rgba.g, rgba.b)) {
        // Set transparent
        image.setPixelColor(rgbaToInt(255, 255, 255, 0), x, y);

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

const cloudSrc = 'C:\\Users\\user\\.gemini\\antigravity-ide\\brain\\2cecdbcc-3710-4270-81cd-9df2370edf7e\\cloud_solid_1784033096474.png';
const starSrc = 'C:\\Users\\user\\.gemini\\antigravity-ide\\brain\\2cecdbcc-3710-4270-81cd-9df2370edf7e\\star_solid_1784033111059.png';

processImage(cloudSrc, 'public/cloud_fairy.png').then(() => {
  processImage(starSrc, 'public/star_fairy.png');
});
