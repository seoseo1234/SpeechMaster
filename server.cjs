const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenAI } = require("@google/genai");
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const upload = multer({ storage: multer.memoryStorage() });

app.post('/analyze-audio', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
        
        const avgTone = req.body.avgTone || '정보 없음';
        const avgSpeed = req.body.avgSpeed || '정보 없음';
        const avgShaking = req.body.avgShaking || '정보 없음';
        const gazeScore = req.body.gazeScore || '정보 없음';

        const apiKey = process.env.VITE_GEMINI_API_KEY;
        if (!apiKey) throw new Error("Gemini API Key missing");
        
        const client = new GoogleGenAI({ apiKey });
        
        // 제미나이 3.5 Flash 호출
        const prompt = `첨부된 오디오 파일은 학생의 발표 녹음입니다. 
다음은 발표 중에 수집된 실시간 트래킹 데이터입니다:
- 평균 목소리 톤 (0~255 수치): ${avgTone}
- 평균 말하기 속도: ${avgSpeed}
- 자세 불안정성 (흔들림 점수, 낮을수록 좋음): ${avgShaking}
- 정면 주시(시선 처리) 비율 (%): ${gazeScore}

학생이 발표 중 '어...', '음...', '그...' 와 같은 무의미한 습관어를 얼마나 사용했는지 오디오에서 찾아내주세요. 아주 짧은 찰나의 '어'나 '음'도 모두 카운트해야 합니다. 

결과는 반드시 다음 JSON 포맷으로만 출력해주세요:
{
  "habitCounts": {
    "uh": (어, 아 사용 횟수 정수형),
    "um": (음, 음마 사용 횟수 정수형),
    "geu": (그, 어그 사용 횟수 정수형)
  },
  "feedback": "(트래킹 데이터와 발표 내용, 습관어 사용을 모두 종합하여 목소리의 크기/톤, 속도, 발표자세, 시선처리 등에 대한 매우 구체적이고 종합적인 피드백 코멘트를 3~4문장으로 작성해주세요. 수집된 데이터를 직접 언급하며 분석적인 조언을 제공해야 합니다.)"
}`;
        
        const audioData = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype || 'audio/webm'
            }
        };

        // 사용자의 요청에 따라 제미나이 3.5 Flash 모델만을 엄격하게 사용합니다.
        const response = await client.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [prompt, audioData]
        });
        
        let text = response.text;
        
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
