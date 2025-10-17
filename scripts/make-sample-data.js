#!/usr/bin/env node
/**
 * make-sample-data.js
 *
 * Creates a downsampled copy (default 5%) of each monthly CSV in ./data/
 * and writes it into ./sample-data/ with the same filenames.
 *
 * Usage:
 *   node scripts/make-sample-data.js --rate 0.05
 *   node scripts/make-sample-data.js --rate 0.02 --seed 123 (seed is optional)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  return def;
}
let rate = parseFloat(getArg('rate', '0.05'));
if (!isFinite(rate) || rate <= 0 || rate >= 1) {
  console.error(`Invalid --rate value: ${rate}. Use a decimal between 0 and 1 (e.g., 0.05).`);
  process.exit(1);
}

// Optional seed (simple LCG for reproducibility if desired)
const seedArg = getArg('seed', null);
let rngState = seedArg ? (parseInt(seedArg, 10) || 123456789) : null;
function rand() {
  if (rngState == null) return Math.random();
  // LCG constants (Numerical Recipes)
  rngState = (1664525 * rngState + 1013904223) % 4294967296;
  return rngState / 4294967296;
}

const inputDir = path.join(__dirname, '..', 'data');
const outputDir = path.join(__dirname, '..', 'sample-data');

const files = [
  'Bike share ridership 2023-01.csv',
  'Bike share ridership 2023-02.csv',
  'Bike share ridership 2023-03.csv',
  'Bike share ridership 2023-04.csv',
  'Bike share ridership 2023-05.csv',
  'Bike share ridership 2023-06.csv',
  'Bike share ridership 2023-07.csv',
  'Bike share ridership 2023-08.csv',
  'Bike share ridership 2023-09.csv',
  'Bike share ridership 2023-10.csv',
  'Bike share ridership 2023-11.csv',
  'Bike share ridership 2023-12.csv'
];

fs.mkdirSync(outputDir, { recursive: true });

async function sampleFile(inPath, outPath) {
  if (!fs.existsSync(inPath)) {
    console.warn(`[skip] Source file not found: ${inPath}`);
    return { total: 0, kept: 0 };
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(inPath),
    crlfDelay: Infinity
  });
  const out = fs.createWriteStream(outPath);

  let isFirst = true;
  let total = 0, kept = 0;

  for await (const line of rl) {
    total++;
    if (isFirst) {
      // Always write header
      out.write(line + '\n');
      isFirst = false;
      kept++;
      continue;
    }
    if (rand() < rate) {
      out.write(line + '\n');
      kept++;
    }
  }

  out.end();
  return new Promise((resolve) => out.on('finish', () => resolve({ total, kept })));
}

(async function main() {
  console.log(`Creating downsampled CSVs at rate=${rate} into ${outputDir}`);
  let grandTotal = 0, grandKept = 0;
  for (const fname of files) {
    const src = path.join(inputDir, fname);
    const dst = path.join(outputDir, fname);
    try {
      const { total, kept } = await sampleFile(src, dst);
      grandTotal += total; grandKept += kept;
      if (total > 0) {
        console.log(`[ok] ${fname}: rows=${total} -> kept=${kept}`);
      }
    } catch (e) {
      console.error(`[error] ${fname}:`, e.message);
    }
  }
  console.log(`Done. Total rows: ${grandTotal} -> kept: ${grandKept} (~${grandKept && grandTotal ? ((grandKept / grandTotal) * 100).toFixed(2) : 0}%).`);
})();
