class ProfitSelector {
    constructor(config = {}) {
        this.config = {
            MIN_PROFIT_BPS: 2,
            MAX_IMPACT_BPS: 200,
            SANITY_MULTIPLIER: 2,
            ...config
        };
    }

    selectBestRoutes(routes, amountInRaw, simulateFunc) {
        const validRoutes = [];

        for (const route of routes) {
            const sim = simulateFunc(route, amountInRaw);

            if (!sim?.success) continue;
            if (sim.profitRaw <= 0n) continue;

            // Sanity guard
            if (
                sim.amountOutRaw > amountInRaw * BigInt(this.config.SANITY_MULTIPLIER) ||
                sim.amountOutRaw < amountInRaw / BigInt(this.config.SANITY_MULTIPLIER)
            ) {
                continue;
            }

            const totalImpact = sim.legs.reduce(
                (sum, l) => sum + (l.impactBps || 0),
                0
            );

            if (totalImpact > this.config.MAX_IMPACT_BPS) continue;

            const profitBps =
                Number(sim.profitRaw) * 10000 /
                Number(amountInRaw);

            if (profitBps < this.config.MIN_PROFIT_BPS) continue;

            validRoutes.push({
                route,
                profitRaw: sim.profitRaw,
                profitBps,
                totalImpact
            });
        }

        validRoutes.sort((a, b) => b.profitRaw - a.profitRaw);

        return validRoutes.slice(0, 5);
    }
}

module.exports = ProfitSelector;
