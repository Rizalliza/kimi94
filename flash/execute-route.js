#!/usr/bin/env node
/**
 * execute-route.js
 * CLI entry point for the flashloan arbitrage system.
 *
 * Usage:
 *   node execute-route.js --routes ./results/bot-routes.json --pools ./results/pools_enriched.json
 *   node execute-route.js --routes ./results/bot-routes.json --pools ./results/pools_enriched.json --dry-run
 *   node execute-route.js --routes ./results/bot-routes.json --pools ./results/pools_enriched.json --slippage 75 --tip 25000
 *
 * Environment (.env):
 *   RPC_URL               Helius / QuickNode mainnet
 *   WALLET_KEYPAIR        JSON array of secret key bytes (or path to file)
 *   JITO_BLOCK_ENGINE_URL https://ny.mainnet.block-engine.jito.wtf
 *   JITO_TIP_LAMPORTS     10000
 *   DRY_RUN               true  (or pass --dry-run flag)
 *   MIN_PROFIT_LAMPORTS   50000
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBotRoutes, executeRoute } from './executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argument parser ───────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--routes'   && argv[i + 1]) { args.routes   = argv[++i]; }
        if (a === '--pools'    && argv[i + 1]) { args.pools    = argv[++i]; }
        if (a === '--slippage' && argv[i + 1]) { args.slippage = Number(argv[++i]); }
        if (a === '--tip'      && argv[i + 1]) { args.tip      = Number(argv[++i]); }
        if (a === '--dry-run')                  { args.dryRun  = true; }
        if (a === '--route-index' && argv[i+1]) { args.routeIndex = Number(argv[++i]); }
    }
    return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));

    // Apply CLI dry-run override
    if (args.dryRun) process.env.DRY_RUN = 'true';

    const routesFile = args.routes || path.join(__dirname, '..', 'results', 'bot-routes.json');
    const poolsFile  = args.pools  || path.join(__dirname, '..', 'pools_enriched.json');

    // Validate files exist
    for (const [label, file] of [['Routes', routesFile], ['Pools', poolsFile]]) {
        if (!fs.existsSync(file)) {
            console.error(`❌ ${label} file not found: ${file}`);
            console.error('   Run the pipeline first: node master-pipeline.js');
            process.exit(1);
        }
    }

    const overrides = {};
    if (args.slippage) overrides.slippageBps = args.slippage;
    if (args.tip)      overrides.tipLamports = args.tip;

    // Mode: single route by index, or all routes
    if (args.routeIndex !== undefined) {
        const botData = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
        const allPools = JSON.parse(fs.readFileSync(poolsFile, 'utf8'));
        const route = botData.routes?.[args.routeIndex];
        if (!route) {
            console.error(`❌ Route index ${args.routeIndex} not found in ${routesFile}`);
            process.exit(1);
        }
        const result = await executeRoute(route, allPools, overrides);
        printResult(result);
        process.exit(result.success ? 0 : 1);
    }

    // Default: run all routes
    const summary = await runBotRoutes(routesFile, poolsFile, overrides);

    console.log('\n============================');
    console.log('📊 Session Summary');
    console.log('============================');
    console.log(`Routes attempted: ${summary.executed}`);
    console.log(`Succeeded:        ${summary.succeeded}`);
    console.log(`Failed:           ${summary.failed}`);
    console.log(`Skipped:          ${summary.skipped}`);

    if (summary.results) {
        const profitable = summary.results.filter(r => r.success && r.netProfit);
        if (profitable.length > 0) {
            const totalProfit = profitable.reduce((s, r) => s + BigInt(r.netProfit || 0), 0n);
            console.log(`Total net profit: ${totalProfit} lamports`);
        }
    }

    process.exit(summary.succeeded > 0 ? 0 : 1);
}

function printResult(result) {
    console.log('\n============================');
    console.log('📊 Execution Result');
    console.log('============================');
    console.log(`Path:       ${result.path}`);
    console.log(`Status:     ${result.success ? (result.dryRun ? '✅ DRY RUN' : '✅ SUCCESS') : '❌ FAILED'}`);
    if (result.bundleId)   console.log(`Bundle ID:  ${result.bundleId}`);
    if (result.signatures) console.log(`Signature:  ${result.signatures[0]}`);
    if (result.netProfit)  console.log(`Net profit: ${result.netProfit} lamports`);
    if (result.landedSlot) console.log(`Landed:     slot ${result.landedSlot}`);
    if (result.error)      console.log(`Error:      ${result.error}`);
    if (result.executionMs) console.log(`Time:       ${result.executionMs}ms`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => {
        console.error('💥 Fatal error:', err);
        process.exit(1);
    });
}

export { main };
