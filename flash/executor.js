/**
 * executor.js
 * Core arbitrage execution orchestrator.
 *
 * Flow for each route from bot-routes.json:
 *  1. Pre-flight: verify profit still exceeds fee + tip threshold
 *  2. Resolve on-chain data (reserve supply vault, user ATAs)
 *  3. Build Orca swap instructions
 *  4. Wrap in Kamino flashloan sandwich
 *  5. Simulate — abort if sim fails
 *  6. If DRY_RUN=true, stop here
 *  7. Submit via Jito bundle
 *  8. Poll for landing, log result
 */

import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';

import {
    connection,
    payerKeypair,
    KAMINO,
    MINTS,
    EXEC_CONFIG,
    JITO,
} from './config.js';

import {
    buildFlashloanSandwich,
    calcFlashloanFee,
    calcRepayAmount,
    fetchReserveSupplyVault,
} from './kamino.js';

import {
    buildTriangleSwapIxs,
    buildUserAtaMap,
    deriveAta,
} from './orca-swap-builder.js';

import {
    buildBundleTransaction,
    simulateTransaction,
    submitBundle,
    waitForBundle,
    getTipPercentiles,
} from './jito.js';

// ── Profit gating ─────────────────────────────────────────────────────────────

/**
 * Calculate net profit after Kamino fee and Jito tip.
 *
 * @param {bigint} grossProfitLamports – (output - input) from simulation
 * @param {bigint} borrowAmount        – flashloan amount
 * @param {bigint} tipLamports
 * @returns {bigint} net profit (may be negative)
 */
function calcNetProfit(grossProfitLamports, borrowAmount, tipLamports) {
    const flashFee = calcFlashloanFee(borrowAmount);
    return grossProfitLamports - flashFee - BigInt(tipLamports);
}

// ── ATA existence check ───────────────────────────────────────────────────────

/**
 * Return the list of mints whose ATAs don't yet exist on-chain.
 * You must create them before executing.
 */
async function findMissingAtas(ataMap) {
    const missing = [];
    const keys = Object.values(ataMap).map(k => new PublicKey(k));
    const infos = await connection.getMultipleAccountsInfo(keys);
    const mints = Object.keys(ataMap);
    for (let i = 0; i < mints.length; i++) {
        if (!infos[i]) missing.push(mints[i]);
    }
    return missing;
}

// ── Single route executor ─────────────────────────────────────────────────────

/**
 * Execute one arbitrage route end-to-end.
 *
 * @param {object} route         – one entry from bot-routes.json
 * @param {object[]} allPools    – enriched pool list (pools_enriched.json)
 * @param {object} [overrides]   – { slippageBps, tipLamports }
 * @returns {object}             – execution result
 */
export async function executeRoute(route, allPools, overrides = {}) {
    const startMs = Date.now();
    const label   = `[${route.path}]`;

    const slippageBps = overrides.slippageBps ?? EXEC_CONFIG.DEFAULT_SLIPPAGE_BPS;
    const tipLamports = BigInt(overrides.tipLamports ?? JITO.TIP_LAMPORTS);

    console.log(`\n${label} 🚀 Starting execution`);
    console.log(`  Input:     ${route.inputAmount} lamports`);
    console.log(`  Expected:  ${route.expectedOutput} lamports`);
    console.log(`  Profit:    ${route.profit} lamports (${route.profitBps} bps)`);

    // ── 1. Pre-flight profit gate ────────────────────────────────────────────
    const borrowAmount   = BigInt(route.inputAmount);
    const grossProfit    = BigInt(route.profit);
    const netProfit      = calcNetProfit(grossProfit, borrowAmount, tipLamports);
    const flashFee       = calcFlashloanFee(borrowAmount);

    console.log(`  Flash fee: ${flashFee} lamports`);
    console.log(`  Jito tip:  ${tipLamports} lamports`);
    console.log(`  Net profit: ${netProfit} lamports`);

    if (netProfit < EXEC_CONFIG.MIN_PROFIT_LAMPORTS) {
        const reason = `net profit ${netProfit} < threshold ${EXEC_CONFIG.MIN_PROFIT_LAMPORTS}`;
        console.log(`  ⛔ Skipping: ${reason}`);
        return { success: false, skipped: true, reason, path: route.path };
    }

    // ── 2. Resolve on-chain reserve supply vault ────────────────────────────
    let supplyVault;
    try {
        supplyVault = await fetchReserveSupplyVault(connection, KAMINO.RESERVES.SOL);
        console.log(`  Reserve supply vault: ${supplyVault.toBase58()}`);
    } catch (err) {
        return { success: false, error: `fetchReserveSupplyVault: ${err.message}`, path: route.path };
    }

    // ── 3. Build user ATA map ────────────────────────────────────────────────
    const ataMap = buildUserAtaMap(route, payerKeypair.publicKey);

    // Verify all ATAs exist
    const missingAtas = await findMissingAtas(ataMap);
    if (missingAtas.length > 0) {
        return {
            success: false,
            error:   `Missing ATAs for mints: ${missingAtas.join(', ')}. Create them first.`,
            path:    route.path,
        };
    }

    const wSolAta = deriveAta(payerKeypair.publicKey, MINTS.SOL);

    // ── 4. Build Orca swap instructions ─────────────────────────────────────
    let swapIxs;
    try {
        swapIxs = buildTriangleSwapIxs(
            route,
            allPools,
            ataMap,
            payerKeypair.publicKey,
            slippageBps
        );
        console.log(`  Built ${swapIxs.length} Orca swap instructions`);
    } catch (err) {
        return { success: false, error: `buildTriangleSwapIxs: ${err.message}`, path: route.path };
    }

    // ── 5. Wrap in Kamino flashloan sandwich ─────────────────────────────────
    const allIxs = buildFlashloanSandwich({
        amount:           borrowAmount,
        mint:             new PublicKey(MINTS.SOL),
        reserve:          KAMINO.RESERVES.SOL,
        supplyVault,
        userTokenAccount: wSolAta,
        userWallet:       payerKeypair.publicKey,
        swapIxs,
    });

    console.log(`  Total instructions: ${allIxs.length} (borrow + ${swapIxs.length} swaps + repay)`);

    // ── 6. Build transaction ─────────────────────────────────────────────────
    let transaction;
    try {
        transaction = await buildBundleTransaction({
            instructions:     allIxs,
            payer:            payerKeypair,
            connection,
            tipLamports:      Number(tipLamports),
        });
    } catch (err) {
        return { success: false, error: `buildBundleTransaction: ${err.message}`, path: route.path };
    }

    // ── 7. Simulate ──────────────────────────────────────────────────────────
    console.log(`  🧪 Simulating...`);
    const simResult = await simulateTransaction(connection, transaction);

    if (!simResult.success) {
        console.error(`  ❌ Simulation failed: ${simResult.error}`);
        if (simResult.logs?.length) {
            console.error('  Logs:');
            simResult.logs.slice(-15).forEach(l => console.error(`    ${l}`));
        }
        return {
            success: false,
            error:   `simulation: ${simResult.error}`,
            logs:    simResult.logs,
            path:    route.path,
        };
    }

    console.log(`  ✅ Simulation passed (${simResult.unitsConsumed?.toLocaleString()} CUs)`);

    // ── 8. Dry-run gate ──────────────────────────────────────────────────────
    if (EXEC_CONFIG.DRY_RUN) {
        console.log(`  🧪 DRY_RUN — not submitting`);
        return {
            success:      true,
            dryRun:       true,
            path:         route.path,
            netProfit:    netProfit.toString(),
            executionMs:  Date.now() - startMs,
        };
    }

    // ── 9. Submit via Jito ───────────────────────────────────────────────────
    console.log(`  📤 Submitting bundle to Jito...`);
    let bundleResult;
    try {
        bundleResult = await submitBundle(transaction);
        console.log(`  Bundle ID: ${bundleResult.bundleId}`);
        console.log(`  Signature: ${bundleResult.signatures[0]}`);
    } catch (err) {
        return { success: false, error: `submitBundle: ${err.message}`, path: route.path };
    }

    // ── 10. Wait for landing ─────────────────────────────────────────────────
    console.log(`  ⏳ Waiting for landing (${EXEC_CONFIG.BUNDLE_TIMEOUT_MS / 1000}s timeout)...`);
    const landing = await waitForBundle(bundleResult.bundleId);

    if (landing.status === 'landed') {
        console.log(`  🎯 Bundle landed in slot ${landing.landedSlot}!`);
        console.log(`  💰 Net profit: ${netProfit} lamports`);
    } else {
        console.log(`  ⚠️  Bundle status: ${landing.status}`);
    }

    return {
        success:     landing.status === 'landed',
        bundleId:    bundleResult.bundleId,
        signatures:  bundleResult.signatures,
        netProfit:   netProfit.toString(),
        landedSlot:  landing.landedSlot,
        status:      landing.status,
        path:        route.path,
        executionMs: Date.now() - startMs,
    };
}

// ── Multi-route runner ────────────────────────────────────────────────────────

/**
 * Execute all routes from bot-routes.json in priority order.
 * Stops after the first successful execution (avoids double-spend).
 *
 * @param {string} botRoutesPath   – path to bot-routes.json
 * @param {string} poolsPath       – path to pools_enriched.json
 * @param {object} [overrides]
 */
export async function runBotRoutes(botRoutesPath, poolsPath, overrides = {}) {
    console.log('\n🤖 Flashloan Arbitrage Executor');
    console.log('================================');
    console.log(`Routes file: ${botRoutesPath}`);
    console.log(`Pools file:  ${poolsPath}`);
    console.log(`Dry run:     ${EXEC_CONFIG.DRY_RUN}`);
    console.log(`Min profit:  ${EXEC_CONFIG.MIN_PROFIT_LAMPORTS} lamports`);

    // Load files
    const botData   = JSON.parse(fs.readFileSync(botRoutesPath, 'utf8'));
    const allPools  = JSON.parse(fs.readFileSync(poolsPath, 'utf8'));
    const routes    = botData.routes || [];

    if (routes.length === 0) {
        console.log('\n⚠️  No profitable routes in file');
        return { executed: 0 };
    }

    // Fetch current Jito tip percentiles
    const tips = await getTipPercentiles();
    const chosenTip = overrides.tipLamports ?? tips.p75; // competitive but not extreme
    console.log(`\nJito tip: ${chosenTip} lamports (p75 = ${tips.p75})`);
    overrides.tipLamports = chosenTip;

    console.log(`\nAttempting ${routes.length} routes...`);

    const results = [];
    for (const route of routes) {
        const result = await executeRoute(route, allPools, overrides);
        results.push(result);

        // Stop after a successful non-dry-run execution
        if (result.success && !result.dryRun) {
            console.log('\n✅ Route executed successfully — stopping');
            break;
        }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success && !r.skipped).length;
    const skipped   = results.filter(r => r.skipped).length;

    console.log(`\n📊 Results: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`);

    return { executed: results.length, succeeded, failed, skipped, results };
}
