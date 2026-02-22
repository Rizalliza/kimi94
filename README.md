# Flashloan Arbitrage — Execution Layer

Complete execution stack for the Solana triangular arbitrage system.  
Reads profitable routes from the pipeline (`bot-routes.json`), executes them on-chain via a **Kamino flashloan** + **Orca Whirlpool swaps** + **Jito bundle** in a single atomic transaction.

---

## Architecture

```
master-pipeline.js          ← (existing) simulation + route selection
      │
      └──▶ results/bot-routes.json
                │
                ▼
      execute-route.js (CLI)
                │
         executor.js (orchestration)
        ┌───────┴────────┐
   kamino.js        orca-swap-builder.js
   (flashloan)      (swap ixs)
        └───────┬────────┘
           jito.js (bundle → on-chain)
```

---

## File Map

| File | Purpose |
|---|---|
| `config.js` | Env vars, program IDs, Kamino/Jito addresses |
| `kamino.js` | Flash borrow + repay instruction builders |
| `orca-swap-builder.js` | Orca Whirlpool swap instruction builder, ATA/tick helpers |
| `jito.js` | Bundle construction, simulation, submission, status polling |
| `executor.js` | Full execution orchestration |
| `execute-route.js` | CLI entry point |

---

## Setup

### 1. Install dependencies

```bash
npm install @solana/web3.js @solana/spl-token bs58 dotenv
```

### 2. Create `.env`

```env
# Required
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
WALLET_KEYPAIR=[1,2,3,...]          # JSON array of secret key bytes
                                    # OR path: WALLET_KEYPAIR=./keys/payer.json

JITO_BLOCK_ENGINE_URL=https://ny.mainnet.block-engine.jito.wtf
JITO_TIP_LAMPORTS=10000

# Optional
DRY_RUN=true                        # never submits, only simulates
MIN_PROFIT_LAMPORTS=50000           # skip routes below this net profit
```

### 3. Ensure your wallet has ATAs

Your wallet must have associated token accounts for every mint in the route:

- **wSOL** (`So111...112`) — receives the flashloan
- **USDC** (`EPjF...`) — intermediate
- **jitoSOL** (`J1to...`) — intermediate for the SOL→USDC→jitoSOL→SOL route

Create missing ATAs:
```bash
spl-token create-account <MINT_ADDRESS>
```

### 4. Verify enriched pools

The executor reads vault addresses (`tokenVaultA`, `tokenVaultB`) from `pools_enriched.json`.  
These must be present — re-run `enriched-fixed.js` if they're missing.

---

## Usage

```bash
# Dry run (simulate only, never submit)
DRY_RUN=true node execute-route.js \
  --routes ./results/bot-routes.json \
  --pools  ./results/pools_enriched.json

# Live execution
node execute-route.js \
  --routes ./results/bot-routes.json \
  --pools  ./results/pools_enriched.json

# With custom slippage (75 bps = 0.75%) and tip (25000 lamports)
node execute-route.js \
  --routes   ./results/bot-routes.json \
  --pools    ./results/pools_enriched.json \
  --slippage 75 \
  --tip      25000

# Run a specific route by index
node execute-route.js \
  --routes      ./results/bot-routes.json \
  --pools       ./results/pools_enriched.json \
  --route-index 0
```

---

## Data Flow for the Profitable Route (SOL → USDC → jitoSOL → SOL)

```
Kamino flash borrows 1 SOL (wSOL) → your wSOL ATA

  Leg 1: wSOL → USDC  (pool: Czfq3xZZ...)  direction: A2B
  Leg 2: USDC → jitoSOL (pool: 5hWJUNTt...) direction: A2B
  Leg 3: jitoSOL → wSOL (pool: Hp53XEtt...) direction: A2B

Kamino flash repay: 1,000,090,000 lamports (0.09% fee on 1 SOL)
                                            ≈ 90,000 lamports fee

From simulation: 1,000,422,773 out − 1,000,000,000 in = 422,773 gross profit
After fee:       422,773 − 90,000 = 332,773 lamports remaining
After tip:       332,773 − 10,000 = 322,773 net profit
                                    ≈ 0.000323 SOL ≈ $0.048 @ $150/SOL
```

> **Note**: At 4 bps gross, this route only clears after fees/tip by a small margin.
> Look for routes with ≥ 20 bps gross to have a healthy buffer.

---

## Production Checklist

- [ ] Verify Kamino reserve supply vault address via `fetchReserveSupplyVault()` before first run
- [ ] Confirm discriminators still match Kamino IDL (check `@kamino-finance/klend-sdk` releases)
- [ ] Run with `DRY_RUN=true` first — confirm simulation passes and CU count is reasonable
- [ ] Set `MIN_PROFIT_LAMPORTS` ≥ flashloan fee + tip + priority fee + buffer
- [ ] Use Helius / QuickNode with `staked connections` for lower latency
- [ ] Monitor Jito tip percentiles at market open and adjust accordingly
- [ ] Keep `enriched-fixed.js` re-running every N minutes; stale pool state = wrong tick arrays

---

## Known Constraints

**Tick arrays** — the swap instruction needs 3 tick array accounts. These are derived from `tickCurrentIndex` in the enriched pool state. If the current tick has moved significantly since enrichment, the derived arrays may be wrong and the sim will fail with `TicArrayNotInitialized`. Fix: re-enrich before executing.

**wSOL vs native SOL** — Kamino flashloans work with SPL token accounts, not native SOL. All amounts are wSOL (atomic: 1 SOL = 1,000,000,000 lamports). The wallet needs a wSOL ATA.

**Kamino reserve addresses** — `KAMINO.RESERVES.SOL` is hardcoded from the public Kamino market. Verify it matches the current deployment at `https://app.kamino.finance/lending`.
