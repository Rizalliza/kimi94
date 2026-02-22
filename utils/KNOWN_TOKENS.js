// KNOWN_TOKENS.js - Common Solana token definitions
// Used for token metadata and decimal lookups

const KNOWN_TOKENS = {
    // SOL
    'So11111111111111111111111111111111111111112': {
        symbol: 'SOL',
        decimals: 9,
        name: 'Wrapped SOL'
    },
    // USDC
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
        symbol: 'USDC',
        decimals: 6,
        name: 'USD Coin'
    },
    // USDT
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
        symbol: 'USDT',
        decimals: 6,
        name: 'Tether USD'
    },
    // BONK
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': {
        symbol: 'BONK',
        decimals: 5,
        name: 'Bonk'
    },
    // RAY
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': {
        symbol: 'RAY',
        decimals: 6,
        name: 'Raydium'
    },
    // ORCA
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': {
        symbol: 'ORCA',
        decimals: 6,
        name: 'Orca'
    },
    // mSOL
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': {
        symbol: 'mSOL',
        decimals: 9,
        name: 'Marinade staked SOL'
    },
    // jitoSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': {
        symbol: 'jitoSOL',
        decimals: 9,
        name: 'Jito Staked SOL'
    },
    // bSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': {
        symbol: 'bSOL',
        decimals: 9,
        name: 'BlazeStake Staked SOL'
    },
    // PYTH
    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKw1Yx79anJpH': {
        symbol: 'PYTH',
        decimals: 6,
        name: 'Pyth Network'
    },
    // JUP
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': {
        symbol: 'JUP',
        decimals: 6,
        name: 'Jupiter'
    },
    // WIF
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': {
        symbol: 'WIF',
        decimals: 6,
        name: 'dogwifhat'
    },
    // POPCAT
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': {
        symbol: 'POPCAT',
        decimals: 9,
        name: 'POPCAT'
    },
    // WETH (Wormhole)
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': {
        symbol: 'WETH',
        decimals: 8,
        name: 'Wrapped Ether (Wormhole)'
    },
    // WBTC (Wormhole)
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': {
        symbol: 'WBTC',
        decimals: 8,
        name: 'Wrapped BTC (Wormhole)'
    },
    // SAMO
    '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': {
        symbol: 'SAMO',
        decimals: 9,
        name: 'Samoyedcoin'
    },
    // DUST
    'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ': {
        symbol: 'DUST',
        decimals: 9,
        name: 'DUST Protocol'
    },
    // SRM
    'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt': {
        symbol: 'SRM',
        decimals: 6,
        name: 'Serum'
    },
    // FTT (Wrapped)
    'AGFEad2et2ZJif9jaGpdMixQqvW5i81aBdvKe7PHNfz3': {
        symbol: 'FTT',
        decimals: 6,
        name: 'FTT (Wormhole)'
    },
    // JLP
    '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4': {
        symbol: 'JLP',
        decimals: 6,
        name: 'JLP'
    },
    // WBTC
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': {
        symbol: 'WBTC',
        decimals: 8,
        name: 'WBTC'
    },
    // cBTC
    'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij': {
        symbol: 'cBTC',
        decimals: 8,
        name: 'WBTC'
    },
    // META
    'METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m': {
        symbol: 'META',
        decimals: 6,
        name: 'META'
    }
};

// Token list for quick lookups
const TOKEN_LIST = Object.entries(KNOWN_TOKENS).map(([mint, info]) => ({
    mint,
    ...info
}));

// Helper functions
function getTokenInfo(mint) {
    return KNOWN_TOKENS[mint] || null;
}

function getTokenSymbol(mint) {
    return KNOWN_TOKENS[mint]?.symbol || mint.slice(0, 6);
}

function getTokenDecimals(mint) {
    return KNOWN_TOKENS[mint]?.decimals ?? 6;
}

module.exports = {
    KNOWN_TOKENS,
    TOKEN_LIST,
    getTokenInfo,
    getTokenSymbol,
    getTokenDecimals
};
