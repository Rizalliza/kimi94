/**
 * jito.js
 * Jito bundle construction, submission and status tracking.
 *
 * A Jito bundle = up to 5 transactions submitted atomically to a block engine.
 * We always use a single transaction (the full flashloan arbitrage).
 *
 * Tip mechanics:
 *   - One of the tip accounts must receive a SOL transfer inside the transaction.
 *   - Tip goes at the END of the instruction list (post-execution validation).
 *   - Minimum competitive tip varies; use getTipPercentiles() at startup.
 */

import {
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { JITO, EXEC_CONFIG, getRandomTipAccount } from './config.js';

// ── Bundle builder ────────────────────────────────────────────────────────────

/**
 * Build a signed versioned transaction wrapping your instructions.
 *
 * @param {object} opts
 * @param {TransactionInstruction[]} opts.instructions  – inner instructions (no budget/tip)
 * @param {Keypair}   opts.payer              – signing keypair
 * @param {Connection} opts.connection
 * @param {number}    opts.computeUnitLimit   – default 1_400_000
 * @param {number}    opts.computeUnitPrice   – micro-lamports priority fee
 * @param {number}    opts.tipLamports        – Jito tip amount
 * @param {AddressLookupTableAccount[]} [opts.lookupTables]
 * @returns {Promise<VersionedTransaction>}
 */
export async function buildBundleTransaction({
    instructions,
    payer,
    connection,
    computeUnitLimit  = EXEC_CONFIG.COMPUTE_UNIT_LIMIT,
    computeUnitPrice  = EXEC_CONFIG.COMPUTE_UNIT_PRICE,
    tipLamports       = JITO.TIP_LAMPORTS,
    lookupTables      = [],
}) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tipAccount = getRandomTipAccount();

    const allIxs = [
        // Compute budget — must come first
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),

        // Your instructions (flashloan sandwich + swaps)
        ...instructions,

        // Jito tip at the end
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey:   tipAccount,
            lamports:   tipLamports,
        }),
    ];

    const message = new TransactionMessage({
        payerKey:       payer.publicKey,
        recentBlockhash: blockhash,
        instructions:   allIxs,
    }).compileToV0Message(lookupTables);

    const tx = new VersionedTransaction(message);
    tx.sign([payer]);

    // Guard: Solana max transaction size is 1232 bytes
    const size = tx.serialize().length;
    if (size > 1232) {
        throw new Error(`Transaction too large: ${size} bytes (max 1232). Reduce accounts or use ALT.`);
    }

    return tx;
}

// ── Simulation ────────────────────────────────────────────────────────────────

/**
 * Simulate the transaction before submitting.
 * Returns { success, logs, unitsConsumed, error }.
 */
export async function simulateTransaction(connection, transaction) {
    const sim = await connection.simulateTransaction(transaction, {
        sigVerify:   false,
        commitment:  'confirmed',
    });

    if (sim.value.err) {
        return {
            success:       false,
            logs:          sim.value.logs || [],
            unitsConsumed: sim.value.unitsConsumed,
            error:         JSON.stringify(sim.value.err),
        };
    }

    return {
        success:       true,
        logs:          sim.value.logs || [],
        unitsConsumed: sim.value.unitsConsumed,
    };
}

// ── Bundle submission ─────────────────────────────────────────────────────────

/**
 * Submit a single transaction as a Jito bundle.
 * Returns { bundleId, signatures } or throws on error.
 */
export async function submitBundle(transaction) {
    const serialized = bs58.encode(transaction.serialize());

    const body = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sendBundle',
        params: [[serialized]],
    };

    const resp = await fetch(`${JITO.BLOCK_ENGINE_URL}/api/v1/bundles`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Jito HTTP ${resp.status}: ${text}`);
    }

    const json = await resp.json();
    if (json.error) throw new Error(`Jito RPC error: ${json.error.message}`);

    const bundleId = json.result;
    const sig = bs58.encode(transaction.signatures[0]);
    return { bundleId, signatures: [sig] };
}

// ── Status polling ────────────────────────────────────────────────────────────

/**
 * Poll Jito for bundle status until landed / failed / timeout.
 * Returns { status: 'landed' | 'failed' | 'timeout', landedSlot? }
 */
export async function waitForBundle(bundleId, timeoutMs = EXEC_CONFIG.BUNDLE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await sleep(500);

        try {
            const resp = await fetch(`${JITO.BLOCK_ENGINE_URL}/api/v1/bundles`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    jsonrpc: '2.0',
                    id:      Date.now(),
                    method:  'getBundleStatuses',
                    params:  [[bundleId]],
                }),
            });

            const json = await resp.json();
            const entry = json.result?.value?.[0];
            if (!entry) continue;

            if (entry.confirmation_status === 'confirmed' || entry.confirmation_status === 'finalized') {
                return { status: 'landed', landedSlot: entry.slot };
            }
            if (entry.err) {
                return { status: 'failed', error: JSON.stringify(entry.err) };
            }
        } catch { /* transient network error, retry */ }
    }

    return { status: 'timeout' };
}

// ── Tip percentile fetcher ────────────────────────────────────────────────────

/**
 * Fetch current tip percentiles from Jito to calibrate tipLamports.
 * Returns { p25, p50, p75, p95 } in lamports, or defaults on failure.
 */
export async function getTipPercentiles() {
    try {
        const resp = await fetch(`${JITO.BLOCK_ENGINE_URL}/api/v1/bundles/tip_percentiles`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return {
            p25: data.p25  || 5_000,
            p50: data.p50  || 10_000,
            p75: data.p75  || 50_000,
            p95: data.p95  || 200_000,
        };
    } catch {
        // Return conservative defaults
        return { p25: 5_000, p50: 10_000, p75: 50_000, p95: 200_000 };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
