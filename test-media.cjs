require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const client = new GoogleGenAI({apiKey: process.env.VITE_GEMINI_API_KEY});

async function run() {
  try {
    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        "What is this?",
        {
          inlineData: {
            data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
            mimeType: "audio/wav"
          }
        }
      ]
    });
    console.log(response.text);
  } catch(e) {
    console.error("Error:", e);
  }
}
run();
