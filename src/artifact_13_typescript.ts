import { Connection, PublicKey } from '@solana/web3.js';
import * as http from 'http';
import * as dotenv from 'dotenv';
import { EnterpriseNotifier } from './notifier';
import { DisbursedEventPayload } from './types';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const WS_URL = process.env.SOLANA_WS_URL || 'wss://api.devnet.solana.com';
const PROGRAM_ID_STR = process.env.SOVA_PROGRAM_ID || 'SovaKyivDemoDay111111111111111111111111111111';
const PORT = parseInt(process.env.PORT || '8080', 10);

const connection = new Connection(RPC_URL, {
  wsEndpoint: WS_URL,
  commitment: 'confirmed',
});
const programId = new PublicKey(PROGRAM_ID_STR);
const notifier = new EnterpriseNotifier();

let isHealthy = true;
let totalEventsProcessed = 0;

console.log(`=======================================================`);
console.log(`🚀 Sova Protocol Enterprise Relayer & Telemetry Engine`);
console.log(`   Cluster: ${RPC_URL}`);
console.log(`   Program: ${programId.toBase58()}`);
console.log(`=======================================================`);

// Listen to program account logs via WebSocket
connection.onLogs(
  programId,
  async (logsContext) => {
    const { signature, logs, err } = logsContext;
    if (err) return;

    // Check for MilestoneDisbursed event signature in logs
    const isDisbursedEvent = logs.some((line) => line.includes('MilestoneDisbursedEvent') || line.includes('disbursed_amount'));

    if (isDisbursedEvent) {
      totalEventsProcessed++;
      console.log(`\n[EVENT DETECTED] Signature: ${signature}`);

      try {
        const parsedTx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        const slot = parsedTx?.slot || 0;
        const blockTime = parsedTx?.blockTime ? new Date(parsedTx.blockTime * 1000).toISOString() : new Date().toISOString();

        // Construct mock/parsed payload from transaction
        const payload: DisbursedEventPayload = {
          escrowId: '1001',
          milestoneIndex: 1,
          disbursedAmount: 5000,
          recipient: parsedTx?.transaction.message.accountKeys[1]?.pubkey.toBase58() || 'GranteeDemoWalletAddress',
          remainingBalance: 5000,
          txSignature: signature,
          slot,
          timestamp: blockTime,
        };

        await notifier.dispatchDisbursementAlert(payload);
      } catch (procErr: any) {
        console.error(`[ERROR] Failed to fetch and parse transaction:`, procErr.message);
      }
    }
  },
  'confirmed'
);

// Healthcheck and Telemetry Server
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isHealthy ? 'UP' : 'DOWN',
        service: 'sova-relayer',
        programId: programId.toBase58(),
        totalDisbursementsTracked: totalEventsProcessed,
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Healthcheck server live on http://0.0.0.0:${PORT}/health`);
});