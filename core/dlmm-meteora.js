"use strict";
// dlmm-meteora.js - DLMM (Dynamic Liquidity Market Maker) math for Meteora
// All calculations use BigInt (RAW philosophy)

const Q64 = 1n << 64n;

function divCeil(a, b) {
    return (a + (b - 1n)) / b;
}

/**
 * Quote DLMM exact-in across multiple bins.
 *
 * FIX: Bins MUST be consumed in the correct order relative to direction:
 *   A2B (selling tokenA for tokenB): price decreases → consume bins from
 *       activeBin going DOWNWARD (descending binId / price). Only bins with
 *       reserveB > 0 are relevant.
 *   B2A (selling tokenB for tokenA): price increases → consume bins from
 *       activeBin going UPWARD (ascending binId / price). Only bins with
 *       reserveA > 0 are relevant.
 *
 * The caller (buildDlmmAux / quoteDlmm) must pass bins already annotated with
 * binId. This function sorts them internally for safety.
 */
function quoteDlmmExactInMultiBin(st, dir, amountInRaw) {
    if (amountInRaw <= 0n)
        return { success: false, reason: 'amountInRaw<=0' };
    if (!st.bins || st.bins.length === 0)
        return { success: false, reason: 'missing-bins' };
    if (st.feeBps < 0 || st.feeBps > 10000)
        return { success: false, reason: 'feeBps out of range' };

    // --- Sort bins and filter by direction ---
    let bins;
    if (dir === 'A2B') {
        // Price moves down → active bin first, then lower bins
        // Only bins with reserveB > 0 can provide tokenB output
        bins = st.bins
            .filter(b => b.reserveB > 0n)
            .sort((a, b) => b.binId - a.binId); // descending binId
    } else {
        // Price moves up → active bin first, then higher bins
        // Only bins with reserveA > 0 can provide tokenA output
        bins = st.bins
            .filter(b => b.reserveA > 0n)
            .sort((a, b) => a.binId - b.binId); // ascending binId
    }

    if (bins.length === 0)
        return { success: false, reason: `no bins with liquidity for dir=${dir}` };

    let remain = amountInRaw;
    let outAcc = 0n;

    for (const bin of bins) {
        if (remain <= 0n)
            break;

        // Per-bin fee takes priority over pool-level fee
        const feeBps = bin.feeBps != null ? bin.feeBps : st.feeBps;
        const inAfterFee = (remain * BigInt(10000 - feeBps)) / 10000n;
        if (inAfterFee <= 0n)
            break;

        if (dir === 'A2B') {
            // Selling A → buying B; pxAB_Q64 = price of A in terms of B (B per A)
            if (bin.pxAB_Q64 <= 0n) continue;
            let outPotential = (inAfterFee * bin.pxAB_Q64) >> 64n;
            if (outPotential <= 0n) continue;

            // Cap at available B reserve
            if (outPotential > bin.reserveB)
                outPotential = bin.reserveB;

            // Back-calculate actual A consumed (include fee)
            const inNet = divCeil(outPotential << 64n, bin.pxAB_Q64);
            const inGross = divCeil(inNet * 10000n, BigInt(10000 - feeBps));

            outAcc += outPotential;
            remain -= inGross > remain ? remain : inGross;
        } else {
            // Selling B → buying A; pxBA = 1 / pxAB
            if (bin.pxAB_Q64 <= 0n) continue;
            const pxBA_Q64 = (Q64 * Q64) / bin.pxAB_Q64;
            let outPotential = (inAfterFee * pxBA_Q64) >> 64n;
            if (outPotential <= 0n) continue;

            // Cap at available A reserve
            if (outPotential > bin.reserveA)
                outPotential = bin.reserveA;

            // Back-calculate actual B consumed (include fee)
            const inNet = divCeil(outPotential << 64n, pxBA_Q64);
            const inGross = divCeil(inNet * 10000n, BigInt(10000 - feeBps));

            outAcc += outPotential;
            remain -= inGross > remain ? remain : inGross;
        }
    }

    if (outAcc <= 0n)
        return { success: false, reason: 'out==0' };

    const execQ64 = (outAcc << 64n) / amountInRaw;
    return { success: true, amountOutRaw: outAcc, executionPriceQ64: execQ64 };
}

module.exports = {
    quoteDlmmExactInMultiBin,
    Q64
};
