'use strict';
/**
 * diagnose_triangles.js
 * 
 * Diagnoses why no triangle candidates are being found.
 * Logs detailed information about:
 *   1. Available pairs for tokenA (SOL)
 *   2. Potential intermediate tokens (tokenB)
 *   3. Potential third tokens (tokenC) 
 *   4. Why each triangle might be rejected
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Connection } = require('@solana/web3.js');

// ============================================================================
// CONFIG
// ============================================================================

const RPC_URL = process.env.RPC_URL || process.env.ALCHEMY_RPC_URL;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const short = (s) => s ? `${s.slice(0, 6)}..${s.slice(-4)}` : '?';

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function getFeeBpsFromPool(pool) {
    if (!pool) return 0;
    if (pool.feeBps != null) return Number(pool.feeBps) || 0;
    if (pool.feeRate != null) return Math.round(Number(pool.feeRate) * 10000) || 0;
    return 0;
}

function minFeeBpsForPools(pools) {
    if (!pools || pools.length === 0) return 0;
    let min = Number.POSITIVE_INFINITY;
    for (const p of pools) {
        const fee = getFeeBpsFromPool(p);
        if (fee < min) min = fee;
    }
    return Number.isFinite(min) ? min : 0;
}

function loadPools(poolsPath) {
    const resolved = path.isAbsolute(poolsPath)
        ? poolsPath
        : path.resolve(poolsPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`);
    }

    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.pools || raw.data || []);
}

function getPoolMints(pool) {
    const base = pool.baseMint || pool.mintA || pool.tokenMintA;
    const quote = pool.quoteMint || pool.mintB || pool.tokenMintB;
    return { base, quote };
}

function buildPairMap(pools) {
    const pairMap = new Map(); // "mintA-mintB" -> [pools]
    const mintToSymbol = new Map();

    for (const pool of pools) {
        const { base, quote } = getPoolMints(pool);
        if (!base || !quote) continue;

        // Store symbol mappings
        if (pool.baseSymbol) mintToSymbol.set(base, pool.baseSymbol);
        if (pool.quoteSymbol) mintToSymbol.set(quote, pool.quoteSymbol);

        // Store both directions
        const key1 = `${base}-${quote}`;
        const key2 = `${quote}-${base}`;

        if (!pairMap.has(key1)) pairMap.set(key1, []);
        if (!pairMap.has(key2)) pairMap.set(key2, []);

        pairMap.get(key1).push(pool);
        pairMap.get(key2).push(pool);
    }

    return { pairMap, mintToSymbol };
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

function canFormTriangle(pairMap, tokenA, tokenB, tokenC) {
    const hasAB = pairMap.has(`${tokenA}-${tokenB}`) || pairMap.has(`${tokenB}-${tokenA}`);
    const hasBC = pairMap.has(`${tokenB}-${tokenC}`) || pairMap.has(`${tokenC}-${tokenB}`);
    const hasCA = pairMap.has(`${tokenC}-${tokenA}`) || pairMap.has(`${tokenA}-${tokenC}`);
    return { hasAB, hasBC, hasCA, valid: hasAB && hasBC && hasCA };
}

function getPoolsForPair(pairMap, mintA, mintB) {
    return pairMap.get(`${mintA}-${mintB}`) || pairMap.get(`${mintB}-${mintA}`) || [];
}

// ============================================================================
// MAIN DIAGNOSTIC
// ============================================================================

async function diagnose(poolsPath, tokenAMint = SOL, meta = {}) {
    const sources = Array.isArray(meta.sources) ? meta.sources : [];
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TRIANGLE CANDIDATE DIAGNOSTIC');
    console.log('═══════════════════════════════════════════════════════════════');
    if (sources.length) {
        console.log(`Pool file(s): ${sources.join(', ')}`);
    } else {
        console.log(`Pool file: ${Array.isArray(poolsPath) ? '[in-memory pools]' : poolsPath}`);
    }
    console.log(`Token A: ${short(tokenAMint)}`);
    console.log('');

    // Load pools
    const pools = Array.isArray(poolsPath) ? poolsPath : loadPools(poolsPath);
    console.log(`📦 Loaded ${pools.length} pools`);

    // Build pair map
    const { pairMap, mintToSymbol } = buildPairMap(pools);
    console.log(`🔗 Found ${pairMap.size / 2} unique pairs`);
    console.log('');

    // Helper to get symbol
    const sym = (mint) => mintToSymbol.get(mint) || short(mint);

    // Step 1: Find all tokens connected to tokenA
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`STEP 1: Tokens connected to ${sym(tokenAMint)} (potential tokenB)`);
    console.log('───────────────────────────────────────────────────────────────');

    const tokenBs = findConnectedMints(pairMap, tokenAMint);
    console.log(`Found ${tokenBs.length} tokens connected to ${sym(tokenAMint)}:`);

    if (tokenBs.length === 0) {
        console.log('❌ NO TOKENS CONNECTED TO SOL!');
        console.log('   This means no pools have SOL as base or quote mint.');
        console.log('');
        console.log('   Checking pool structure...');

        // Debug: show what mints ARE in the pools
        const allMints = new Set();
        for (const pool of pools.slice(0, 5)) {
            console.log(`   Pool: ${JSON.stringify({
                baseMint: pool.baseMint?.slice(0, 10),
                quoteMint: pool.quoteMint?.slice(0, 10),
                mintA: pool.mintA?.slice(0, 10),
                mintB: pool.mintB?.slice(0, 10),
                type: pool.type || pool.poolType
            })}`);
        }
        return;
    }

    for (const tokenB of tokenBs) {
        const poolCount = getPoolsForPair(pairMap, tokenAMint, tokenB).length;
        console.log(`  ${sym(tokenB)} (${poolCount} pools)`);
    }
    console.log('');

    // Step 2: For each tokenB, find potential tokenCs
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 2: Finding triangle candidates');
    console.log('───────────────────────────────────────────────────────────────');

    const triangles = [];

    for (const tokenB of tokenBs) {
        // Find tokens connected to tokenB (potential tokenC)
        const tokenCs = findConnectedMints(pairMap, tokenB);

        for (const tokenC of tokenCs) {
            // Skip if tokenC is tokenA or tokenB
            if (tokenC === tokenAMint || tokenC === tokenB) continue;

            // Check if we can complete the triangle back to tokenA
            const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);

            if (check.valid) {
                const poolsAB = getPoolsForPair(pairMap, tokenAMint, tokenB);
                const poolsBC = getPoolsForPair(pairMap, tokenB, tokenC);
                const poolsCA = getPoolsForPair(pairMap, tokenC, tokenAMint);
                const minFeeBpsAB = minFeeBpsForPools(poolsAB);
                const minFeeBpsBC = minFeeBpsForPools(poolsBC);
                const minFeeBpsCA = minFeeBpsForPools(poolsCA);
                const minTotalFeeBps = minFeeBpsAB + minFeeBpsBC + minFeeBpsCA;

                triangles.push({
                    path: `${sym(tokenAMint)} → ${sym(tokenB)} → ${sym(tokenC)} → ${sym(tokenAMint)}`,
                    tokenA: tokenAMint,
                    tokenB,
                    tokenC,
                    poolsAB: poolsAB.length,
                    poolsBC: poolsBC.length,
                    poolsCA: poolsCA.length,
                    totalCombinations: poolsAB.length * poolsBC.length * poolsCA.length,
                    minFeeBpsAB,
                    minFeeBpsBC,
                    minFeeBpsCA,
                    minTotalFeeBps
                });
            }
        }
    }

    console.log(`Found ${triangles.length} valid triangles:`);
    console.log('');

    if (triangles.length === 0) {
        console.log('❌ NO VALID TRIANGLES FOUND');
        console.log('');
        console.log('Debugging why...');

        // Show what's missing
        for (const tokenB of tokenBs.slice(0, 5)) {
            console.log(`\n  Checking ${sym(tokenB)}:`);
            const tokenCs = findConnectedMints(pairMap, tokenB);
            console.log(`    Connected to ${tokenCs.length} other tokens`);

            for (const tokenC of tokenCs.slice(0, 3)) {
                if (tokenC === tokenAMint || tokenC === tokenB) continue;
                const check = canFormTriangle(pairMap, tokenAMint, tokenB, tokenC);
                console.log(`    ${sym(tokenC)}: AB=${check.hasAB}, BC=${check.hasBC}, CA=${check.hasCA}`);
                if (!check.hasCA) {
                    console.log(`      ⚠️ Missing ${sym(tokenC)} → ${sym(tokenAMint)} pool!`);
                }
            }
        }
    } else {
        // Sort by lowest min total fee, then by combinations
        triangles.sort((a, b) => {
            if (a.minTotalFeeBps !== b.minTotalFeeBps) return a.minTotalFeeBps - b.minTotalFeeBps;
            return b.totalCombinations - a.totalCombinations;
        });

        for (const tri of triangles.slice(0, 20)) {
            console.log(`  ✓ ${tri.path}`);
            console.log(`    Pools: AB=${tri.poolsAB}, BC=${tri.poolsBC}, CA=${tri.poolsCA}`);
            console.log(`    Combinations: ${tri.totalCombinations}`);
            console.log(`    Min fee bps: AB=${tri.minFeeBpsAB}, BC=${tri.minFeeBpsBC}, CA=${tri.minFeeBpsCA}, total=${tri.minTotalFeeBps}`);
        }

        if (triangles.length > 20) {
            console.log(`  ... and ${triangles.length - 20} more`);
        }
    }

    console.log('');

    // Step 3: Show pool types breakdown
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 3: Pool types in file');
    console.log('───────────────────────────────────────────────────────────────');

    const typeCount = {};
    const dexCount = {};

    for (const pool of pools) {
        const type = pool.type || pool.poolType || 'unknown';
        const dex = pool.dex || 'unknown';
        typeCount[type] = (typeCount[type] || 0) + 1;
        dexCount[dex] = (dexCount[dex] || 0) + 1;
    }

    console.log('By type:');
    for (const [type, count] of Object.entries(typeCount)) {
        console.log(`  ${type}: ${count}`);
    }

    console.log('\nBy dex:');
    for (const [dex, count] of Object.entries(dexCount)) {
        console.log(`  ${dex}: ${count}`);
    }

    console.log('');

    // Step 4: Check SOL specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 4: SOL pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const solPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === SOL || quote === SOL;
    });

    console.log(`Pools with SOL: ${solPools.length}`);

    for (const pool of solPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = pool.type || pool.poolType || '?';
        const other = base === SOL ? quote : base;
        console.log(`  ${sym(SOL)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO SOL POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
    }



    // Step 5: Check USDC specifically
    console.log('───────────────────────────────────────────────────────────────');
    console.log('STEP 5: USDC pools specifically');
    console.log('───────────────────────────────────────────────────────────────');

    const usdcPools = pools.filter(p => {
        const { base, quote } = getPoolMints(p);
        return base === USDC || quote === USDC;
    });

    console.log(`Pools with USDC: ${usdcPools.length}`);

    for (const pool of usdcPools.slice(0, 30)) {
        const { base, quote } = getPoolMints(pool);
        const type = pool.type || pool.poolType || '?';
        const other = base === USDC ? quote : base;
        console.log(`  ${sym(USDC)} ↔ ${sym(other)} [${type}] ${short(pool.poolAddress || pool.address)}`);
    }

    if (solPools.length === 0) {
        console.log('');
        console.log('❌ NO USDC POOLS FOUND!');
        console.log('');
        console.log('Sample pool structure:');
        const sample = pools[0];
        console.log(JSON.stringify(sample, null, 2).slice(0, 1000));
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('DIAGNOSTIC COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');

    return { triangles, tokenBs, solPools, usdcPools, sources };
}



// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
    const parseArgs = (argv) => {
        const out = { inputs: [], tokenA: null, output: null };
        for (let i = 0; i < argv.length; i++) {
            const a = argv[i];
            if (!a) continue;
            const kv = a.match(/^([a-zA-Z][\\w-]*)=(.*)$/);
            if (kv) {
                let val = kv[2];
                if (val === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) val = argv[++i];
                const key = kv[1].toLowerCase();
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out') out.output = val;
                continue;
            }
            if (a.startsWith('--')) {
                const key = a.replace(/^--?/, '').toLowerCase();
                let val = argv[i + 1];
                if (val && val.startsWith('--')) val = '';
                if (val !== '' && val != null && !val.startsWith('--')) i++;
                if (key === 'input' || key === 'in') out.inputs.push(...String(val).split(',').map(s => s.trim()).filter(Boolean));
                if (key === 'token' || key === 'tokena') out.tokenA = val;
                if (key === 'output' || key === 'out') out.output = val;
                continue;
            }
            out.inputs.push(a);
        }
        return out;
    };

    const parsed = parseArgs(process.argv.slice(2));
    const inputs = parsed.inputs.length ? parsed.inputs : ['out/custom_raw-E.json'];
    const tokenA = parsed.tokenA || SOL;

    const mergedPools = [];
    const loadedSources = [];
    const skippedSources = [];
    for (const p of inputs) {
        if (!p) continue;
        if (!fs.existsSync(p)) {
            console.warn(`Input not found: ${p}`);
            skippedSources.push({ path: p, reason: 'not_found' });
            continue;
        }
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(raw)) {
            mergedPools.push(...raw);
            loadedSources.push(p);
            continue;
        }
        if (Array.isArray(raw?.pools)) {
            mergedPools.push(...raw.pools);
            loadedSources.push(p);
            continue;
        }
        if (Array.isArray(raw?.data)) {
            mergedPools.push(...raw.data);
            loadedSources.push(p);
            continue;
        }
        if (raw?.fastQuote || raw?.exactQuote) {
            console.warn(`Skipping quote-only file (no pools): ${p}`);
            skippedSources.push({ path: p, reason: 'quote_only' });
            continue;
        }
        console.warn(`Unrecognized input shape: ${p}`);
        skippedSources.push({ path: p, reason: 'unrecognized_shape' });
    }

    if (!mergedPools.length) {
        console.error('No pools loaded from inputs. Aborting.');
        process.exit(1);
    }

    diagnose(mergedPools, tokenA, { sources: loadedSources, skippedSources }).then((result) => {
        if (parsed.output) {
            fs.writeFileSync(parsed.output, JSON.stringify(result, null, 2));
            console.log(`Output saved: ${parsed.output}`);
        }
    }).catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}
//=============================================================
//. 3 leg swap

//=============================================================


function getBestPool(tokenPairs, mintA, mintB) {
    const key = `${mintA}-${mintB}`;
    const pools = tokenPairs.get(key) || [];

    if (pools.length === 0) return null;

    // Sort by liquidity descending, then fee ascending
    return pools.sort((a, b) => {
        const liqA = a.liquidityUSD || 0;
        const liqB = b.liquidityUSD || 0;
        const feeA = a.feeBps || 100;
        const feeB = b.feeBps || 100;

        if (liqB !== liqA) return liqB - liqA;
        return feeA - feeB;
    })[0];
}

function getTokenSymbol(mint) {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

    const symbols = {
        [SOL_MINT]: 'SOL',
        [USDC_MINT]: 'USDC',
        [USDT_MINT]: 'USDT',
    };

    return symbols[mint] || mint.slice(0, 4) + '...' + mint.slice(-4);
}

// Enhanced slippage calculation
function calculateSlippage(pool, amountIn, direction) {
    const poolType = pool.type || pool.poolType || 'unknown';
    let baseSlippage = 50; // 0.5% base

    if (pool.liquidityUSD) {
        // Adjust based on liquidity
        if (pool.liquidityUSD < 100000) baseSlippage = 200; // 2%
        else if (pool.liquidityUSD < 500000) baseSlippage = 100; // 1%
        else if (pool.liquidityUSD < 1000000) baseSlippage = 50; // 0.5%
        else baseSlippage = 25; // 0.25%
    }

    // Size adjustment (if amount is large relative to liquidity)
    if (pool.xReserve && pool.yReserve) {
        const relevantReserve = direction === 'A2B' ? pool.xReserve : pool.yReserve;
        const reserveAmount = parseFloat(relevantReserve) || 0;
        const inputRatio = amountIn / reserveAmount;

        if (inputRatio > 0.01) { // >1% of reserve
            baseSlippage *= (1 + inputRatio * 10);
        }
    }

    // Cap at maximum
    return Math.min(baseSlippage, this.config.MAX_SLIPPAGE_BPS);
}

// Helper: detect a USDC<->USDT leg by mint or symbol
function isUSDCUSDTLeg(pool, legInfo = null) {
    const inMint = legInfo?.inputMint || pool.baseMint || pool.mintA || pool.tokenXMint || pool.tokenAMint || '';
    const outMint = legInfo?.outputMint || pool.quoteMint || pool.mintB || pool.tokenYMint || pool.tokenBMint || '';
    const hasUSDC = [inMint, outMint].some(m => typeof m === 'string' && m.startsWith('EPjF'));
    const hasUSDT = [inMint, outMint].some(m => typeof m === 'string' && m.startsWith('Es9v'));
    if (hasUSDC && hasUSDT) return true;

    // Fallback to symbols if mints not present
    const aSym = (pool.tokenASymbol || pool.symbolA || legInfo?.from || '').toUpperCase();
    const bSym = (pool.tokenBSymbol || pool.symbolB || legInfo?.to || '').toUpperCase();
    const syms = [aSym, bSym];
    if (syms.includes('USDC') && syms.includes('USDT')) return true;

    return false;
}

// Simulate swap through a pool
function simulateSwap(pool, amountIn, direction, legInfo = null) {
    const poolType = pool.type || pool.poolType || 'unknown';
    const feeBps = pool.feeBps || 25;
    const slippageBps = this.calculateSlippage(pool, amountIn, direction);

    // Hard block: USDC<->USDT off-peg quotes outside ±0.5%
    if (this.isUSDCUSDTLeg(pool, legInfo)) {
        // Calculate implied price from pool
        let impliedPrice = 1;
        if (pool.sqrtPriceX64) {
            const sqrtPrice = parseFloat(pool.sqrtPriceX64);
            const rawPrice = sqrtPrice * sqrtPrice / Math.pow(2, 128);
            const dec0 = pool.baseDecimals || 6;
            const dec1 = pool.quoteDecimals || 6;
            impliedPrice = rawPrice * Math.pow(10, dec0 - dec1);
        } else if (pool.xReserve && pool.yReserve) {
            const x = parseFloat(pool.xReserve);
            const y = parseFloat(pool.yReserve);
            impliedPrice = (x > 0 && y > 0) ? y / x : 1;
        }
        const deviation = Math.abs(impliedPrice - 1);
        if (!(impliedPrice > 0) || deviation > 0.005) {
            console.debug(`Stable sanity block: USDC/USDT px=${impliedPrice.toFixed(6)} deviation=${deviation.toFixed(4)}`);
            return {
                amountOut: 0,
                feeBps,
                slippageBps,
                priceUsed: impliedPrice,
                blocked: true,
                error: `Stable pair off-peg: px=${impliedPrice}`
            };
        }
    }

    // Calculate price based on pool type
    let price = 1;

    switch (poolType.toLowerCase()) {
        case 'whirlpool':
        case 'clmm':

            break;

        case 'dlmm':
            if (pool.bins && pool.bins.length > 0) {
                // Use active bin price
                const activeBin = pool.bins.find(b => b.active) || pool.bins[0];
                if (activeBin && activeBin.price) {
                    price = activeBin.price;
                }
            }
            break;

        case 'cpmm':
            if (pool.xReserve && pool.yReserve) {
                const xReserve = parseFloat(pool.xReserve);
                const yReserve = parseFloat(pool.yReserve);
                if (xReserve > 0 && yReserve > 0) {
                    price = direction === 'A2B' ? yReserve / xReserve : xReserve / yReserve;
                }
            }
            break;
    }

    // Apply fee and slippage
    const fee = amountIn * (feeBps / 10000);
    const amountAfterFee = amountIn - fee;
    const slippage = amountAfterFee * (slippageBps / 10000);
    const amountAfterSlippage = amountAfterFee - slippage;

    const amountOut = amountAfterSlippage * price;

    return {
        amountOut: Math.floor(amountOut),
        feeBps,
        slippageBps,
        priceUsed: price
    };
}

// Simulate complete triangle arbitrage
async function simulateTriangle(triangle, inputAmount = this.config.DEFAULT_INPUT_AMOUNT) {
    const results = {
        triangle: triangle.path.join(' → '),
        inputAmount,
        swaps: [],
        totalOutput: 0,
        profit: 0,
        profitBps: 0,
        feasible: true
    };

    let currentAmount = inputAmount;

    // Leg 1: SOL → tokenB
    const swap1 = this.simulateSwap(triangle.pools[0], currentAmount, 'A2B');
    results.swaps.push({
        leg: 'SOL → ' + triangle.path[1],
        pool: triangle.pools[0].address?.slice(0, 8) + '...',
        type: triangle.pools[0].type,
        amountIn: currentAmount,
        amountOut: swap1.amountOut,
        feeBps: swap1.feeBps,
        slippageBps: swap1.slippageBps,
        price: swap1.priceUsed
    });
    currentAmount = swap1.amountOut;

    // Leg 2: tokenB → tokenC
    const swap2 = this.simulateSwap(triangle.pools[1], currentAmount, 'A2B');
    results.swaps.push({
        leg: triangle.path[1] + ' → ' + triangle.path[2],
        pool: triangle.pools[1].address?.slice(0, 8) + '...',
        type: triangle.pools[1].type,
        amountIn: currentAmount,
        amountOut: swap2.amountOut,
        feeBps: swap2.feeBps,
        slippageBps: swap2.slippageBps,
        price: swap2.priceUsed
    });
    currentAmount = swap2.amountOut;

    // Leg 3: tokenC → SOL
    const swap3 = this.simulateSwap(triangle.pools[2], currentAmount, 'A2B');
    results.swaps.push({
        leg: triangle.path[2] + ' → SOL',
        pool: triangle.pools[2].address?.slice(0, 8) + '...',
        type: triangle.pools[2].type,
        amountIn: currentAmount,
        amountOut: swap3.amountOut,
        feeBps: swap3.feeBps,
        slippageBps: swap3.slippageBps,
        price: swap3.priceUsed
    });

    results.totalOutput = swap3.amountOut;
    results.profit = results.totalOutput - inputAmount;
    results.profitBps = (results.profit / inputAmount) * 10000;

    // Check if profitable after minimum threshold
    results.feasible = results.profitBps >= this.config.MIN_PROFIT_BPS;

    return results;
}

// Batch process triangles
async function simulateAllTriangles(triangles) {
    console.log(`🤖 Simulating ${triangles.length} triangles...`);

    const results = [];
    const batchSize = 5;

    for (let i = 0; i < triangles.length; i += batchSize) {
        const batch = triangles.slice(i, i + batchSize);
        console.log(`  Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(triangles.length / batchSize)}`);

        const batchPromises = batch.map(triangle =>
            this.rateLimiter.enqueue(() => this.simulateTriangle(triangle))
        );

        const batchResults = await Promise.allSettled(batchPromises);

        for (let j = 0; j < batchResults.length; j++) {
            const result = batchResults[j];
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                console.warn(`  Failed to simulate triangle ${i + j}:`, result.reason?.message);
            }
        }

        // Garbage collection hint
        if (global.gc) {
            global.gc();
        }

        await new Promise(r => setTimeout(r, 100));
    }

    return results;
}

// Export results
function exportResults(results, format = 'all') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = `./exports/arbitrage_${timestamp}`;

    if (!fs.existsSync('./exports')) {
        fs.mkdirSync('./exports', { recursive: true });
    }

    // Filter profitable triangles
    const profitable = results.filter(r => r.feasible);
    const sorted = profitable.sort((a, b) => b.profitBps - a.profitBps);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('📊 ARBITRAGE RESULTS');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`Total triangles simulated: ${results.length}`);
    console.log(`Profitable triangles: ${profitable.length}`);
    console.log(`Success rate: ${(profitable.length / results.length * 100).toFixed(1)}%`);
    console.log('');

    if (profitable.length > 0) {
        console.log('TOP PROFITABLE TRIANGLES:');
        console.log('┌───────┬────────────────────────────┬──────────────┬──────────────┬─────────────┐');
        console.log('│ Rank  │ Triangle                   │ Input (SOL)  │ Output (SOL) │ Profit (bps)│');
        console.log('├───────┼────────────────────────────┼──────────────┼──────────────┼─────────────┤');

        sorted.slice(0, 10).forEach((result, index) => {
            const inputSol = (result.inputAmount / 1e9).toFixed(4);
            const outputSol = (result.totalOutput / 1e9).toFixed(4);
            console.log(`│ ${(index + 1).toString().padEnd(5)} │ ${result.triangle.padEnd(26)} │ ${inputSol.padStart(12)} │ ${outputSol.padStart(12)} │ ${result.profitBps.toFixed(1).padStart(11)} │`);
        });
        console.log('└───────┴────────────────────────────┴──────────────┴──────────────┴─────────────┘');

        // Detailed view of top triangle
        if (sorted.length > 0) {
            console.log('\n🔍 DETAILS FOR TOP TRIANGLE:');
            const top = sorted[0];
            top.swaps.forEach((swap, i) => {
                console.log(`  Leg ${i + 1}: ${swap.leg}`);
                console.log(`    Pool: ${swap.pool} (${swap.type})`);
                const tokenIn = swap.leg.split('→')[0].trim();
                const tokenOut = swap.leg.split('→')[1].trim();
                console.log(`    Amount in: ${(swap.amountIn / 1e9).toFixed(6)} ${tokenIn}`);
                console.log(`    Amount out: ${(swap.amountOut / 1e9).toFixed(6)} ${tokenOut}`);
                console.log(`    Fee: ${swap.feeBps} bps, Slippage: ${swap.slippageBps.toFixed(1)} bps`);
                console.log(`    Price: ${swap.price.toFixed(6)}`);
            });
        }
    }

    // Export to files
    if (format === 'json' || format === 'all') {
        fs.writeFileSync(`${basePath}.json`, JSON.stringify({
            timestamp,
            totalSimulated: results.length,
            profitable: profitable.length,
            triangles: sorted
        }, null, 2));
        console.log(`\n💾 JSON exported to: ${basePath}.json`);
    }

    if (format === 'csv' || format === 'all') {
        let csv = 'Rank,Triangle,Input_SOL,Output_SOL,Profit_BPS,Pool1_Address,Pool1_Type,Pool2_Address,Pool2_Type,Pool3_Address,Pool3_Type\n';

        sorted.forEach((result, index) => {
            csv += `${index + 1},${result.triangle},${result.inputAmount / 1e9},${result.totalOutput / 1e9},${result.profitBps}`;
            result.swaps.forEach(swap => {
                csv += `,${swap.pool},${swap.type}`;
            });
            csv += '\n';
        });

        fs.writeFileSync(`${basePath}.csv`, csv);
        console.log(`📊 CSV exported to: ${basePath}.csv`);
    }

    return {
        total: results.length,
        profitable: profitable.length,
        topTriangles: sorted.slice(0, 10)
    };
}

function parseArgs(argv) {
    const out = { input: null, help: false, pos: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (a === '--help' || a === '-h') { out.help = true; continue; }
        const kv = a.match(/^([a-zA-Z][\\w-]*)=(.*)$/);
        if (kv) {
            let val = kv[2];
            if (val === '' && argv[i + 1] && !argv[i + 1].startsWith('-')) val = argv[++i];
            if (['input', 'in'].includes(kv[1])) out.input = val;
            continue;
        }
        if (a.startsWith('--')) {
            const key = a.replace(/^--?/, '').toLowerCase();
            let val = argv[i + 1];
            if (val && val.startsWith('--')) val = '';
            if (val !== '' && val != null && !val.startsWith('--')) i++;
            if (['input', 'in'].includes(key)) out.input = val;
            continue;
        }
        out.pos.push(a);
    }
    return out;
}

// Run only when called directly
if (require.main === module) {
    const parsed = parseArgs(process.argv.slice(2));
    const filePath = parsed.input || parsed.pos[0];
    if (!filePath) {
        console.log('Usage: node _diagnose_pools.js  --input <json_file>');
        process.exit(1);
    }

    diagnose(filePath);
}

module.exports = { diagnose, loadPools, buildPairMap, findConnectedMints, canFormTriangle };


/*
 
 node ref/enrich_all_unified.js  out/custom_raw-E.json
 node triangle_sim_math.js out/custom_raw-E.json
 
 node tools/_diagnose_triangles.js out/custom_raw-E.json
 node triangle_sim_math.js out/custom_raw-E.json

  node utils/_diagnose_trianglesBackup.js poolsAll.json
*/