function filterPools(pools, config = {}) {

    const DEFAULTS = {
        minLiquidityUsd: 750000
    };

    const cfg = { ...DEFAULTS, ...config };

    const result = {
        allPools: [],
        orcaPools: [],
        raydiumClmmPools: [],
        raydiumCpmmPools: [],
        meteoraPools: [],
        totalCount: pools.length,
        validCount: 0,
        invalidCount: 0,
        highLiquidityCount: 0
    };

    for (const pool of pools) {

        if (!isValidStructure(pool)) {
            result.invalidCount++;
            continue;
        }

        result.validCount++;

        const tvl =
            pool.raw?.tvl ??
            pool.tvl ??
            0;

        if (tvl < cfg.minLiquidityUsd) continue;

        result.highLiquidityCount++;
        result.allPools.push(pool);

        const type = (pool.poolType || '').toLowerCase();

        if (type === 'whirlpool')
            result.orcaPools.push(pool);

        else if (type === 'clmm')
            result.raydiumClmmPools.push(pool);

        else if (type === 'cpmm')
            result.raydiumCpmmPools.push(pool);

        else if (type === 'dlmm')
            result.meteoraPools.push(pool);
    }

    return result;
}

function isValidStructure(pool) {

    if (!pool) return false;
    if (!pool.poolType) return false;
    if (!pool.raw) return false;

    if (!pool.raw.tokenA || !pool.raw.tokenB)
        return false;

    if (pool.raw.tokenA.address === pool.raw.tokenB.address)
        return false;

    return true;
}

module.exports = {
    filterPools
};
