require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const client = new GoogleGenAI({apiKey: process.env.VITE_GEMINI_API_KEY});

async function run() {
  try {
    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: 'Explain who you are in one sentence.'
    });
    console.log(response.text);
  } catch(e) {
    console.error("Error with GenerateContent:", e);
  }

  try {
    const interaction = await client.interactions.create({
      model: "gemini-3.5-flash",
      input: "Explain how parallel agentic execution works in three sentences.",
    });
    console.log("Interaction text:", interaction.output_text);
  } catch(e) {
    console.error("Error with interactions:", e);
  }
}
run();
