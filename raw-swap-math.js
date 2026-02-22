/**
 * Raw Swap Math - Universal for all pool types
 * Works with any token decimals because we always use raw integer units
 * 
 * DYNAMIC PRICE IMPACT MODEL:
 * - Impact is calculated based on trade size relative to pool liquidity
 * - No hardcoded base impact - purely mathematical from pool depth
 * - Formula: impact ≈ (amountIn / reserve) * scaling_factor
 */

const Q64 = 1n << 64n;

// Maximum impact cap to prevent unrealistic values
const MAX_IMPACT_BPS = 500; // 5% max impact

/**
 * Safely convert a value to BigInt
 * Handles strings, numbers, BigInt, and objects
 */
function toBigInt(val) {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'string') {
        // Handle empty or invalid strings
        if (!val || val === 'null' || val === 'undefined') return 0n;
        try {
            return BigInt(val);
        } catch {
            return 0n;
        }
    }
    if (typeof val === 'number') {
        if (!isFinite(val) || isNaN(val)) return 0n;
        return BigInt(Math.floor(val));
    }
    // Handle objects (like { liquidityUsd: ... })
    if (typeof val === 'object' && val !== null) {
        // Try to extract a numeric value
        if (val.liquidity) return toBigInt(val.liquidity);
        if (val.amount) return toBigInt(val.amount);
        if (val.value) return toBigInt(val.value);
        return 0n;
    }
    return 0n;
}

/**
 * Calculate dynamic price impact based on trade size vs pool depth
 * Uses constant product formula approximation: impact ≈ amountIn / (reserve + amountIn)
 * 
 * @param {BigInt} amountIn - Input amount in raw units
 * @param {BigInt} reserve - Pool reserve in same units
 * @returns {number} Impact in basis points (1-500), minimum 1 bps for realism
 */
function calculateDynamicImpactBps(amountIn, reserve) {
    if (reserve <= 0n) return 1; // Minimum 1 bps even with no reserve data

    // Use constant product impact formula
    // For a swap in CPMM: price impact ≈ amountIn / (reserveIn + amountIn)
    // This gives the natural slippage from the curve
    const numerator = Number(amountIn);
    const denominator = Number(reserve + amountIn);

    if (denominator === 0) return 1;

    // Calculate raw impact as ratio
    const impactRatio =
        Number(amountIn * 10000n / (reserve + amountIn)) / 10000;// Cap at maximum allowed impact
    const MAX_IMPACT_BPS = 500;

    // Convert to basis points (0.0001 = 1 bps)
    // Apply a scaling factor to be conservative (1.5x the theoretical minimum)
    let impactBps = Math.floor(impactRatio * 10000 * 1.5);

    // Minimum 1 bps impact for any trade (accounts for spread, tick size, MEV)
    if (impactBps < 1) impactBps = 1;

    return Math.min(impactBps, MAX_IMPACT_BPS);
}

// Legacy function for backward compatibility (returns 0, impact is now dynamic)
function calculateImpactBps(amountIn, reserve, baseImpactBps = 0) {
    return calculateDynamicImpactBps(amountIn, reserve);
}

// ============================================================================
// CPMM (Constant Product)
// Formula: (x + dx) * (y - dy) = x * y
// ============================================================================

function quoteCpmmRaw(reserveA, reserveB, amountIn, feeBps, direction) {
    if (amountIn <= 0n) return { success: false, amountOut: 0n, impactBps: 0 };
    if (reserveA <= 0n || reserveB <= 0n) return { success: false, amountOut: 0n, impactBps: 0 };

    const inputReserve = direction === 'A2B' ? reserveA : reserveB;

    // Apply fee ONLY
    const amountInAfterFee =
        (amountIn * BigInt(10000 - Number(feeBps))) / 10000n;

    let amountOut;

    if (direction === 'A2B') {
        amountOut =
            (reserveB * amountInAfterFee) /
            (reserveA + amountInAfterFee);
    } else {
        amountOut =
            (reserveA * amountInAfterFee) /
            (reserveB + amountInAfterFee);
    }

    // Compute impact for reporting only
    const impactBps = calculateDynamicImpactBps(amountIn, inputReserve);

    return { success: true, amountOut, impactBps };
}

// ============================================================================
// CLMM/Whirlpool (Concentrated Liquidity)
// Uses Q64.64 fixed-point math - no decimal conversion needed
// ============================================================================

function tickToSqrtPriceX64(tick) {
    const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
    if (!isFinite(sqrtPrice) || sqrtPrice <= 0) return 0n;
    const raw = Math.floor(sqrtPrice * 18446744073709551616.0);
    if (!isFinite(raw)) return 0n;
    return BigInt(raw);
}

function nextSqrtPriceFromAmount0In(sqrt, L, amount0In) {
    const LQ = L * Q64;
    const numerator = LQ * sqrt;
    const denom = LQ + amount0In * sqrt;
    return denom === 0n ? 0n : numerator / denom;
}

function nextSqrtPriceFromAmount1In(sqrt, L, amount1In) {
    const delta = (amount1In * Q64) / L;
    return sqrt + delta;
}

function quoteClmmRaw(sqrtPriceX64, liquidity, tickCurrent, tickSpacing, feeBps, amountIn, direction) {
    if (amountIn <= 0n || liquidity <= 0n) return { success: false, amountOut: 0n, impactBps: 0 };

    // FIX Bug5: CLMM sqrt-price math already models price impact through liquidity depth.
    // Do NOT apply an extra impactBps deduction to inAfterFee - that double-counts impact.
    // impactBps is retained as a display/logging metric only.
    // (liquidity is in L-units, not token units, so calculateDynamicImpactBps on it
    //  was also dimensionally wrong - it just happened to produce ~1 bps for large L values.)
    const impactBps = 0; // reported as 0; real impact is encoded in sqrtPrice movement

    // Apply fee only (no extra impact deduction)
    let inAfterFee = (amountIn * BigInt(10000 - Number(feeBps))) / 10000n;

    const sqrt0 = sqrtPriceX64;

    // Calculate boundary tick
    let nextTickSqrtPriceX64;
    if (direction === 'A2B') {
        const lowerTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        nextTickSqrtPriceX64 = tickToSqrtPriceX64(lowerTick);
    } else {
        const upperTick = (Math.floor(tickCurrent / tickSpacing) + 1) * tickSpacing;
        nextTickSqrtPriceX64 = tickToSqrtPriceX64(upperTick);
    }

    let sqrt1, amountOut;

    if (direction === 'A2B') {
        sqrt1 = nextSqrtPriceFromAmount0In(sqrt0, liquidity, inAfterFee);
        if (sqrt1 < nextTickSqrtPriceX64) sqrt1 = nextTickSqrtPriceX64;
        const delta = sqrt0 - sqrt1;
        if (delta <= 0n) return { success: false, amountOut: 0n, impactBps };
        amountOut = (liquidity * delta) / Q64;
    } else {
        sqrt1 = nextSqrtPriceFromAmount1In(sqrt0, liquidity, inAfterFee);
        if (sqrt1 > nextTickSqrtPriceX64) sqrt1 = nextTickSqrtPriceX64;
        const delta = sqrt1 - sqrt0;
        if (delta <= 0n) return { success: false, amountOut: 0n, impactBps };
        const num = liquidity * Q64 * delta;
        const den = sqrt1 * sqrt0;
        amountOut = num / den;
    }

    return { success: true, amountOut, impactBps };
}

// ============================================================================
// DLMM (Dynamic Liquidity)
// ============================================================================

function quoteDlmmRaw(bins, activeBinId, binStep, amountIn, feeBps, direction) {
    if (amountIn <= 0n || !bins || bins.length === 0) return { success: false, amountOut: 0n, impactBps: 0 };

    const base = 1 + binStep / 10000;

    // Helper to safely get BigInt from potentially object values
    const safeBigInt = (val) => {
        if (typeof val === 'bigint') return val;
        if (typeof val === 'string') return BigInt(val);
        if (typeof val === 'number') return BigInt(Math.floor(val));
        return 0n;
    };

    // Apply fee ONLY (no impact deduction here)
    let remain = (amountIn * BigInt(10000 - Number(feeBps))) / 10000n;

    let outAcc = 0n;

    const sortedBins = [...bins].sort((a, b) => direction === 'A2B' ? b.binId - a.binId : a.binId - b.binId);

    for (const bin of sortedBins) {
        if (remain <= 0n) break;

        const amountX = toBigInt(bin.reserveA);
        const amountY = toBigInt(bin.reserveB);

        if (direction === 'A2B') {
            if (amountY <= 0n) continue;
            // FIX Bug6: prefer pre-computed pxAB_Q64 if stored by enricher; else compute
            const priceQ64 = bin.pxAB_Q64 && bin.pxAB_Q64 > 0n
                ? bin.pxAB_Q64
                : BigInt(Math.floor(Math.pow(base, bin.binId) * Number(Q64)));
            if (priceQ64 <= 0n) continue;

            let outPotential = (remain * priceQ64) / Q64;
            if (outPotential > amountY) outPotential = amountY;
            if (outPotential <= 0n) continue;

            const inNet = (outPotential * Q64 + priceQ64 - 1n) / priceQ64;
            const inGross = (inNet * 10000n + BigInt(10000 - Number(feeBps)) - 1n) / BigInt(10000 - Number(feeBps));

            outAcc += outPotential;
            remain -= inGross > remain ? remain : inGross;
        } else {
            if (amountX <= 0n) continue;
            // FIX Bug6: prefer pre-computed pxAB_Q64
            const priceQ64 = bin.pxAB_Q64 && bin.pxAB_Q64 > 0n
                ? bin.pxAB_Q64
                : BigInt(Math.floor(Math.pow(base, bin.binId) * Number(Q64)));
            if (priceQ64 <= 0n) continue;

            const pxBA = (Q64 * Q64) / priceQ64;
            let outPotential = (remain * pxBA) / Q64;
            if (outPotential > amountX) outPotential = amountX;
            if (outPotential <= 0n) continue;

            const inNet = (outPotential * Q64 + pxBA - 1n) / pxBA;
            const inGross = (inNet * 10000n + BigInt(10000 - Number(feeBps)) - 1n) / BigInt(10000 - Number(feeBps));

            outAcc += outPotential;
            remain -= inGross > remain ? remain : inGross;
        }
    }
    if (outAcc <= 0n) {
        return { success: false, amountOut: 0n, impactBps: 0 };
    }

    // Estimate impact based on first bin price vs executed output
    const firstBin = sortedBins[0];

    let bestPriceQ64 =
        firstBin.pxAB_Q64 && firstBin.pxAB_Q64 > 0n
            ? firstBin.pxAB_Q64
            : BigInt(Math.floor(Math.pow(base, firstBin.binId) * Number(Q64)));

    let idealOut;

    if (direction === 'A2B') {
        idealOut = (amountIn * bestPriceQ64) / Q64;
    } else {
        const pxBA = (Q64 * Q64) / bestPriceQ64;
        idealOut = (amountIn * pxBA) / Q64;
    }

    let impactBps = 0;

    if (idealOut > 0n && idealOut > outAcc) {
        impactBps = Number(((idealOut - outAcc) * 10000n) / idealOut);
    }

    return {
        success: true,
        amountOut: outAcc,
        impactBps
    };

}

// ============================================================================
// Universal Pool Quote
// ============================================================================

function quotePoolRaw(pool, amountIn, direction) {
    const type = (pool.type || '').toLowerCase();

    if (type === 'cpmm') {
        return quoteCpmmRaw(
            toBigInt(pool.xReserve),
            toBigInt(pool.yReserve),
            amountIn,
            pool.feeBps || 25,
            direction
        );
    }

    if (type === 'clmm' || type === 'whirlpool') {
        return quoteClmmRaw(
            toBigInt(pool.sqrtPriceX64),
            toBigInt(pool.liquidity),
            pool.tickCurrent || 0,
            pool.tickSpacing || 64,
            pool.feeBps || 25,
            amountIn,
            direction
        );
    }

    if (type === 'dlmm') {
        return quoteDlmmRaw(
            pool.bins || [],
            pool.activeBinId || 0,
            pool.binStep || 100,
            amountIn,
            pool.feeBps || 25,
            direction
        );
    }

    return { success: false, amountOut: 0n, impactBps: 0 };
}

// ============================================================================
// Direction Resolution
// Returns 'A2B' if selling base, 'B2A' if selling quote
// ============================================================================

function resolveSwapDirection(pool, inputMint) {
    const baseMint = pool.baseMint || pool.mintA || pool.tokenA?.mint;
    const quoteMint = pool.quoteMint || pool.mintB || pool.tokenB?.mint;

    if (!inputMint || !baseMint || !quoteMint) return 'A2B';
    if (inputMint === baseMint) return 'A2B';
    if (inputMint === quoteMint) return 'B2A';

    // Fallback to token order fields
    const tokenAMint = pool.tokenAMint || pool.tokenMint0 || pool.tokenMintA;
    const tokenBMint = pool.tokenBMint || pool.tokenMint1 || pool.tokenMintB;
    if (inputMint === tokenAMint) return 'A2B';
    if (inputMint === tokenBMint) return 'B2A';

    return 'A2B';
}

// ============================================================================
// 3-Leg Triangle Simulation
// ============================================================================

function simulateTriangleRaw(pools, tokens, amountIn) {
    const [pool1, pool2, pool3] = pools;
    const [tokenA, tokenB, tokenC] = tokens;

    // Leg 1: A -> B
    const dir1 = resolveSwapDirection(pool1, tokenA);
    const r1 = quotePoolRaw(pool1, amountIn, dir1);
    if (!r1.success) return { success: false, error: 'Leg 1 failed', leg: 1 };

    // Leg 2: B -> C
    const dir2 = resolveSwapDirection(pool2, tokenB);
    const r2 = quotePoolRaw(pool2, r1.amountOut, dir2);
    if (!r2.success) return { success: false, error: 'Leg 2 failed', leg: 2 };

    // Leg 3: C -> A
    const dir3 = resolveSwapDirection(pool3, tokenC);
    const r3 = quotePoolRaw(pool3, r2.amountOut, dir3);
    if (!r3.success) return { success: false, error: 'Leg 3 failed', leg: 3 };

    const profit = r3.amountOut - amountIn;
    const profitBps = Number((profit * 10000n) / amountIn);

    return {
        success: true,
        input: amountIn,
        output: r3.amountOut,
        profit,
        profitBps,
        legs: [
            { pool: pool1.poolAddress, poolType: pool1.type, dir: dir1, in: amountIn, out: r1.amountOut, impactBps: r1.impactBps },
            { pool: pool2.poolAddress, poolType: pool2.type, dir: dir2, in: r1.amountOut, out: r2.amountOut, impactBps: r2.impactBps },
            { pool: pool3.poolAddress, poolType: pool3.type, dir: dir3, in: r2.amountOut, out: r3.amountOut, impactBps: r3.impactBps }
        ]
    };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    quoteCpmmRaw,
    quoteClmmRaw,
    quoteDlmmRaw,
    quotePoolRaw,
    resolveSwapDirection,
    simulateTriangleRaw,
    calculateDynamicImpactBps,
    Q64
};
