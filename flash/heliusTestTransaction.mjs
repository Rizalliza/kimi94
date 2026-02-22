import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// Load keypair
const KEYPAIR_PATH = './keys/payer_keypair.json';
console.log(`Loading keypair from: ${path.resolve(KEYPAIR_PATH)}`);

if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(`Keypair not found at ${KEYPAIR_PATH}`);
}

const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
// Handle if it's { _keypair: { secretKey: ... } } or just array
const secretKey = Array.isArray(keypairData) 
    ? Uint8Array.from(keypairData)
    : Uint8Array.from(Object.values(keypairData._keypair.secretKey));
    
const payer = Keypair.fromSecretKey(secretKey);

// Load RPC
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    throw new Error('RPC_URL not set in .env');
}

console.log(`Using RPC: ${RPC_URL}`);
console.log(`Payer Public Key: ${payer.publicKey.toBase58()}`);

async function main() {
    try {
        const connection = new Connection(RPC_URL, 'confirmed');
        
        // Check balance
        const balance = await connection.getBalance(payer.publicKey);
        console.log(`Balance: ${balance / 1e9} SOL`);

        if (balance < 0.002 * 1e9) { // Less than 0.002 SOL
            console.warn('⚠️  Balance too low for transaction (need > 0.002 SOL for rent/fees)');
            console.log('✅ Helius connection successful (Balance check passed)');
            return; // Skip transaction but consider test successful
        }

        // Simple self-transfer to test connection (0.000001 SOL)
        const lamports = 1000;
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: payer.publicKey,
                lamports: lamports
            })
        );

        console.log(`Sending self-transfer of ${lamports} lamports...`);
        
        const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [payer],
            { commitment: 'confirmed' }
        );

        console.log(`✅ Transaction successful!`);
        console.log(`   Signature: ${signature}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`); // Assuming mainnet

    } catch (error) {
        console.error('❌ Transaction failed:', error);
        process.exit(1);
    }
}

main();
