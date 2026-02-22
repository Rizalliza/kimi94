#!/bin/bash

# Ensure we stop on error
set -e

echo "================================================================"
echo "🚀 1. Testing Helius Connection"
echo "================================================================"
node flash/heliusTestTransaction.mjs

echo ""
echo "================================================================"
echo "🚀 2. Running Master Pipeline"
echo "================================================================"
# Run pipeline and export results
# Allow loss (-1000 bps = -10%) and skip guard to ensure we get routes for testing
node master-pipeline.js --min-profit=-1000 --skip-guard

# Check if output files exist
echo ""
echo "Checking output files:"
ls -l results/

echo ""
echo "================================================================"
echo "🚀 3. Testing Top 3 Profitable Routes (Dry Run)"
echo "================================================================"

# Get top 3 routes from bot-routes.json
# We use node to read the json and get the count
ROUTE_COUNT=$(node -e "try { const d = require('./results/bot-routes.json'); console.log(Math.min(3, d.routes.length)); } catch { console.log(0); }")

if [ "$ROUTE_COUNT" -eq "0" ]; then
    echo "⚠️  No routes found in bot-routes.json"
else
    echo "Found $ROUTE_COUNT routes to test."
    
    for ((i=0; i<ROUTE_COUNT; i++)); do
        echo ""
        echo "----------------------------------------------------------------"
        echo "🧪 Testing Route #$((i+1)) (Index $i)"
        echo "----------------------------------------------------------------"
        # Using --dry-run to simulate without executing
        # We need to run it as module since we added package.json type=module in flash/
        node flash/execute-route.js --route-index $i --dry-run || echo "❌ Route $i failed simulation"
    done
fi

echo ""
echo "================================================================"
echo "✅ Pipeline Test Complete"
echo "================================================================"
