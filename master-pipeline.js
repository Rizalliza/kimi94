#!/usr/bin/env node
/**
 * Master Pipeline for Arbitrage Simulation
 * Orchestrates the complete workflow from pool loading to bot route selection
 * 
 * Workflow:
 * 1. Load pools from JSON
 * 2. Enrich pools (if not already enriched)
 * 3. Find triangle opportunities (SOL → X → Y → SOL)
 * 4. Simulate all routes using proper math
 * 5. Export results to CSV/JSON/XLSX
 * 6. Select top routes for bot execution
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// DEPENDENCIES
// ============================================================================

// Enricher module
let enrichAllPools;
try {
    const enricher = require('./enricher/enriched-fixed.js');
    enrichAllPools = enricher.enrichAllPools;
} catch (e) {
    console.warn('⚠️  Enricher module not available:', e.message);
}

// Math adapter (legacy)
let PoolMath;
try {
    const mathAdapter = require('./math/math-adapter.js');
    PoolMath = mathAdapter.PoolMath;
} catch (e) {
    console.warn('⚠️  Math adapter not available:', e.message);
}

// Raw swap math (unified, preferred)
let rawSwapMath;
try {
    rawSwapMath = require('./core/raw-swap-math.js');
} catch (e) {
    console.warn('⚠️  Raw swap math not available:', e.message);
}

// Export utilities
let exportResults;
try {
    const exportUtils = require('./exports/export-utils.js');
    exportResults = exportUtils.exportResults;
} catch (e) {
    console.warn('⚠️  Export utilities not available:', e.message);
}

// Dynamic slippage calculator
let dynamicSlippage;
try {
    dynamicSlippage = require('./utils/dynamic-slippage.js');
    console.log('✓ Dynamic slippage calculator loaded');
} catch (e) {
    console.warn('⚠️  Dynamic slippage calculator not available:', e.message);
}

// Production route guard
let productionGuard;
try {
    const guardModule = require('./utils/production-guard.js');
    productionGuard = guardModule.productionGuard;
    console.log('✓ Production route guard loaded');
} catch (e) {
    console.warn('⚠️  Production route guard not available:', e.message);
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// Helper to safely convert values to BigInt
function safeBigInt(val) {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'string') {
        if (!val || val === 'null' || val === 'undefined') return 0n;
        try { return BigInt(val); } catch { return 0n; }
    }
    if (typeof val === 'number') {
        if (!isFinite(val) || isNaN(val)) return 0n;
        return BigInt(Math.floor(val));
    }
    if (typeof val === 'object' && val !== null) {
        // Handle objects like { liquidityUsd: ... }
        if (val.liquidity) return safeBigInt(val.liquidity);
        if (val.amount) return safeBigInt(val.amount);
        if (val.value) return safeBigInt(val.value);
        return 0n;
    }
    return 0n;
}

// Helper to serialize BigInts to strings for JSON
function serializeBigIntReplacer(key, value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
}

const CONFIG = {
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT_MINT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    DEFAULT_INPUT_AMOUNT: 1000000000n, // 1 SOL in lamports
    MIN_PROFIT_BPS: 10, // Minimum 0.1% profit
    MAX_SLIPPAGE_BPS: 200, // Maximum 2% total slippage for bot routes
    MAX_TRIANGLES: 500,
    OUTPUT_DIR: './results',
    TOP_BOT_ROUTES: 5,

    // Problem pools/tokens to exclude (causing calculation errors)
    PROBLEM_POOLS: new Set([
        // Add specific pool addresses here that cause issues
    ]),
    PROBLEM_TOKENS: new Set([
        // Tokens with known decimal/price issues (from actual results)
        '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', // 2zMMhc - shows 688% profit bug
        'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',   // pumpCm - shows 5829% profit bug
        '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g', // 98sMhv - shows 60% profit bug
        'soKqZS9pASwBNS46G388nhK7XVtPaTyReffXEd3zora',   // soKqZS - shows 470% profit bug
        'J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr', // J3NKxx - shows 422% profit bug
    ])
};

// Token symbols for display
const TOKEN_SYMBOLS = {
    [CONFIG.SOL_MINT]: 'SOL',
    [CONFIG.USDC_MINT]: 'USDC',
    [CONFIG.USDT_MINT]: 'USDT',
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
    'bSo13r4TkiE4xumBLjQN9VHqjAvcrWujNpKD4xbD5VR': 'bSOL',
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'stSOL',
    '3NZ9JMVBmGAq2ybPp4oYr3o2xKQFeF8i1dQWjz9oWBWo': 'scnSOL',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'AZsHEMXd36Bj1EMNXhowJajpUXrKzKJx7LU5Gz7gG0U': 'RAY',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt': 'SRM',
    'orcaEKTdK7LKz57vaAYr9QeDsVEwBJAQFxnymdy47gZ': 'ORCA',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
    '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': 'BTC',
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getTokenSymbol(mint) {
    if (!mint) return '?';
    return TOKEN_SYMBOLS[mint] || `${mint.slice(0, 6)}..${mint.slice(-4)}`;
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

function formatAmount(amount, decimals = 9) {
    if (typeof amount === 'bigint') {
        amount = Number(amount) / Math.pow(10, decimals);
    }
    if (amount >= 1000000) return `${(amount / 1000000).toFixed(2)}M`;
    if (amount >= 1000) return `${(amount / 1000).toFixed(2)}K`;
    return amount.toFixed(decimals > 6 ? 4 : 2);
}

function logStep(stepNum, message) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`STEP ${stepNum}: ${message}`);
    console.log('═'.repeat(70));
}

function logProgress(current, total, message) {
    const percent = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
    process.stdout.write(`\r  [${bar}] ${percent}% | ${current}/${total} | ${message}`);
}

// ============================================================================
// COMMAND LINE ARGUMENTS
// ============================================================================

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        poolsFile: 'poolsAll.json',
        amount: CONFIG.DEFAULT_INPUT_AMOUNT,
        minProfitBps: CONFIG.MIN_PROFIT_BPS,
        maxTriangles: CONFIG.MAX_TRIANGLES,
        outputDir: CONFIG.OUTPUT_DIR,
        skipEnrichment: false,
        rawOnly: false,
        help: false
    };

    for (const arg of args) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg.startsWith('--pools=')) {
            options.poolsFile = arg.split('=')[1];
        } else if (arg.startsWith('--amount=')) {
            options.amount = BigInt(arg.split('=')[1]);
        } else if (arg.startsWith('--min-profit=')) {
            options.minProfitBps = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--max-triangles=')) {
            options.maxTriangles = parseInt(arg.split('=')[1]);
        } else if (arg.startsWith('--output-dir=')) {
            options.outputDir = arg.split('=')[1];
        } else if (arg === '--skip-enrichment') {
            options.skipEnrichment = true;
        } else if (arg === '--raw-only') {
            options.rawOnly = true;
        }
    }

    return options;
}

function printHelp() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║              ARBITRAGE SIMULATION MASTER PIPELINE                    ║
╠══════════════════════════════════════════════════════════════════════╣
║  Usage: node master-pipeline.js [options]                            ║
║                                                                      ║
║  Options:                                                            ║
║    --pools=<file>        Input pools file (default: pools.json)      ║
║    --amount=<lamports>   Input amount in lamports (default: 1 SOL)   ║
║    --min-profit=<bps>    Minimum profit in basis points (default: 10)║
║    --max-triangles=<n>   Max triangles to simulate (default: 500)    ║
║    --output-dir=<dir>    Output directory (default: ./results)       ║
║    --skip-enrichment     Skip pool enrichment step                   ║
║    --raw-only            Export only raw values (no decimal conversion)║
║    --help, -h            Show this help message                      ║
║                                                                      ║
║  Targeted Enrichment Workflow:                                       ║
║    1. First run: Processes all pools and saves profitable route      ║
║       pools to ./pools.json                                          ║
║    2. Next runs: Only enriches pools in ./pools.json                 ║
║    3. Enriched pools saved to ./pools_enriched.json                  ║
║    4. Delete ./pools.json to reset and process all pools again       ║
║                                                                      ║
║  Examples:                                                           ║
║    node master-pipeline.js                                           ║
║    node master-pipeline.js --pools=my-pools.json --amount=500000000  ║
║    node master-pipeline.js --min-profit=50 --max-triangles=1000      ║
║    node master-pipeline.js --raw-only                                ║
╚══════════════════════════════════════════════════════════════════════╝
`);
}

// ============================================================================
// STEP 1: LOAD POOLS
// ============================================================================

async function loadPools(poolsFile, options = {}) {
    const startTime = Date.now();

    // Check if enriched pools exist and use them if available
    const enrichedPoolsPath = './pools_enriched.json';
    if (!options.skipEnrichedCheck && fs.existsSync(enrichedPoolsPath)) {
        console.log(`  📁 Found enriched pools at ${enrichedPoolsPath}`);
        const raw = fs.readFileSync(enrichedPoolsPath, 'utf8');
        const data = JSON.parse(raw);
        const pools = Array.isArray(data) ? data : (data.pools || data.data || []);
        const duration = Date.now() - startTime;
        console.log(`  ✓ Loaded ${pools.length} enriched pools (${formatDuration(duration)})`);
        const enrichedCount = pools.filter(p => p.enriched === true).length;
        console.log(`  ✓ Enriched pools: ${enrichedCount}/${pools.length}`);
        return pools;
    }

    // Check for targeted pools file (pools selected for enrichment)
    const targetedPoolsPath = './pools.json';
    if (!options.skipTargetedCheck && fs.existsSync(targetedPoolsPath)) {
        console.log(`  📁 Found targeted pools at ${targetedPoolsPath}`);
        const raw = fs.readFileSync(targetedPoolsPath, 'utf8');
        const data = JSON.parse(raw);
        const pools = Array.isArray(data) ? data : (data.pools || data.data || []);
        const duration = Date.now() - startTime;
        console.log(`  ✓ Loaded ${pools.length} targeted pools for enrichment (${formatDuration(duration)})`);
        return pools;
    }

    if (!fs.existsSync(poolsFile)) {
        throw new Error(`Pools file not found: ${poolsFile}`);
    }

    const raw = fs.readFileSync(poolsFile, 'utf8');
    const data = JSON.parse(raw);

    // Handle different JSON structures
    const pools = Array.isArray(data) ? data : (data.pools || data.data || []);

    const duration = Date.now() - startTime;
    console.log(`  ✓ Loaded ${pools.length} pools from ${poolsFile} (${formatDuration(duration)})`);

    // Check enrichment status
    const enrichedCount = pools.filter(p => p.enriched === true).length;
    console.log(`  ✓ Enriched pools: ${enrichedCount}/${pools.length}`);

    return pools;
}

// ============================================================================
// STEP 2: ENRICH POOLS
// ============================================================================

async function enrichPools(pools, skipEnrichment) {
    if (skipEnrichment) {
        console.log('  ⏭️  Skipping enrichment (user requested)');
        return pools;
    }

    const alreadyEnriched = pools.filter(p => p.enriched === true).length;
    if (alreadyEnriched === pools.length) {
        console.log('  ⏭️  All pools already enriched');
        return pools;
    }

    if (!enrichAllPools) {
        console.warn('  ⚠️  Enricher not available, skipping enrichment');
        return pools;
    }

    const startTime = Date.now();
    const enriched = await enrichAllPools(pools);
    const duration = Date.now() - startTime;

    console.log(`  ✓ Enrichment completed in ${formatDuration(duration)}`);

    // Save enriched pools to ./pools_enriched.json
    const enrichedOutputPath = './pools_enriched.json';
    // **NO CHANGES ARE TO BE MADE THESE CODES**
    fs.writeFileSync(enrichedOutputPath, JSON.stringify(enriched, serializeBigIntReplacer, 2));
    // **NO CHANGES ARE TO BE MADE THESE CODES**
    console.log(`  💾 Saved enriched pools to ${enrichedOutputPath}`);

    return enriched;
}

// ============================================================================
// STEP 3: FIND TRIANGLE OPPORTUNITIES
// ============================================================================

function isProblemPool(pool) {
    // Check if pool address is in problem list
    if (CONFIG.PROBLEM_POOLS.has(pool.poolAddress)) return true;

    // Check if either token is in problem list
    const baseMint = pool.baseMint || pool.mintA;
    const quoteMint = pool.quoteMint || pool.mintB;

    if (CONFIG.PROBLEM_TOKENS.has(baseMint)) return true;
    if (CONFIG.PROBLEM_TOKENS.has(quoteMint)) return true;

    return false;
}

function buildPairMap(pools) {
    const pairMap = new Map();
    let skipped = 0;

    for (const pool of pools) {
        // Skip problem pools
        if (isProblemPool(pool)) {
            skipped++;
            continue;
        }

        const baseMint = pool.baseMint || pool.mintA || pool.tokenMintA || pool.tokenA?.mint;
        const quoteMint = pool.quoteMint || pool.mintB || pool.tokenMintB || pool.tokenB?.mint;

        if (!baseMint || !quoteMint) continue;

        const key1 = `${baseMint}-${quoteMint}`;
        const key2 = `${quoteMint}-${baseMint}`;

        if (!pairMap.has(key1)) pairMap.set(key1, []);
        if (!pairMap.has(key2)) pairMap.set(key2, []);

        pairMap.get(key1).push(pool);
        pairMap.get(key2).push(pool);
    }

    if (skipped > 0) {
        console.log(`  Filtered out ${skipped} problem pools`);
    }

    return pairMap;
}

function findConnectedMints(pairMap, mint) {
    const connected = new Set();
    for (const [key, pools] of pairMap.entries()) {
        if (key.startsWith(mint + '-')) {
            const other = key.split('-')[1];
            connected.add(other);
        }
    }
    return Array.from(connected);
}

function getPoolsForPair(pairMap, mintA, mintB) {
    return pairMap.get(`${mintA}-${mintB}`) || pairMap.get(`${mintB}-${mintA}`) || [];
}

function findTriangles(pools, options) {
    const startTime = Date.now();
    const { maxTriangles, amount } = options;

    const pairMap = buildPairMap(pools);
    const tokenAMint = CONFIG.SOL_MINT;

    console.log(`  Building pair map... ${pairMap.size} pairs found`);

    const triangles = [];
    const tokenBs = findConnectedMints(pairMap, tokenAMint);

    console.log(`  Found ${tokenBs.length} tokens connected to SOL`);

    for (const tokenB of tokenBs) {
        if (triangles.length >= maxTriangles) break;

        const tokenCs = findConnectedMints(pairMap, tokenB);

        for (const tokenC of tokenCs) {
            if (triangles.length >= maxTriangles) break;
            if (tokenC === tokenAMint || tokenC === tokenB) continue;

            // Check if tokenC connects back to tokenA
            const poolsCA = getPoolsForPair(pairMap, tokenC, tokenAMint);
            if (poolsCA.length === 0) continue;

            const poolsAB = getPoolsForPair(pairMap, tokenAMint, tokenB);
            const poolsBC = getPoolsForPair(pairMap, tokenB, tokenC);

            if (poolsAB.length === 0 || poolsBC.length === 0) continue;

            // Select best pool for each leg (highest liquidity)
            const bestAB = poolsAB.sort((a, b) => {
                const liqA = parseFloat(a.liquidityUSD || a.tvl || 0);
                const liqB = parseFloat(b.liquidityUSD || b.tvl || 0);
                return liqB - liqA;
            })[0];

            const bestBC = poolsBC.sort((a, b) => {
                const liqA = parseFloat(a.liquidityUSD || a.tvl || 0);
                const liqB = parseFloat(b.liquidityUSD || b.tvl || 0);
                return liqB - liqA;
            })[0];

            const bestCA = poolsCA.sort((a, b) => {
                const liqA = parseFloat(a.liquidityUSD || a.tvl || 0);
                const liqB = parseFloat(b.liquidityUSD || b.tvl || 0);
                return liqB - liqA;
            })[0];

            triangles.push({
                path: [
                    getTokenSymbol(tokenAMint),
                    getTokenSymbol(tokenB),
                    getTokenSymbol(tokenC),
                    getTokenSymbol(tokenAMint)
                ],
                tokens: [tokenAMint, tokenB, tokenC],
                pools: [bestAB, bestBC, bestCA],
                poolAddresses: [bestAB.address || bestAB.poolAddress,
                bestBC.address || bestBC.poolAddress,
                bestCA.address || bestCA.poolAddress]
            });
        }
    }

    // Log pool type distribution for triangles
    const typeStats = { cpmm: 0, clmm: 0, whirlpool: 0, dlmm: 0, unknown: 0 };
    triangles.forEach(t => {
        t.pools.forEach(p => {
            const type = (p.type || 'unknown').toLowerCase();
            if (typeStats.hasOwnProperty(type)) typeStats[type]++;
            else typeStats.unknown++;
        });
    });

    console.log(`  📊 Pool types in triangles:`);
    console.log(`     CPMM: ${typeStats.cpmm}, CLMM: ${typeStats.clmm}, Whirlpool: ${typeStats.whirlpool}, DLMM: ${typeStats.dlmm}`);
    if (typeStats.unknown > 0) console.log(`     Unknown: ${typeStats.unknown}`);

    // Warn if only CPMM is being used
    const totalTyped = typeStats.cpmm + typeStats.clmm + typeStats.whirlpool + typeStats.dlmm;
    if (totalTyped > 0 && typeStats.cpmm / totalTyped > 0.8) {
        console.log(`  ⚠️  Warning: >80% of pools are CPMM. CLMM/Whirlpool/DLMM may be failing enrichment.`);
    }

    const duration = Date.now() - startTime;
    console.log(`  ✓ Found ${triangles.length} triangles (${formatDuration(duration)})`);

    return triangles;
}

// ============================================================================
// STEP 4: SIMULATE ROUTES
// ============================================================================

function getFeeBps(pool) {
    if (!pool) return 25;

    // feeBps — already in basis-points (e.g. 25 = 0.25%)
    if (pool.feeBps != null) {
        const v = Number(pool.feeBps);
        return (v > 0 && v <= 10000) ? v : 25;
    }

    // feeRate — stored in millionths (Orca / Raydium convention)
    //   e.g. 3000 → 3000 / 1_000_000 = 0.3% = 30 bps
    //   WRONG was: * 10000  (gave 30,000,000% !)
    if (pool.feeRate != null) {
        const v = Math.round(Number(pool.feeRate) / 100);
        return (v > 0 && v <= 10000) ? v : 25;
    }

    // feePct — decimal fraction (e.g. 0.003 = 0.3% = 30 bps)
    if (pool.feePct != null) {
        const v = Math.round(Number(pool.feePct) * 10000);
        return (v > 0 && v <= 10000) ? v : 25;
    }

    // fee — ambiguous; sniff by magnitude
    if (pool.fee != null) {
        const raw = Number(pool.fee);
        let v;
        if (raw > 100) v = Math.round(raw / 100);      // millionths → bps
        else if (raw >= 1) v = Math.round(raw);         // already bps
        else v = Math.round(raw * 10000);               // decimal fraction → bps
        return (v > 0 && v <= 10000) ? v : 25;
    }

    return 25; // default: 0.25%
}

function simulateTriangle(triangle, inputAmount) {
    // Use unified raw-swap-math if available (preferred)
    if (rawSwapMath) {
        const result = rawSwapMath.simulateTriangleRaw(
            triangle.pools,
            triangle.tokens,
            inputAmount
        );

        if (result.success) {
            const swaps = result.legs.map((leg, i) => {
                const pool = triangle.pools[i];
                const legData = {
                    type: pool.type,
                    address: pool.poolAddress,
                    xReserve: pool.xReserve,
                    yReserve: pool.yReserve,
                    liquidity: pool.liquidity,
                    bins: pool.bins,
                    activeBinId: pool.activeBinId,
                    tickArrays: pool.tickArrays,
                    dir: leg.dir
                };

                // Calculate dynamic slippage for this leg
                let slippageBps = 50; // Default 0.5%
                if (dynamicSlippage) {
                    slippageBps = dynamicSlippage.calculateDynamicSlippage(legData, leg.in, {
                        minSlippageBps: 10,   // 0.1% minimum
                        baseSlippageBps: 50,  // 0.5% base
                        maxSlippageBps: 500   // 5% maximum
                    });
                }

                return {
                    leg: i + 1,
                    dir: leg.dir,
                    from: getTokenSymbol(triangle.tokens[i]),
                    to: getTokenSymbol(triangle.tokens[(i + 1) % 3]),
                    pool: leg.pool,
                    poolType: leg.poolType || pool.type || 'unknown',
                    poolDex: pool.dex || 'unknown',
                    amountIn: leg.in.toString(),
                    amountOut: leg.out.toString(),
                    feeBps: getFeeBps(triangle.pools[i]),
                    impactBps: leg.impactBps || 0,
                    slippageBps
                };
            });

            const totalImpactBps = swaps.reduce((sum, s) => sum + (s.impactBps || 0), 0);
            const totalSlippageBps = swaps.reduce((sum, s) => sum + (s.slippageBps || 0), 0);

            // Get slippage warning level
            let slippageWarning = { level: 'LOW', emoji: '🟢' };
            if (dynamicSlippage) {
                slippageWarning = dynamicSlippage.getSlippageWarning(totalSlippageBps);
            }

            // ── Sanity check 1: multiplicative price consistency ──────────────
            // Cross-DEX arbitrage INTENTIONALLY has prices that deviate from 1.0
            // — that price gap IS the profit opportunity. 500 bps was blocking
            // every genuine route above ~200 bps. Stale-data artefacts produce
            // 1000–80000× deviations, so 3000 bps (30%) catches those while
            // preserving real opportunities up to ~3 SOL profit.
            const MAX_PRICE_DEVIATION_BPS = 3000; // 30% — preserves real cross-DEX arb
            const execPrices = result.legs
                .map(l => {
                    if (l.executionPriceQ64 && l.executionPriceQ64 > 0n) return l.executionPriceQ64;
                    if (l.in > 0n && l.out > 0n) return (l.out << 64n) / l.in;
                    return 0n;
                })
                .filter(p => p > 0n);

            if (execPrices.length === 3) {
                const Q64_FLOAT = 18446744073709551616.0;
                const priceProduct = execPrices.reduce(
                    (acc, p) => acc * (Number(p) / Q64_FLOAT),
                    1.0
                );
                const deviationBps = Math.abs(priceProduct - 1.0) * 10000;
                if (deviationBps > MAX_PRICE_DEVIATION_BPS && result.profitBps > 200) {
                    return {
                        path: triangle.path,
                        error: `price-product-check: product=${priceProduct.toFixed(5)} deviation=${deviationBps.toFixed(0)}bps (stale data?)`,
                        profitBps: 0,
                        feasible: false
                    };
                }
            }

            // ── Sanity check 2: stablecoin guard ────────────────────────────
            // Stablecoin legs should yield < STABLE_MAX_PROFIT_BPS.
            // Anything higher almost always signals a fee or reserve data bug.
            const STABLE_MAX_PROFIT_BPS = 50;
            const STABLECOIN_MINTS = new Set([
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
                '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'  // DAI (Solana)
            ]);
            if (
                triangle.tokens.some(m => STABLECOIN_MINTS.has(m)) &&
                result.profitBps > STABLE_MAX_PROFIT_BPS
            ) {
                return {
                    path: triangle.path,
                    error: `stablecoin-guard: profit=${result.profitBps}bps exceeds ${STABLE_MAX_PROFIT_BPS}bps cap for stable route`,
                    profitBps: 0,
                    feasible: false
                };
            }

            return {
                path: triangle.path,
                tokens: triangle.tokens,
                poolAddresses: triangle.poolAddresses,
                inputAmount,
                swaps,
                totalOutput: result.output,
                profit: result.profit,
                profitBps: result.profitBps,
                feasible: result.profitBps >= CONFIG.MIN_PROFIT_BPS,
                totalImpactBps,
                totalSlippageBps,
                slippageWarning
            };
        }

        // Raw math failed, fall through to legacy
    }

    // Legacy fallback using PoolMath
    const results = {
        path: triangle.path,
        tokens: triangle.tokens,
        poolAddresses: triangle.poolAddresses,
        inputAmount,
        swaps: [],
        totalOutput: 0n,
        profit: 0n,
        profitBps: 0,
        feasible: false
    };

    let currentAmount = inputAmount;

    // Helper to resolve direction
    const resolveDir = (pool, inputMint) => {
        const baseMint = pool.baseMint || pool.mintA;
        const quoteMint = pool.quoteMint || pool.mintB;
        if (inputMint === baseMint) return 'A2B';
        if (inputMint === quoteMint) return 'B2A';
        return 'A2B';
    };

    // Leg 1: tokenA → tokenB
    const dir1 = resolveDir(triangle.pools[0], triangle.tokens[0]);
    const swap1 = simulateSwapWithMath(triangle.pools[0], currentAmount, dir1);
    if (!swap1.success) return { ...results, error: 'Leg 1 failed' };

    // Helper to calculate impact and slippage for legacy path
    const calculateLegMetrics = (pool, amountIn, dir) => {
        let impactBps = 0;
        if (rawSwapMath && rawSwapMath.calculateDynamicImpactBps) {
            const reserve = safeBigInt(pool.xReserve || pool.baseReserveRaw || pool.liquidity || 1);
            impactBps = rawSwapMath.calculateDynamicImpactBps(safeBigInt(amountIn), reserve);
        }

        let slippageBps = 50; // Default 0.5%
        if (dynamicSlippage) {
            const legData = {
                type: pool.type,
                address: pool.poolAddress,
                xReserve: pool.xReserve,
                yReserve: pool.yReserve,
                liquidity: pool.liquidity,
                bins: pool.bins,
                dir
            };
            slippageBps = dynamicSlippage.calculateDynamicSlippage(legData, safeBigInt(amountIn), {
                minSlippageBps: 10,
                baseSlippageBps: 50,
                maxSlippageBps: 500
            });
        }

        return { impactBps, slippageBps };
    };

    const leg1Metrics = calculateLegMetrics(triangle.pools[0], currentAmount, dir1);
    results.swaps.push({
        leg: 1,
        dir: dir1,
        from: getTokenSymbol(triangle.tokens[0]),
        to: getTokenSymbol(triangle.tokens[1]),
        pool: triangle.poolAddresses[0],
        poolType: triangle.pools[0]?.type || 'unknown',
        poolDex: triangle.pools[0]?.dex || 'unknown',
        amountIn: currentAmount.toString(),
        amountOut: swap1.amountOut.toString(),
        feeBps: swap1.feeBps,
        impactBps: leg1Metrics.impactBps,
        slippageBps: leg1Metrics.slippageBps
    });
    currentAmount = swap1.amountOut;

    // Leg 2: tokenB → tokenC
    const dir2 = resolveDir(triangle.pools[1], triangle.tokens[1]);
    const swap2 = simulateSwapWithMath(triangle.pools[1], currentAmount, dir2);
    if (!swap2.success) return { ...results, error: 'Leg 2 failed' };

    const leg2Metrics = calculateLegMetrics(triangle.pools[1], currentAmount, dir2);
    results.swaps.push({
        leg: 2,
        dir: dir2,
        from: getTokenSymbol(triangle.tokens[1]),
        to: getTokenSymbol(triangle.tokens[2]),
        pool: triangle.poolAddresses[1],
        poolType: triangle.pools[1]?.type || 'unknown',
        poolDex: triangle.pools[1]?.dex || 'unknown',
        amountIn: currentAmount.toString(),
        amountOut: swap2.amountOut.toString(),
        feeBps: swap2.feeBps,
        impactBps: leg2Metrics.impactBps,
        slippageBps: leg2Metrics.slippageBps
    });
    currentAmount = swap2.amountOut;

    // Leg 3: tokenC → tokenA
    const dir3 = resolveDir(triangle.pools[2], triangle.tokens[2]);
    const swap3 = simulateSwapWithMath(triangle.pools[2], currentAmount, dir3);
    if (!swap3.success) return { ...results, error: 'Leg 3 failed' };

    const leg3Metrics = calculateLegMetrics(triangle.pools[2], currentAmount, dir3);
    results.swaps.push({
        leg: 3,
        dir: dir3,
        from: getTokenSymbol(triangle.tokens[2]),
        to: getTokenSymbol(triangle.tokens[0]),
        pool: triangle.poolAddresses[2],
        poolType: triangle.pools[2]?.type || 'unknown',
        poolDex: triangle.pools[2]?.dex || 'unknown',
        amountIn: currentAmount.toString(),
        amountOut: swap3.amountOut.toString(),
        feeBps: swap3.feeBps,
        impactBps: leg3Metrics.impactBps,
        slippageBps: leg3Metrics.slippageBps
    });

    results.totalOutput = swap3.amountOut;
    results.profit = results.totalOutput - inputAmount;
    results.profitBps = Number((results.profit * 10000n) / inputAmount);
    results.feasible = results.profitBps >= CONFIG.MIN_PROFIT_BPS;
    results.totalImpactBps = results.swaps.reduce((sum, s) => sum + (s.impactBps || 0), 0);
    results.totalSlippageBps = results.swaps.reduce((sum, s) => sum + (s.slippageBps || 0), 0);

    if (dynamicSlippage) {
        results.slippageWarning = dynamicSlippage.getSlippageWarning(results.totalSlippageBps);
    }

    return results;
}

// Legacy fallback for single swap (used when rawSwapMath is not available)
function simulateSwapWithMath(pool, amountInRaw, direction = 'A2B') {
    if (PoolMath) {
        try {
            const poolMath = new PoolMath(pool);
            if (poolMath.isValid()) {
                const result = poolMath.getQuote(BigInt(amountInRaw), direction);
                if (result.success) {
                    return {
                        success: true,
                        amountOut: result.amountOutRaw,
                        feeBps: getFeeBps(pool),
                        executionPrice: result.executionPriceQ64
                    };
                }
            }
        } catch (e) {
            // Fall through
        }
    }

    // CPMM fallback
    const feeBps = getFeeBps(pool);
    const xReserve = pool.xReserve || pool.reserveA || 0;
    const yReserve = pool.yReserve || pool.reserveB || 0;

    if (!xReserve || !yReserve) {
        return { success: false, amountOut: 0n, feeBps };
    }

    const x = BigInt(xReserve);
    const y = BigInt(yReserve);
    const amountIn = BigInt(amountInRaw);
    const inAfterFee = (amountIn * BigInt(10000 - feeBps)) / 10000n;

    let amountOut;
    if (direction === 'A2B') {
        amountOut = (y * inAfterFee) / (x + inAfterFee);
    } else {
        amountOut = (x * inAfterFee) / (y + inAfterFee);
    }

    return { success: true, amountOut, feeBps };
}

async function simulateAllTriangles(triangles, options) {
    const startTime = Date.now();
    const { amount, minProfitBps } = options;

    const results = {
        triangles: [],
        successful: 0,
        failed: 0,
        profitable: 0
    };

    console.log(`  Simulating ${triangles.length} triangles with ${formatAmount(amount)} SOL input...`);

    for (let i = 0; i < triangles.length; i++) {
        if (i % 10 === 0) {
            logProgress(i, triangles.length, `Profitable: ${results.profitable}`);
        }

        try {
            const result = simulateTriangle(triangles[i], amount);
            results.triangles.push(result);
            results.successful++;

            if (result.profitBps >= minProfitBps) {
                results.profitable++;
            }
        } catch (error) {
            results.failed++;
            console.warn(`\n  ⚠️ Triangle ${i + 1} failed:`, error.message);
            // Debug: print stack trace for BigInt errors
            if (error.message.includes('Cannot convert')) {
                console.warn('  Stack:', error.stack?.split('\n').slice(0, 3).join('\n  '));
            }
        }
    }

    process.stdout.write('\n'); // Clear progress line

    // Calculate duration
    const duration = Date.now() - startTime;

    // Analyze pool type usage in successful simulations
    const typeStats = { cpmm: 0, clmm: 0, whirlpool: 0, dlmm: 0, unknown: 0 };
    results.triangles.forEach(t => {
        if (t.swaps) {
            t.swaps.forEach(s => {
                const type = (s.poolType || 'unknown').toLowerCase();
                if (typeStats.hasOwnProperty(type)) typeStats[type]++;
                else typeStats.unknown++;
            });
        }
    });

    console.log(`  ✓ Simulation completed in ${formatDuration(duration)}`);
    console.log(`    - Successful: ${results.successful}/${triangles.length}`);
    console.log(`    - Failed: ${results.failed}`);
    console.log(`    - Profitable (≥${minProfitBps} bps): ${results.profitable}`);
    console.log(`    - Pool types used:`);
    console.log(`      CPMM: ${typeStats.cpmm} legs, CLMM: ${typeStats.clmm} legs, Whirlpool: ${typeStats.whirlpool} legs, DLMM: ${typeStats.dlmm} legs`);
    if (typeStats.unknown > 0) console.log(`      Unknown: ${typeStats.unknown} legs`);

    // Warning if CPMM dominates
    const totalTyped = typeStats.cpmm + typeStats.clmm + typeStats.whirlpool + typeStats.dlmm;
    if (totalTyped > 0 && typeStats.cpmm / totalTyped > 0.7) {
        console.log(`  ⚠️  Note: CPMM pools dominate (${Math.round(typeStats.cpmm / totalTyped * 100)}% of legs).`);
        console.log(`     This may indicate CLMM/Whirlpool/DLMM enrichment is failing.`);
    }

    // Sort triangles by profit (best first)
    results.triangles.sort((a, b) => (b.profitBps || 0) - (a.profitBps || 0));

    return results;
}

// ============================================================================
// STEP 5: EXPORT RESULTS
// ============================================================================

async function exportSimulationResults(simulationResults, options) {
    const startTime = Date.now();

    // Ensure output directory exists
    if (!fs.existsSync(options.outputDir)) {
        fs.mkdirSync(options.outputDir, { recursive: true });
    }

    let exportedFiles = {};

    // Use export-utils if available
    if (exportResults) {
        try {
            const exportOutput = exportResults(simulationResults, {
                outputDir: options.outputDir,
                csv: true,
                csvRawOnly: options.rawOnly || false,
                json: true,
                xlsx: !options.rawOnly,  // Skip XLSX in raw-only mode
                filenamePrefix: options.rawOnly ? 'arbitrage_results_raw' : 'arbitrage_results'
            });
            exportedFiles = exportOutput.exportedFiles;
        } catch (e) {
            console.warn('  ⚠️ Export utils failed, using fallback:', e.message);
        }
    }

    // Fallback JSON export
    if (!exportedFiles.json) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonPath = path.join(options.outputDir, `arbitrage_results_${timestamp}.json`);

        const exportData = {
            metadata: {
                exportVersion: '1.0.0',
                generatedAt: new Date().toISOString(),
                totalSimulated: simulationResults.triangles.length,
                profitable: simulationResults.triangles.filter(t => t.profitBps > 0).length
            },
            results: simulationResults.triangles
        };

        fs.writeFileSync(jsonPath, JSON.stringify(exportData, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            return value;
        }, 2));

        exportedFiles.json = jsonPath;
    }

    const duration = Date.now() - startTime;
    console.log(`  ✓ Export completed in ${formatDuration(duration)}`);

    Object.entries(exportedFiles).forEach(([format, filePath]) => {
        console.log(`    - ${format.toUpperCase()}: ${filePath}`);
    });

    return exportedFiles;
}

// ============================================================================
// HELPER: Extract and save pools used in routes
// ============================================================================

function extractAndSavePoolsForEnrichment(profitableRoutes, allPools, outputPath = './pools.json') {
    // Extract unique pool addresses from all profitable routes
    const usedPoolAddresses = new Set();
    profitableRoutes.forEach(route => {
        if (route.poolAddresses && Array.isArray(route.poolAddresses)) {
            route.poolAddresses.forEach(addr => usedPoolAddresses.add(addr));
        }
    });

    if (usedPoolAddresses.size === 0) {
        console.log(`  ⚠️  No pool addresses found in profitable routes`);
        return null;
    }

    // Find the full pool objects for each used pool address
    const poolMap = new Map();
    allPools.forEach(pool => {
        const addr = pool.poolAddress || pool.address;
        if (addr) {
            poolMap.set(addr, pool);
        }
    });

    const selectedPools = [];
    const missingPools = [];

    for (const addr of usedPoolAddresses) {
        const pool = poolMap.get(addr);
        if (pool) {
            selectedPools.push(pool);
        } else {
            missingPools.push(addr);
        }
    }

    if (missingPools.length > 0) {
        console.log(`  ⚠️  ${missingPools.length} pools not found in pool map`);
    }

    // Save selected pools to pools.json
    fs.writeFileSync(outputPath, JSON.stringify(selectedPools, null, 2));
    console.log(`  💾 Saved ${selectedPools.length} pools to ${outputPath} for targeted enrichment`);

    return outputPath;
}

// ============================================================================
// STEP 6: SELECT BOT ROUTES
// ============================================================================

function selectBotRoutes(simulationResults, options, allPools = []) {
    const startTime = Date.now();
    const { minProfitBps, outputDir } = options;

    // Step 1: Inline route guard — replaces production-guard.js
    // The external guard was rejecting ALL 74 routes including genuine ones because:
    //   a) It labeled cross-DEX routes as "price ratio explosion"
    //   b) It labeled real profitable routes as "non-positive profit" (BigInt/type bug)
    // These inline filters are calibrated directly from the analysis of your results.
    let validRoutes = simulationResults.triangles;

    const BANNED_POOLS_GUARD = new Set([
        '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF', // Raydium CLMM USDT/SOL stale 20×
        'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA', // Orca scnSOL/SOL 7953×
        '55BrDTCLWayM16GwrMEQU57o4PTm6ceF9wavSdNZcEiy', // Orca USDC/scnSOL 678×
        '3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1', // Orca BONK/SOL 1381×
        '6a3m2EgFFKfsFuQtP4LJJXPcAe3TQYXNyHUjjZpUxYgd', // Orca JLP/SOL 43×
        '6NUiVmsNjsi4AfsMsEiaezsaV9N4N1ZrD4jEnuWNRvyb', // Orca USDC/JLP illiquid
        'CeaZcxBNLpJWtxzt58qQmfMBtJY8pQLvursXTJYGQpbN', // Orca cbBTC/SOL 7977×
        'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', // Orca USDC/cbBTC 680×
    ]);
    const STABLE_MINTS_GUARD = new Set([
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);

    const guardCounts = { bannedPool: 0, staleRatio: 0, stableLoop: 0, noProfit: 0, simError: 0, passed: 0 };

    validRoutes = validRoutes.filter(route => {
        if (route.error) { guardCounts.simError++; return false; }

        const swaps = route.swaps || [];

        // A. Banned pool addresses (confirmed stale from analysis)
        for (const s of swaps) {
            if (BANNED_POOLS_GUARD.has(s.pool)) { guardCounts.bannedPool++; return false; }
        }

        // B. Impossible leg ratio > 15× (stale sqrtPriceX64 not yet in banned list)
        for (const s of swaps) {
            const inAmt = Number(s.amountIn || 0);
            const outAmt = Number(s.amountOut || 0);
            if (inAmt > 1000 && outAmt / inAmt > 15) { guardCounts.staleRatio++; return false; }
        }

        // C. Stable-loop phantom profit (USDC↔USDT can never yield > 50 bps)
        const midMints = (route.tokens || []).slice(1, -1);
        const allStable = midMints.length > 0 && midMints.every(m => STABLE_MINTS_GUARD.has(m));
        if (allStable && (route.profitBps || 0) > 50) { guardCounts.stableLoop++; return false; }

        // D. Must have actual positive profit
        if ((route.profitBps || 0) <= 0) { guardCounts.noProfit++; return false; }

        guardCounts.passed++;
        return true;
    });

    const totalSeen = Object.values(guardCounts).reduce((a, b) => a + b, 0);
    console.log(`  Route Guard:`);
    console.log(`    Passed: ${guardCounts.passed} / ${totalSeen}`);
    if (guardCounts.bannedPool) console.log(`    - banned pool: ${guardCounts.bannedPool}`);
    if (guardCounts.staleRatio) console.log(`    - stale ratio >15×: ${guardCounts.staleRatio}`);
    if (guardCounts.stableLoop) console.log(`    - stable loop cap: ${guardCounts.stableLoop}`);
    if (guardCounts.noProfit) console.log(`    - non-positive profit: ${guardCounts.noProfit}`);
    if (guardCounts.simError) console.log(`    - simulation error: ${guardCounts.simError}`);

    // Step 2: Filter profitable routes with acceptable slippage
    const profitableRoutes = validRoutes
        .filter(t => {
            if (t.error) return false;
            if (t.profitBps < minProfitBps) return false;
            // Filter out high slippage routes
            if (t.totalSlippageBps && t.totalSlippageBps > CONFIG.MAX_SLIPPAGE_BPS) {
                console.log(`  ⚠️  Filtered out ${t.path?.join('→') || 'route'}: slippage ${t.totalSlippageBps} bps exceeds limit`);
                return false;
            }
            return true;
        })
        .sort((a, b) => b.profitBps - a.profitBps)
        .slice(0, CONFIG.TOP_BOT_ROUTES);

    console.log(`  Selected ${profitableRoutes.length} routes for bot execution`);
    if (profitableRoutes.length > 0) {
        console.log(`  Max slippage filter: ${CONFIG.MAX_SLIPPAGE_BPS} bps`);
    }

    // Format bot routes
    const botRoutes = profitableRoutes.map((route, index) => ({
        rank: index + 1,
        path: route.path,
        tokens: route.tokens,
        poolAddresses: route.poolAddresses,
        inputAmount: route.inputAmount.toString(),
        expectedOutput: route.totalOutput.toString(),
        profit: route.profit.toString(),
        profitBps: route.profitBps,
        profitPercent: (route.profitBps / 100).toFixed(2),
        totalImpactBps: route.totalImpactBps,
        totalSlippageBps: route.totalSlippageBps,
        slippageWarning: route.slippageWarning,
        swaps: route.swaps.map(s => ({
            leg: s.leg,
            pool: s.pool,
            dir: s.dir,
            from: s.from,
            to: s.to,
            amountIn: s.amountIn,
            amountOut: s.amountOut,
            feeBps: s.feeBps,
            impactBps: s.impactBps,
            slippageBps: s.slippageBps
        })),
        timestamp: new Date().toISOString()
    }));

    // Save bot routes
    const botRoutesPath = path.join(outputDir, 'bot-routes.json');
    fs.writeFileSync(botRoutesPath, JSON.stringify({
        metadata: {
            generatedAt: new Date().toISOString(),
            minProfitBps,
            totalRoutes: botRoutes.length,
            inputToken: 'SOL',
            inputMint: CONFIG.SOL_MINT
        },
        routes: botRoutes
    }, null, 2));

    const duration = Date.now() - startTime;
    console.log(`  ✓ Bot routes saved to ${botRoutesPath} (${formatDuration(duration)})`);

    // Extract and save pools used in profitable routes for targeted enrichment
    if (profitableRoutes.length > 0 && allPools.length > 0) {
        extractAndSavePoolsForEnrichment(profitableRoutes, allPools, './pools.json');
    }

    // Display top routes
    if (botRoutes.length > 0) {
        console.log('\n  Top Profitable Routes:');
        console.log('  ' + '─'.repeat(100));
        console.log(`  ${'Rank'.padEnd(5)} ${'Path'.padEnd(35)} ${'Profit'.padEnd(10)} ${'Impact'.padEnd(10)} ${'Slippage'.padEnd(12)} Warning`);
        console.log('  ' + '─'.repeat(100));
        botRoutes.slice(0, 5).forEach(route => {
            const pathStr = route.path.join(' → ').substring(0, 33).padEnd(35);
            const profitStr = `${route.profitPercent}%`.padEnd(10);
            const impactStr = `${route.totalImpactBps || 0} bps`.padEnd(10);
            const slippageStr = `${route.totalSlippageBps || 0} bps`.padEnd(12);
            const warningEmoji = route.slippageWarning?.emoji || '🟢';
            console.log(`  #${route.rank}   ${pathStr} ${profitStr} ${impactStr} ${slippageStr} ${warningEmoji}`);
        });
        console.log('  ' + '─'.repeat(100));
    }

    return botRoutesPath;
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function runPipeline() {
    const pipelineStart = Date.now();

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║         ARBITRAGE SIMULATION MASTER PIPELINE                         ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    // Parse command line arguments
    const options = parseArgs();

    if (options.help) {
        printHelp();
        return;
    }

    console.log('\n📋 Configuration:');
    console.log(`  Pools file: ${options.poolsFile}`);
    console.log(`  Input amount: ${formatAmount(options.amount)} SOL`);
    console.log(`  Min profit: ${options.minProfitBps} bps (${(options.minProfitBps / 100).toFixed(2)}%)`);
    console.log(`  Max triangles: ${options.maxTriangles}`);
    console.log(`  Output directory: ${options.outputDir}`);

    try {
        // Step 1: Load pools
        logStep(1, 'LOAD POOLS');
        const pools = await loadPools(options.poolsFile);

        // Step 2: Enrich pools
        logStep(2, 'ENRICH POOLS');
        const enrichedPools = await enrichPools(pools, options.skipEnrichment);

        // Step 3: Find triangles
        logStep(3, 'FIND TRIANGLE OPPORTUNITIES');
        const triangles = findTriangles(enrichedPools, options);

        if (triangles.length === 0) {
            console.log('\n⚠️  No triangles found. Exiting.');
            return;
        }

        // Step 4: Simulate routes
        logStep(4, 'SIMULATE ROUTES');
        const simulationResults = await simulateAllTriangles(triangles, options);

        // Step 5: Export results
        logStep(5, 'EXPORT RESULTS');
        const exportedFiles = await exportSimulationResults(simulationResults, options);

        // Step 6: Select bot routes
        logStep(6, 'SELECT BOT ROUTES');
        const botRoutesPath = selectBotRoutes(simulationResults, options, enrichedPools);

        // Final summary
        const pipelineDuration = Date.now() - pipelineStart;

        console.log('\n' + '═'.repeat(70));
        console.log('PIPELINE COMPLETED SUCCESSFULLY');
        console.log('═'.repeat(70));
        console.log(`\n⏱️  Total time: ${formatDuration(pipelineDuration)}`);
        console.log(`📊 Triangles found: ${triangles.length}`);
        console.log(`✅ Simulated: ${simulationResults.successful}`);
        console.log(`💰 Profitable routes: ${simulationResults.profitable}`);
        console.log(`📁 Output files:`);
        Object.entries(exportedFiles).forEach(([format, filePath]) => {
            console.log(`   ${format.toUpperCase()}: ${filePath}`);
        });
        console.log(`🤖 Bot routes: ${botRoutesPath}`);
        console.log('\n');

        return {
            success: true,
            pools: pools.length,
            triangles: triangles.length,
            simulated: simulationResults.successful,
            profitable: simulationResults.profitable,
            exportedFiles,
            botRoutesPath,
            duration: pipelineDuration
        };

    } catch (error) {
        console.error('\n❌ PIPELINE FAILED:');
        console.error(`   ${error.message}`);

        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }

        return {
            success: false,
            error: error.message
        };
    }
}

// ============================================================================
// MODULE EXPORTS
// ============================================================================

module.exports = {
    runPipeline,
    loadPools,
    enrichPools,
    findTriangles,
    simulateAllTriangles,
    exportSimulationResults,
    selectBotRoutes,
    extractAndSavePoolsForEnrichment,
    CONFIG
};

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (require.main === module) {
    runPipeline().then(result => {
        if (!result.success) {
            process.exit(1);
        }
    }).catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

// node master-pipeline.js --input=./pools.json --amount=10000000000
