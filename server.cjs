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
                        useWordEpd: false,
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
