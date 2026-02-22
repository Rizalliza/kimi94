/**
 * config.js
 * Central configuration for the flashloan arbitrage system.
 * Reads environment variables from .env, exports typed constants.
 *
 * Required .env keys:
 *   RPC_URL          – Helius / QuickNode mainnet RPC
 *   WALLET_KEYPAIR   – JSON array of secret key bytes  (or path to keypair file)
 *   JITO_BLOCK_ENGINE_URL  – e.g. https://ny.mainnet.block-engine.jito.wtf
 *   JITO_TIP_LAMPORTS      – integer, e.g. 10000
 *
 * Optional:
 *   DRY_RUN=true     – simulate only, never submit
 *   MIN_PROFIT_LAMPORTS – override minimum profit threshold
 */

import 'dotenv/config';
import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// ── RPC ─────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error('❌ RPC_URL must be set in .env');

export const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
    confirmTransactionInitialTimeout: 60_000,
});

// ── Wallet ───────────────────────────────────────────────────────────────────

function loadKeypair() {
    const raw = process.env.WALLET_KEYPAIR;
    if (!raw) throw new Error('❌ WALLET_KEYPAIR must be set in .env');

    // Support path to file or inline JSON array
    if (raw.trim().startsWith('[')) {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    // Treat as filepath
    const data = JSON.parse(fs.readFileSync(raw.trim(), 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(data));
}

export const payerKeypair = loadKeypair();

// ── Program IDs ──────────────────────────────────────────────────────────────

export const PROGRAM_IDS = {
    KAMINO_LENDING: new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
    ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
    RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
    RAYDIUM_CPMM: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
    METEORA_DLMM: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
    TOKEN_PROGRAM: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    TOKEN_2022: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
    ASSOC_TOKEN: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    MEMO_PROGRAM: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    SYS_INSTRUCTIONS: new PublicKey('Sysvar1nstructions1111111111111111111111111'),
};

// ── Token Mints ──────────────────────────────────────────────────────────────

export const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112', // wSOL for SPL purposes
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    jitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    mSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    bSOL: 'bSo13r4TkiE4xumBLjQN9VHqjAvcrWujNpKD4xbD5VR',
};

// ── Kamino Mainnet Market Addresses ──────────────────────────────────────────
// Source: https://app.kamino.finance / klend-sdk

export const KAMINO = {
    // Main Kamino market (flagship)
    MAIN_MARKET: new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'),

    // Reserves in the main market (needed for flashloan accounts)
    RESERVES: {
        SOL: new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bJ2L7xFNewFSPe'),
        USDC: new PublicKey('9TD2TSv4pENb8VwfbVYg25jvym7HN6iuAR6pFNSrKjqQ'),
        USDT: new PublicKey('H9yMPYBXQHxYCyGwzwHnXVFSBGnNMJT5bRBqBhBpJVRj'),
    },
};

// ── Jito Configuration ───────────────────────────────────────────────────────

export const JITO = {
    BLOCK_ENGINE_URL: process.env.JITO_BLOCK_ENGINE_URL
        || 'https://ny.mainnet.block-engine.jito.wtf',
    TIP_LAMPORTS: Number(process.env.JITO_TIP_LAMPORTS || 10_000),

    // Verified Jito tip accounts (select one randomly per bundle)
    TIP_ACCOUNTS: [
        '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
        'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
        'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
        'ADaUMid9yfUytqMBgopwjb2DTLSoknLAgJUuh2UHUd4X',
        'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
        '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    ],
};

export function getRandomTipAccount() {
    const i = Math.floor(Math.random() * JITO.TIP_ACCOUNTS.length);
    return new PublicKey(JITO.TIP_ACCOUNTS[i]);
}

// ── Execution Config ─────────────────────────────────────────────────────────

export const EXEC_CONFIG = {
    DRY_RUN: process.env.DRY_RUN === 'true',

    // Kamino flashloan fee: 9 bps (0.09%)
    KAMINO_FEE_BPS: 9n,

    // Minimum net profit (after fee + tip) to execute — in lamports
    MIN_PROFIT_LAMPORTS: BigInt(process.env.MIN_PROFIT_LAMPORTS || 50_000),

    // Default slippage when building swap instructions
    DEFAULT_SLIPPAGE_BPS: 20, // 0.2%

    // Compute budget
    COMPUTE_UNIT_LIMIT: 1_400_000,
    COMPUTE_UNIT_PRICE: 100_000, // micro-lamports (priority fee)

    // Max wait time for bundle landing
    BUNDLE_TIMEOUT_MS: 30_000,
};
