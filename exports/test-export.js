/**
 * Test script for export utilities
 */

const {
  toHuman,
  toDecimal,
  getTokenDecimals,
  generateTimestamp,
  formatResultsForExport,
  flattenObject,
  escapeCSVField,
  exportToCSV,
  exportToJSON,
  exportToXLSX,
  exportResults
} = require('./export-utils');

// ============================================================================
// TEST DATA
// ============================================================================

const mockSimulationResults = {
  triangles: [
    {
      path: ['SOL', 'USDC', 'USDT', 'SOL'],
      tokens: [
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        'So11111111111111111111111111111111111111112'
      ],
      inputAmount: 1000000000n, // 1 SOL
      totalOutput: 1005000000n,
      profit: 5000000n,
      profitBps: 50,
      swaps: [
        {
          pool: 'pool_SOL_USDC_123',
          amountIn: 1000000000n,
          amountOut: 95000000n,
          feeBps: 30,
          price: '0.095'
        },
        {
          pool: 'pool_USDC_USDT_456',
          amountIn: 95000000n,
          amountOut: 94850000n,
          feeBps: 5,
          price: '0.9984'
        },
        {
          pool: 'pool_USDT_SOL_789',
          amountIn: 94850000n,
          amountOut: 1005000000n,
          feeBps: 30,
          price: '10.595'
        }
      ]
    },
    {
      path: ['SOL', 'BONK', 'USDC', 'SOL'],
      tokens: [
        'So11111111111111111111111111111111111111112',
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'So11111111111111111111111111111111111111112'
      ],
      inputAmount: 500000000n, // 0.5 SOL
      totalOutput: 495000000n,
      profit: -5000000n,
      profitBps: -100,
      swaps: [
        {
          pool: 'pool_SOL_BONK_abc',
          amountIn: 500000000n,
          amountOut: 50000000000000n,
          feeBps: 100,
          price: '100000'
        },
        {
          pool: 'pool_BONK_USDC_def',
          amountIn: 50000000000000n,
          amountOut: 45000000n,
          feeBps: 100,
          price: '0.0000009'
        },
        {
          pool: 'pool_USDC_SOL_ghi',
          amountIn: 45000000n,
          amountOut: 495000000n,
          feeBps: 30,
          price: '11.0'
        }
      ]
    }
  ]
};

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

function testToHuman() {
  console.log('\n=== Testing toHuman() ===');
  
  // Test with BigInt
  const result1 = toHuman(1234567890n, 9);
  console.log(`toHuman(1234567890n, 9) = "${result1}"`);
  console.assert(result1 === '1.234567890', 'BigInt test failed');
  
  // Test with string
  const result2 = toHuman('1234567890', 6);
  console.log(`toHuman('1234567890', 6) = "${result2}"`);
  console.assert(result2 === '1234.567890', 'String test failed');
  
  // Test with number
  const result3 = toHuman(1000000, 6);
  console.log(`toHuman(1000000, 6) = "${result3}"`);
  console.assert(result3 === '1.000000', 'Number test failed');
  
  // Test with default decimals
  const result4 = toHuman(1000000000n);
  console.log(`toHuman(1000000000n) [default 9] = "${result4}"`);
  console.assert(result4 === '1.000000000', 'Default decimals test failed');
  
  // Test with zero
  const result5 = toHuman(0n, 9);
  console.log(`toHuman(0n, 9) = "${result5}"`);
  console.assert(result5 === '0.000000000', 'Zero test failed');
  
  // Test with null
  const result6 = toHuman(null, 9);
  console.log(`toHuman(null, 9) = "${result6}"`);
  console.assert(result6 === '0.000000000', 'Null test failed');
  
  console.log('✓ toHuman() tests passed');
}

function testToDecimal() {
  console.log('\n=== Testing toDecimal() ===');
  
  const d1 = toDecimal(1000000000n);
  console.log(`toDecimal(1000000000n) = ${d1.toString()}`);
  console.assert(d1.toString() === '1000000000', 'BigInt decimal test failed');
  
  const d2 = toDecimal('500000000');
  console.log(`toDecimal('500000000') = ${d2.toString()}`);
  console.assert(d2.toString() === '500000000', 'String decimal test failed');
  
  console.log('✓ toDecimal() tests passed');
}

function testGetTokenDecimals() {
  console.log('\n=== Testing getTokenDecimals() ===');
  
  const solDecimals = getTokenDecimals('So11111111111111111111111111111111111111112');
  console.log(`SOL decimals: ${solDecimals}`);
  console.assert(solDecimals === 9, 'SOL decimals test failed');
  
  const usdcDecimals = getTokenDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  console.log(`USDC decimals: ${usdcDecimals}`);
  console.assert(usdcDecimals === 6, 'USDC decimals test failed');
  
  const unknownDecimals = getTokenDecimals('unknown_mint');
  console.log(`Unknown mint decimals: ${unknownDecimals}`);
  console.assert(unknownDecimals === 9, 'Unknown mint decimals test failed');
  
  console.log('✓ getTokenDecimals() tests passed');
}

function testGenerateTimestamp() {
  console.log('\n=== Testing generateTimestamp() ===');
  
  const timestamp = generateTimestamp();
  console.log(`Generated timestamp: ${timestamp}`);
  console.assert(/\d{8}_\d{6}/.test(timestamp), 'Timestamp format test failed');
  
  console.log('✓ generateTimestamp() tests passed');
}

function testFlattenObject() {
  console.log('\n=== Testing flattenObject() ===');
  
  const nested = {
    a: 1,
    b: {
      c: 2,
      d: {
        e: 3
      }
    },
    f: [1, 2, 3]
  };
  
  const flattened = flattenObject(nested);
  console.log('Flattened object:', flattened);
  console.assert(flattened['a'] === '1', 'Flatten a failed');
  console.assert(flattened['b.c'] === '2', 'Flatten b.c failed');
  console.assert(flattened['b.d.e'] === '3', 'Flatten b.d.e failed');
  console.assert(flattened['f'] === '1; 2; 3', 'Flatten array failed');
  
  console.log('✓ flattenObject() tests passed');
}

function testEscapeCSVField() {
  console.log('\n=== Testing escapeCSVField() ===');
  
  const simple = escapeCSVField('hello');
  console.log(`escapeCSVField('hello') = "${simple}"`);
  console.assert(simple === 'hello', 'Simple field test failed');
  
  const withComma = escapeCSVField('hello, world');
  console.log(`escapeCSVField('hello, world') = "${withComma}"`);
  console.assert(withComma === '"hello, world"', 'Comma escape test failed');
  
  const withQuote = escapeCSVField('say "hello"');
  console.log(`escapeCSVField('say "hello"') = "${withQuote}"`);
  console.assert(withQuote === '"say ""hello"""', 'Quote escape test failed');
  
  const withNewline = escapeCSVField('line1\nline2');
  console.log(`escapeCSVField('line1\\nline2') = "${withNewline}"`);
  console.assert(withNewline === '"line1\nline2"', 'Newline escape test failed');
  
  console.log('✓ escapeCSVField() tests passed');
}

function testFormatResultsForExport() {
  console.log('\n=== Testing formatResultsForExport() ===');
  
  const formatted = formatResultsForExport(mockSimulationResults);
  
  console.log('Formatted results structure:');
  console.log(`  timestamp: ${formatted.timestamp}`);
  console.log(`  totalSimulated: ${formatted.totalSimulated}`);
  console.log(`  profitable: ${formatted.profitable}`);
  console.log(`  profitablePercent: ${formatted.profitablePercent}`);
  console.log(`  triangles count: ${formatted.triangles.length}`);
  
  console.assert(formatted.totalSimulated === 2, 'Total simulated test failed');
  console.assert(formatted.profitable === 1, 'Profitable count test failed');
  console.assert(formatted.triangles.length === 2, 'Triangles array test failed');
  
  // Check first triangle
  const firstTriangle = formatted.triangles[0];
  console.log('\nFirst triangle:');
  console.log(`  path: ${firstTriangle.pathString}`);
  console.log(`  inputAmountHuman: ${firstTriangle.inputAmountHuman}`);
  console.log(`  profitHuman: ${firstTriangle.profitHuman}`);
  console.log(`  isProfitable: ${firstTriangle.isProfitable}`);
  console.log(`  swaps count: ${firstTriangle.swaps.length}`);
  
  console.assert(firstTriangle.inputAmountHuman === '1.000000000', 'Input amount human test failed');
  console.assert(firstTriangle.profitHuman === '0.005000000', 'Profit human test failed');
  console.assert(firstTriangle.isProfitable === true, 'Is profitable test failed');
  console.assert(firstTriangle.swaps.length === 3, 'Swaps count test failed');
  
  // Check swap details
  const firstSwap = firstTriangle.swaps[0];
  console.log('\nFirst swap:');
  console.log(`  leg: ${firstSwap.leg}`);
  console.log(`  pool: ${firstSwap.pool}`);
  console.log(`  amountInHuman: ${firstSwap.amountInHuman}`);
  console.log(`  amountOutHuman: ${firstSwap.amountOutHuman}`);
  
  console.assert(firstSwap.leg === 1, 'Swap leg test failed');
  console.assert(firstSwap.amountInHuman === '1.000000000', 'Swap amount in human test failed');
  
  console.log('✓ formatResultsForExport() tests passed');
}

function testExportToCSV() {
  console.log('\n=== Testing exportToCSV() ===');
  
  const formatted = formatResultsForExport(mockSimulationResults);
  const outputPath = exportToCSV(formatted, './test-output/test_results.csv');
  
  console.log(`CSV exported to: ${outputPath}`);
  
  // Verify file exists
  const fs = require('fs');
  console.assert(fs.existsSync(outputPath), 'CSV file not created');
  
  // Read and verify content
  const content = fs.readFileSync(outputPath, 'utf8');
  console.assert(content.includes('Arbitrage Results Export'), 'CSV header missing');
  console.assert(content.includes('Triangle Summary'), 'CSV summary section missing');
  console.assert(content.includes('SOL → USDC → USDT → SOL'), 'CSV path data missing');
  
  console.log('✓ exportToCSV() tests passed');
}

function testExportToJSON() {
  console.log('\n=== Testing exportToJSON() ===');
  
  const formatted = formatResultsForExport(mockSimulationResults);
  const outputPath = exportToJSON(formatted, './test-output/test_results.json');
  
  console.log(`JSON exported to: ${outputPath}`);
  
  // Verify file exists
  const fs = require('fs');
  console.assert(fs.existsSync(outputPath), 'JSON file not created');
  
  // Read and verify content
  const content = fs.readFileSync(outputPath, 'utf8');
  const parsed = JSON.parse(content);
  
  console.assert(parsed.metadata, 'JSON metadata missing');
  console.assert(parsed.metadata.exportVersion === '1.0.0', 'JSON version test failed');
  console.assert(parsed.summary.totalSimulated === 2, 'JSON summary test failed');
  console.assert(parsed.triangles.length === 2, 'JSON triangles test failed');
  
  console.log('✓ exportToJSON() tests passed');
}

function testExportToXLSX() {
  console.log('\n=== Testing exportToXLSX() ===');
  
  const formatted = formatResultsForExport(mockSimulationResults);
  const outputPath = exportToXLSX(formatted, './test-output/test_results.xlsx');
  
  console.log(`XLSX exported to: ${outputPath}`);
  
  // Verify file exists
  const fs = require('fs');
  console.assert(fs.existsSync(outputPath), 'XLSX file not created');
  console.assert(fs.statSync(outputPath).size > 0, 'XLSX file is empty');
  
  console.log('✓ exportToXLSX() tests passed');
}

function testExportResults() {
  console.log('\n=== Testing exportResults() (master function) ===');
  
  const result = exportResults(mockSimulationResults, {
    outputDir: './test-output/master',
    csv: true,
    json: true,
    xlsx: true,
    filenamePrefix: 'test_master'
  });
  
  console.log('\nExport result:');
  console.log(`  Total simulated: ${result.summary.totalSimulated}`);
  console.log(`  Profitable: ${result.summary.profitable}`);
  console.log(`  Profitable %: ${result.summary.profitablePercent}`);
  console.log('  Exported files:');
  Object.entries(result.exportedFiles).forEach(([format, path]) => {
    console.log(`    ${format}: ${path}`);
  });
  
  // Verify all files were created
  const fs = require('fs');
  Object.values(result.exportedFiles).forEach(filePath => {
    console.assert(fs.existsSync(filePath), `${filePath} not created`);
  });
  
  console.log('✓ exportResults() tests passed');
}

function testEmptyResults() {
  console.log('\n=== Testing empty results handling ===');
  
  const emptyResults = { triangles: [] };
  const formatted = formatResultsForExport(emptyResults);
  
  console.assert(formatted.totalSimulated === 0, 'Empty total simulated test failed');
  console.assert(formatted.profitable === 0, 'Empty profitable test failed');
  console.assert(formatted.triangles.length === 0, 'Empty triangles test failed');
  
  const nullResults = null;
  const formattedNull = formatResultsForExport(nullResults);
  console.assert(formattedNull.totalSimulated === 0, 'Null results test failed');
  
  console.log('✓ Empty results tests passed');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Export Utilities Test Suite                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  try {
    testToHuman();
    testToDecimal();
    testGetTokenDecimals();
    testGenerateTimestamp();
    testFlattenObject();
    testEscapeCSVField();
    testFormatResultsForExport();
    testExportToCSV();
    testExportToJSON();
    testExportToXLSX();
    testExportResults();
    testEmptyResults();
    
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║         All tests passed!                                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    return false;
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  runAllTests,
  mockSimulationResults
};
