"use strict";
// clmm-raydium.js - CLMM (Concentrated Liquidity Market Maker) math
// All calculations use BigInt (RAW philosophy)

const Q64 = 1n << 64n;

function mulDivFloor(a, b, d) {
    return (a * b) / d;
}

function mulDivCeil(a, b, d) {
    return (a * b + (d - 1n)) / d;
}

/**
 * Derive sqrtPriceX64 from a tick index.
 * sqrtPrice = sqrt(1.0001^tick), stored as Q64 fixed-point.
 * Sufficient precision for boundary estimation; real-time data preferred when available.
 */
function tickToSqrtPriceX64(tick) {
    const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
    if (!isFinite(sqrtPrice) || sqrtPrice <= 0) return 0n;
    // 2^64 = 18446744073709551616; float approximation then cast to BigInt
    const raw = Math.floor(sqrtPrice * 18446744073709551616.0);
    if (!isFinite(raw) || raw <= 0) return 0n;
    return BigInt(raw);
}

function nextSqrtPriceFromAmount0InSingleTick(sqrt, L, amount0In) {
    const LQ = L * Q64;
    const numerator = LQ * sqrt;
    const denom = LQ + amount0In * sqrt;
    if (denom === 0n)
        return 0n;
    return numerator / denom;
}

function nextSqrtPriceFromAmount1InSingleTick(sqrt, L, amount1In) {
    const delta = mulDivFloor(amount1In, Q64, L);
    return sqrt + delta;
}

/**
 * Quote CLMM single-tick exact-in.
 * FIX: Derives the next tick boundary from tickCurrentIndex + tickSpacing
 * when nextTickSqrtPriceX64 is not explicitly provided (avoids hard failure on
 * unenriched pools). Also clamps instead of rejecting when boundary is crossed.
 */
function quoteClmmExactInSingleTick(st, dir, amountInRaw) {
    if (amountInRaw <= 0n)
        return { success: false, reason: 'amountInRaw<=0' };
    if (st.liquidity <= 0n)
        return { success: false, reason: 'empty liquidity' };
    if (st.feeBps < 0 || st.feeBps > 10000)
        return { success: false, reason: 'feeBps out of range' };

    // FIX: Resolve next-tick boundary — use explicit value or derive from tick spacing
    let nextTickSqrtPriceX64 = st.nextTickSqrtPriceX64 ?? 0n;
    if (!nextTickSqrtPriceX64 || nextTickSqrtPriceX64 <= 0n) {
        const tickSpacing = st.tickSpacing != null ? Number(st.tickSpacing) : 64;
        const tickCurrent = st.tickCurrentIndex != null ? Number(st.tickCurrentIndex) : 0;
        if (dir === 'A2B') {
            // Price moves down → boundary is floor of current tick aligned to spacing
            const lowerTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
            nextTickSqrtPriceX64 = tickToSqrtPriceX64(lowerTick);
        } else {
            // Price moves up → boundary is next tick above current
            const upperTick = (Math.floor(tickCurrent / tickSpacing) + 1) * tickSpacing;
            nextTickSqrtPriceX64 = tickToSqrtPriceX64(upperTick);
        }
    }
    if (!nextTickSqrtPriceX64 || nextTickSqrtPriceX64 <= 0n)
        return { success: false, reason: 'cannot derive nextTickSqrtPriceX64' };

    const inAfterFee = (amountInRaw * BigInt(10000 - st.feeBps)) / 10000n;
    if (inAfterFee <= 0n)
        return { success: false, reason: 'inAfterFee==0' };

    const sqrt0 = st.sqrtPriceX64;
    let sqrt1;
    let amountOutRaw;

    if (dir === 'A2B') {
        sqrt1 = nextSqrtPriceFromAmount0InSingleTick(sqrt0, st.liquidity, inAfterFee);
        // FIX: Clamp to boundary instead of rejecting — swap is valid up to boundary
        if (sqrt1 < nextTickSqrtPriceX64)
            sqrt1 = nextTickSqrtPriceX64;
        const delta = sqrt0 - sqrt1;
        if (delta <= 0n)
            return { success: false, reason: 'no price movement (A2B)' };
        amountOutRaw = mulDivFloor(st.liquidity, delta, Q64);
    } else {
        sqrt1 = nextSqrtPriceFromAmount1InSingleTick(sqrt0, st.liquidity, inAfterFee);
        // FIX: Clamp to boundary instead of rejecting
        if (sqrt1 > nextTickSqrtPriceX64)
            sqrt1 = nextTickSqrtPriceX64;
        const delta = sqrt1 - sqrt0;
        if (delta <= 0n)
            return { success: false, reason: 'no price movement (B2A)' };
        const num = st.liquidity * Q64 * delta;
        const den = sqrt1 * sqrt0;
        amountOutRaw = num / den;
    }

    if (amountOutRaw <= 0n)
        return { success: false, reason: 'out==0' };

    const execQ64 = (amountOutRaw << 64n) / amountInRaw;
    return { success: true, amountOutRaw, executionPriceQ64: execQ64 };
}

function quoteClmmExactInMultiTick(st, dir, amountInRaw) {
    if (amountInRaw <= 0n)
        return { success: false, reason: 'amountInRaw<=0' };
    if (st.liquidity <= 0n)
        return { success: false, reason: 'empty liquidity' };
    if (!st.ticks || st.ticks.length === 0)
        return { success: false, reason: 'missing-ticks' };
    if (st.feeBps < 0 || st.feeBps > 10000)
        return { success: false, reason: 'feeBps out of range' };

    let remain = (amountInRaw * BigInt(10000 - st.feeBps)) / 10000n;
    if (remain <= 0n)
        return { success: false, reason: 'inAfterFee==0' };

    let sqrt = st.sqrtPriceX64;
    let L = st.liquidity;
    let outAcc = 0n;

    const ticks = st.ticks.slice().sort((a, b) => a.tickIndex - b.tickIndex);
    let idx = ticks.findIndex(t => t.tickIndex > st.tickCurrentIndex);
    if (idx === -1)
        idx = ticks.length;

    if (dir === 'A2B') {
        // Selling token0 → price decreases, traverse ticks downward
        let i = idx - 1;
        while (remain > 0n) {
            if (i < 0)
                break;
            const boundary = ticks[i];
            // FIX: fall back to tick derivation if sqrtPriceX64 not stored on tick
            const sqrtB = (boundary.sqrtPriceX64 && boundary.sqrtPriceX64 > 0n)
                ? boundary.sqrtPriceX64
                : tickToSqrtPriceX64(boundary.tickIndex);
            if (sqrtB <= 0n || sqrtB >= sqrt)
                break; // degenerate tick

            const num = L * (sqrt - sqrtB) * Q64;
            const den = sqrt * sqrtB;
            if (den === 0n) break;
            const amtToBoundary = mulDivCeil(num, 1n, den);

            if (remain < amtToBoundary) {
                const sqrt1 = nextSqrtPriceFromAmount0InSingleTick(sqrt, L, remain);
                const delta = sqrt - sqrt1;
                outAcc += mulDivFloor(L, delta, Q64);
                remain = 0n;
                break;
            } else {
                outAcc += mulDivFloor(L, sqrt - sqrtB, Q64);
                remain -= amtToBoundary;
                sqrt = sqrtB;
                L = L - boundary.liquidityNet; // liquidityNet subtracted when moving left
                i -= 1;
            }
        }
    } else {
        // Selling token1 → price increases, traverse ticks upward
        let i = idx;
        while (remain > 0n) {
            if (i >= ticks.length)
                break;
            const boundary = ticks[i];
            const sqrtB = (boundary.sqrtPriceX64 && boundary.sqrtPriceX64 > 0n)
                ? boundary.sqrtPriceX64
                : tickToSqrtPriceX64(boundary.tickIndex);
            if (sqrtB <= 0n || sqrtB <= sqrt)
                break; // degenerate tick

            const amtToBoundary = mulDivCeil(L * (sqrtB - sqrt), 1n, Q64);

            if (remain < amtToBoundary) {
                const sqrt1 = nextSqrtPriceFromAmount1InSingleTick(sqrt, L, remain);
                const delta = sqrt1 - sqrt;
                const num = L * Q64 * delta;
                const den = sqrt1 * sqrt;
                if (den === 0n) break;
                outAcc += num / den;
                remain = 0n;
                break;
            } else {
                const num = L * Q64 * (sqrtB - sqrt);
                const den = sqrtB * sqrt;
                if (den === 0n) break;
                outAcc += num / den;
                remain -= amtToBoundary;
                sqrt = sqrtB;
                L = L + boundary.liquidityNet; // liquidityNet added when moving right
                i += 1;
            }
        }
    }

    if (outAcc <= 0n)
        return { success: false, reason: 'out==0' };

    const execQ64 = (outAcc << 64n) / amountInRaw;
    return { success: true, amountOutRaw: outAcc, executionPriceQ64: execQ64 };
}

module.exports = {
    quoteClmmExactInSingleTick,
    quoteClmmExactInMultiTick,
    tickToSqrtPriceX64,
    Q64
};
