// utils/productionSafety.js

function applyProductionSafety(routes, config = {}) {

    const DEFAULTS = {
        minProfitBps: 5,        // 0.05%
        maxProfitBps: 300,      // 3% hard cap
        maxSlippageBps: 250,    // per leg
        maxImpactBps: 250,      // per leg
        requireSolAnchor: true
    };

    const cfg = { ...DEFAULTS, ...config };

    const safeRoutes = [];

    for (const route of routes) {

        if (!route || !route.legs || route.legs.length !== 3)
            continue;

        if (!route.success)
            continue;

        const profitBps = route.profitBps ?? route.profit_bps ?? 0;

        // -----------------------------------------
        // 1. Profit envelope
        // -----------------------------------------
        if (profitBps < cfg.minProfitBps)
            continue;

        if (profitBps > cfg.maxProfitBps)
            continue;

        // -----------------------------------------
        // 2. Prevent duplicate pool inside triangle
        // -----------------------------------------
        const poolAddresses = route.legs.map(l => l.poolAddress);
        const uniquePools = new Set(poolAddresses);

        if (uniquePools.size !== 3)
            continue;

        // -----------------------------------------
        // 3. Per-leg sanity checks
        // -----------------------------------------
        let legRejected = false;

        for (const leg of route.legs) {

            const slippage = leg.slippageBps ?? leg.slippage_bps ?? 0;
            const impact = leg.impactBps ?? leg.impact_bps ?? 0;

            if (Math.abs(slippage) > cfg.maxSlippageBps) {
                legRejected = true;
                break;
            }

            if (Math.abs(impact) > cfg.maxImpactBps) {
                legRejected = true;
                break;
            }

            // basic decimal sanity
            const inHuman = leg.amountInHuman ?? leg.amount_in_human ?? 0;
            const outHuman = leg.amountOutHuman ?? leg.amount_out_human ?? 0;

            if (inHuman <= 0 || outHuman <= 0) {
                legRejected = true;
                break;
            }

            const ratio = outHuman / inHuman;

            // kill absurd leg ratios (decimal bug guard)
            if (ratio > 50 || ratio < 0.0001) {
                legRejected = true;
                break;
            }
        }

        if (legRejected)
            continue;

        // -----------------------------------------
        // 4. Optional SOL anchor requirement
        // -----------------------------------------
        if (cfg.requireSolAnchor) {

            const hasSol = route.legs.some(l =>
                l.inputSymbol === 'SOL' ||
                l.outputSymbol === 'SOL'
            );

            if (!hasSol)
                continue;
        }

        safeRoutes.push(route);
    }

    return safeRoutes;
}

module.exports = {
    applyProductionSafety
};