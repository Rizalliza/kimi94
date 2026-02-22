#!/usr/bin/env node
/**
 * prepare-execution.js
 *
 * THE MISSING LINK in the pipeline.
 *
 * What this does:
 *   1. Reads ./results/bot-routes.json (written by master-pipeline.js Step 6)
 *   2. Applies hard filters to remove FAKE/corrupt routes (stale CLMM leg ratios)
 *   3. Keeps the top-5 genuine profitable routes above MIN_PROFIT_BPS
 *   4. Writes each as an individual ./routes/route_001.json ... route_005.json
 *      in the exact schema that execute-route.js expects
 *
 * execute-route.js then reads each file:
 *   node execute-route.js --route ./routes/route_001.json
 *
 * Or run all 5 automatically (see bottom of this file).
 *
 * Data flow:
 *   master-pipeline.js
 *     └─ ./results/bot-routes.json          ← Step 6 output
 *           └─ prepare-execution.js          ← THIS FILE
 *                 └─ ./routes/route_00N.json ← per-route files
 *                       └─ execute-route.js  ← Kamino → Jito submission
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    BOT_ROUTES_FILE: './results/bot-routes.json',   // written by master-pipeline Step 6
    ROUTES_DIR: './routes',                     // where execute-route.js reads from
    TOP_N: 5,                              // best routes to keep
    MIN_PROFIT_BPS: 30,                             // 0.30% minimum (your threshold)

    // ── Corruption filters ────────────────────────────────────────────────────
    // Any leg with output/input ratio above this is a stale sqrtPriceX64 artefact.
    // From analysis: scnSOL legs = 7953×, BONK = 1381×, 27G8Mt = 43×.
    // Real arb legs top out at ~10× (e.g. jitoSOL conversion ~0.94×, RAY ~1.5×).
    MAX_LEG_RATIO: 15,

    // Stablecoin loop guard: USDC↔USDT triangles can NEVER yield >50 bps.
    // Routes above this cap on a pure-stable path are phantom profits.
    STABLE_MAX_BPS: 50,
    STABLE_MINTS: new Set([
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]),

    // Known permanently-broken pool addresses (from analysis).
    // These have stale on-chain state that re-enrichment does not fix.
    BANNED_POOLS: new Set([
        '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF', // Raydium CLMM USDT/SOL — stale 20×
        'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA', // Orca scnSOL/SOL — 7953×
        '55BrDTCLWayM16GwrMEQU57o4PTm6ceF9wavSdNZcEiy', // Orca USDC/scnSOL — 678×
        '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1', // Orca BONK/SOL  — 1381×
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd', // Orca JLP/SOL   — 43×
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb', // Orca USDC/JLP  — illiquid
        'CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN', // Orca cbBTC/SOL — 7977×
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', // Orca USDC/cbBTC— 680×
    ]),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[prepare] ${msg}`); }
function warn(msg) { console.warn(`[prepare] ⚠  ${msg}`); }
function ok(msg) { console.log(`[prepare] ✅ ${msg}`); }
function fail(msg) { console.error(`[prepare] 🚨 ${msg}`); }

/**
 * Returns the rejection reason string, or null if the route passes all filters.
 *
 * Checks (in order):
 *   1. Banned pool address in any leg
 *   2. Impossible leg conversion ratio (> MAX_LEG_RATIO)
 *   3. Stable-loop phantom profit
 *   4. Below minimum profit threshold
 */
function rejectReason(route) {
    const swaps = route.swaps || [];

    // 1. Banned pool
    for (const s of swaps) {
        if (CONFIG.BANNED_POOLS.has(s.pool)) {
            return `banned pool ${s.pool.slice(0, 8)} on leg ${s.leg}`;
        }
    }

    // 2. Impossible leg ratio
    for (const s of swaps) {
        const inAmt = Number(s.amountIn);
        const outAmt = Number(s.amountOut);
        if (inAmt > 0 && outAmt / inAmt > CONFIG.MAX_LEG_RATIO) {
            const ratio = (outAmt / inAmt).toFixed(0);
            return `leg ${s.leg} ratio ${ratio}× > ${CONFIG.MAX_LEG_RATIO} (stale sqrtPriceX64)`;
        }
    }

    // 3. Stable loop
    const mints = route.tokens || [];
    const midMints = mints.slice(1, -1); // exclude start/end SOL
    const allStable = midMints.every(m => CONFIG.STABLE_MINTS.has(m));
    if (allStable && route.profitBps > CONFIG.STABLE_MAX_BPS) {
        return `stable-loop profit ${route.profitBps} bps > ${CONFIG.STABLE_MAX_BPS} cap`;
    }

    // 4. Profit threshold
    if (route.profitBps < CONFIG.MIN_PROFIT_BPS) {
        return `profit ${route.profitBps} bps < ${CONFIG.MIN_PROFIT_BPS} minimum`;
    }

    return null; // passes
}

/**
 * Convert a bot-routes.json route entry into the schema execute-route.js expects.
 *
 * execute-route.js reads:
 *   routeData.flashloanMint       → which token to borrow
 *   routeData.flashloanAmount     → raw lamports to borrow
 *   routeData.expectedProfit      → raw lamports expected profit
 *   routeData.swaps[]             → per-leg details for flashloanSwapInstructions.js
 *     .poolAddress                → on-chain pool account
 *     .poolType                   → 'cpmm' | 'clmm' | 'whirlpool' | 'dlmm'
 *     .poolDex                    → 'raydium' | 'orca' | 'meteora'
 *     .direction                  → 'A2B' | 'B2A'
 *     .amountIn                   → raw input (string)
 *     .amountOut                  → raw expected output (string)
 *     .feeBps                     → fee in basis points
 */
function toExecuteSchema(route, rank) {
    const swaps = (route.swaps || []).map(s => ({
        leg: s.leg,
        poolAddress: s.pool,
        poolType: s.poolType || 'unknown',
        poolDex: s.poolDex || 'unknown',
        direction: s.dir || 'A2B',
        from: s.from,
        to: s.to,
        amountIn: s.amountIn,
        amountOut: s.amountOut,
        feeBps: s.feeBps || 0,
        impactBps: s.impactBps || 0,
        slippageBps: s.slippageBps || 0,
    }));

    return {
        // ── Flashloan parameters ──────────────────────────────────────────────
        flashloanMint: CONFIG.SOL_MINT,
        flashloanAmount: route.inputAmount,     // '1000000000' = 1 SOL
        expectedProfit: route.profit,           // raw lamports profit string
        expectedOutput: route.expectedOutput,

        // ── Route metadata ────────────────────────────────────────────────────
        rank,
        path: route.path,
        tokens: route.tokens,
        profitBps: route.profitBps,
        profitPercent: route.profitPercent,
        totalSlippageBps: route.totalSlippageBps || 0,

        // ── Swap legs ─────────────────────────────────────────────────────────
        swaps,

        // ── Execution metadata ────────────────────────────────────────────────
        generatedAt: new Date().toISOString(),
        minProfitBps: CONFIG.MIN_PROFIT_BPS,
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // 1. Read bot-routes.json
    if (!fs.existsSync(CONFIG.BOT_ROUTES_FILE)) {
        fail(`${CONFIG.BOT_ROUTES_FILE} not found — run master-pipeline.js first`);
        process.exit(1);
    }

    const raw = JSON.parse(fs.readFileSync(CONFIG.BOT_ROUTES_FILE, 'utf8'));
    const all = raw.routes || [];
    log(`Loaded ${all.length} routes from ${CONFIG.BOT_ROUTES_FILE}`);

    // 2. Filter and rank
    const passed = [];
    const rejected = [];

    for (const route of all) {
        const reason = rejectReason(route);
        if (reason) {
            rejected.push({ route, reason });
            warn(`REJECT #${route.rank} [${(route.path || []).join('→')}] — ${reason}`);
        } else {
            passed.push(route);
        }
    }

    // Sort by profit descending (pipeline already sorts, but re-sort after filter)
    passed.sort((a, b) => b.profitBps - a.profitBps);
    const best = passed.slice(0, CONFIG.TOP_N);

    log(`${rejected.length} rejected, ${passed.length} passed, keeping top ${best.length}`);

    if (best.length === 0) {
        warn('No valid routes survived filtering. Nothing to submit.');
        warn('Re-run master-pipeline.js after re-enriching pools (stale sqrtPriceX64).');
        process.exit(0);
    }

    // 3. Write per-route files
    if (!fs.existsSync(CONFIG.ROUTES_DIR)) {
        fs.mkdirSync(CONFIG.ROUTES_DIR, { recursive: true });
    }

    // Clean old route files
    fs.readdirSync(CONFIG.ROUTES_DIR)
        .filter(f => f.startsWith('route_') && f.endsWith('.json'))
        .forEach(f => fs.unlinkSync(path.join(CONFIG.ROUTES_DIR, f)));

    const written = [];
    for (let i = 0; i < best.length; i++) {
        const rank = i + 1;
        const route = best[i];
        const schema = toExecuteSchema(route, rank);
        const filename = `route_${String(rank).padStart(3, '0')}.json`;
        const filepath = path.join(CONFIG.ROUTES_DIR, filename);

        fs.writeFileSync(filepath, JSON.stringify(schema, null, 2));
        written.push({ rank, filename, profitBps: route.profitBps, path: (route.path || []).join('→') });
        ok(`route_${String(rank).padStart(3, '0')}.json  ${(route.path || []).join('→')}  +${route.profitBps} bps`);
    }

    // 4. Print execution commands
    console.log('\n' + '─'.repeat(70));
    console.log('Ready for execution. Run each route individually:');
    console.log('─'.repeat(70));
    for (const { rank, filename, profitBps, path: p } of written) {
        console.log(`  #${rank}  node execute-route.js --route ./routes/${filename}`);
        console.log(`       ${p}  (+${profitBps} bps)`);
    }
    console.log('\nOr run all 5 in sequence (safest):');
    console.log('  node prepare-execution.js --run-all');
    console.log('─'.repeat(70));

    // 5. If --run-all flag is set, execute them in sequence
    if (process.argv.includes('--run-all')) {
        log('--run-all flag detected. Executing routes in sequence...');
        const { execSync } = require('child_process');
        for (const { rank, filename } of written) {
            const routePath = path.join(CONFIG.ROUTES_DIR, filename);
            log(`Submitting route #${rank} → ${filename}`);
            try {
                execSync(`node execute-route.js --route ${routePath}`, { stdio: 'inherit' });
                ok(`Route #${rank} submitted`);
            } catch (e) {
                warn(`Route #${rank} failed: ${e.message}`);
                // Continue to next route — one failure should not block the rest
            }
        }
    }

    // 6. Write a summary manifest so you can see what was prepared
    const manifest = {
        generatedAt: new Date().toISOString(),
        totalRoutes: all.length,
        rejected: rejected.length,
        passed: passed.length,
        submitted: best.length,
        minProfitBps: CONFIG.MIN_PROFIT_BPS,
        routes: written,
    };
    fs.writeFileSync(path.join(CONFIG.ROUTES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log(`Manifest written to ${CONFIG.ROUTES_DIR}/manifest.json`);
}

main().catch(e => {
    fail(e.message);
    console.error(e.stack);
    process.exit(1);
});
//. node prepare-execution.js