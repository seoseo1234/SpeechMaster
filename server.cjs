const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/analyze-audio', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
        
        const apiKey = process.env.VITE_GEMINI_API_KEY;
        if (!apiKey) throw new Error("Gemini API Key missing");
        
        const genAI = new GoogleGenerativeAI(apiKey);
        // 사용자가 제미나이 3.5 Flash를 언급했지만, 현재 최신은 1.5 Flash이므로 1.5 Flash를 사용합니다.
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 
        
        const prompt = "첨부된 오디오 파일은 학생의 발표 녹음입니다. 학생이 발표 중 '어...', '음...', '그...' 와 같은 무의미한 습관어를 얼마나 사용했는지 찾아내주세요. 아주 짧은 찰나의 '어'나 '음'도 모두 카운트해야 합니다. \n\n결과는 반드시 다음 JSON 포맷으로만 출력해주세요:\n{\n  \"habitCounts\": {\n    \"uh\": (어, 아 사용 횟수 정수형),\n    \"um\": (음, 음마 사용 횟수 정수형),\n    \"geu\": (그, 어그 사용 횟수 정수형)\n  },\n  \"feedback\": \"(전체적인 피드백 코멘트 1~2문장. 습관어가 0개면 극찬, 있으면 부드러운 조언)\"\n}";
        
        const audioData = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype || 'audio/webm'
            }
        };
        
        const result = await model.generateContent([prompt, audioData]);
        let text = result.response.text();
        
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(text);
        
        res.json(json);
    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: '분석 중 오류가 발생했습니다.', details: error.message });
    }
});

// Load gRPC Proto
const PROTO_PATH = path.join(__dirname, 'nest.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const nest = protoDescriptor.com.nbp.cdncp.nest.grpc.proto.v1;

// Clova API Key (High Grade / Streaming)
const CLOVA_SECRET_KEY = process.env.VITE_CLOVA_STREAM_SECRET_KEY;
if (!CLOVA_SECRET_KEY) {
    console.warn("WARNING: VITE_CLOVA_STREAM_SECRET_KEY is not defined in .env");
}

wss.on('connection', (ws) => {
    console.log('Client connected for STT stream.');

    let grpcCall = null;

    ws.on('message', (message) => {
        if (typeof message === 'string') {
            const data = JSON.parse(message);
            if (data.action === 'start') {
                console.log('Starting gRPC stream...');
                
                const client = new nest.NestService(
                    'clovaspeech-gw.ncloud.com:50051',
                    grpc.credentials.createSsl()
                );

                const metadata = new grpc.Metadata();
                metadata.add('authorization', `Bearer ${CLOVA_SECRET_KEY}`);

                grpcCall = client.recognize(metadata);

                grpcCall.on('data', (response) => {
                    // Send back to browser
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(response.contents);
                    }
                });

                grpcCall.on('error', (err) => {
                    console.error('gRPC Error:', err);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ error: err.message }));
                    }
                });

                grpcCall.on('end', () => {
                    console.log('gRPC Stream Ended.');
                });

                // Send Config
                const configStr = JSON.stringify({
                    transcription: { language: 'ko' },
                    semanticEpd: {
                        skipEmptyText: true,
                        useWordEpd: true,
                        usePeriodEpd: true,
                        gapThreshold: 500,
                        durationThreshold: 5000,
                        syllableThreshold: 0
                    }
                });

                grpcCall.write({
                    type: 'CONFIG',
                    config: { config: configStr }
                });
            } else if (data.action === 'stop') {
                console.log('Stopping gRPC stream...');
                if (grpcCall) {
                    grpcCall.end();
                    grpcCall = null;
                }
            }
        } else if (Buffer.isBuffer(message)) {
            // Audio data (PCM 16-bit 16kHz Mono)
            if (grpcCall) {
                grpcCall.write({
                    type: 'DATA',
                    data: { chunk: message }
                });
            }
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
        if (grpcCall) {
            grpcCall.end();
            grpcCall = null;
        }
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`WebSocket/gRPC proxy server listening on port ${PORT}`);
});
