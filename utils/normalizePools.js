// normalizePools.js - Pool normalization utilities

const Decimal = require('decimal.js');

function normalizePool(pool) {
    if (!pool || typeof pool !== 'object') {
        return null;
    }

    // Normalize to standard structure that PoolFilter expects
    const normalized = {
        ...pool,

        // Identifiers
        poolAddress: pool.poolAddress || pool.id || pool.address || '',
        dex: pool.dex || 'unknown',
        type: (pool.type || 'unknown').toLowerCase(),
        poolType: (pool.type || 'unknown').toLowerCase(), // For PoolFilter compatibility

        // Token info
        baseMint: pool.baseMint || pool.mintA || pool.mint_x || '',
        quoteMint: pool.quoteMint || pool.mintB || pool.mint_y || '',
        baseDecimals: pool.baseDecimals ?? 6,
        quoteDecimals: pool.quoteDecimals ?? 6,
        baseSymbol: pool.baseSymbol || 'UNK',
        quoteSymbol: pool.quoteSymbol || 'UNK',
        pairSymbol: pool.pairSymbol || `${pool.baseSymbol || 'UNK'}/${pool.quoteSymbol || 'UNK'}`,

        // Liquidity as object for PoolFilter
        liquidity: {
            liquidityUsd: parseFloat(pool.liquidity || pool.tvl || 0)
        },
        tvl: pool.tvl || pool.liquidity || 0,

        // Fee info
        feeRate: pool.feeRate || pool.fee || 0,
        feeBps: pool.feeBps || 0,

        // Reserves
        xReserve: pool.xReserve || '0',
        yReserve: pool.yReserve || '0',
        baseReserve: pool.baseReserve || pool.xReserve || '0',
        quoteReserve: pool.quoteReserve || pool.yReserve || '0',

        // Token structure for PoolFilter
        tokenA: {
            mint: pool.baseMint || pool.mintA || '',
            decimals: pool.baseDecimals ?? 6,
            symbol: pool.baseSymbol || 'UNK',
            priceUsd: pool.tokenA?.priceUsd || 0
        },
        tokenB: {
            mint: pool.quoteMint || pool.mintB || '',
            decimals: pool.quoteDecimals ?? 6,
            symbol: pool.quoteSymbol || 'UNK',
            priceUsd: pool.tokenB?.priceUsd || 0
        },

        // Reserves for PoolFilter
        reserves: {
            amountA: new Decimal(pool.xReserve || 0),
            amountB: new Decimal(pool.yReserve || 0)
        },

        // Vaults
        vaults: pool.vaults || {},

        // Flags
        reserveSource: pool.reserveSource || 'api',
        isMathReady: pool.isMathReady ?? false,

        // Raw data
        raw: pool._raw || pool.raw || {},
        _raw: pool._raw || pool.raw || {}
    };

    return normalized;
}

module.exports = {
    normalizePool,
    normalizePools: (pools) => (pools || []).map(normalizePool).filter(Boolean)
};
