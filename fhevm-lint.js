#!/usr/bin/env node
/**
 * fhevm-lint.js — Static linter for FHEVM Solidity contracts
 * Usage: node fhevm-lint.js path/to/contracts/
 * Zero dependencies. Catches production bugs before deployment.
 * Battle-tested from building VEIL Finance on Zama FHEVM Sepolia.
 */

const fs   = require('fs');
const path = require('path');

// ─── Rule definitions ──────────────────────────────────────────────────────
const RULES = [
  {
    id:       'AP-001',
    severity: 'error',
    message:  'FHE.div does not exist in the Zama library',
    fix:      'Cross-multiply instead: FHE.le(FHE.mul(a,100), FHE.mul(b,66))',
    test:     (line) => /FHE\.div\s*\(/.test(line),
  },
  {
    id:       'AP-002',
    severity: 'error',
    message:  'FHE.rem does not exist in the Zama library',
    fix:      'Use cross-multiplication or bit manipulation instead',
    test:     (line) => /FHE\.rem\s*\(/.test(line),
  },
  {
    id:       'AP-003',
    severity: 'error',
    message:  'require() on encrypted value — will not compile',
    fix:      'Use FHE.select(condition, value, encryptedZero) instead',
    test:     (line) => /require\s*\(\s*FHE\./.test(line),
  },
  {
    id:       'AP-004',
    severity: 'error',
    message:  'if/else branching on encrypted boolean — will not compile',
    fix:      'Use FHE.select(ebool, trueVal, falseVal) instead',
    test:     (line) => /if\s*\(\s*(FHE\.|e(bool|uint))/.test(line),
  },
  {
    id:       'AP-005',
    severity: 'error',
    message:  'Inline FHE.asEuint64(0) used in comparison — unreliable, handle has no ACL',
    fix:      'Store _encryptedZero = FHE.asEuint64(0) in constructor with FHE.allowThis()',
    test:     (line) => /FHE\.(eq|ne|lt|le|gt|ge|select)\s*\([^)]*FHE\.asEuint\d+\s*\(\s*0\s*\)/.test(line),
  },
  {
    id:       'AP-006',
    severity: 'error',
    message:  'FHE.allow called inside view function — modifies state, will not compile',
    fix:      'Remove the view modifier from this function',
    test:     (line, _i, lines, i) => {
      // Only flag if we're inside a view function
      for (let j = Math.max(0, i - 10); j < i; j++) {
        if (/function\s+\w+[^{]*\bview\b/.test(lines[j])) return /FHE\.allow/.test(line);
      }
      return false;
    },
  },
  {
    id:       'AP-007',
    severity: 'error',
    message:  'confidentialTransferFrom return value not captured — use return value for verified amount',
    fix:      'euint64 received = token.confidentialTransferFrom(...); use received not user-supplied amount',
    test:     (line) => /^\s*(collateral|debt|balance|_balance)\s*=\s*.*confidentialTransferFrom/.test(line) === false
                     && /confidentialTransferFrom\s*\(/.test(line)
                     && !/=\s*.*confidentialTransferFrom/.test(line)
                     && !/euint/.test(line.split('confidentialTransferFrom')[0].split('\n').pop()),
  },
  {
    id:       'AP-008',
    severity: 'error',
    message:  'FHE.sub without FHE.min guard — underflow risk',
    fix:      'euint64 safe = FHE.min(b, a); euint64 result = FHE.sub(a, safe);',
    test:     (line, _i, lines, i) => {
      if (!/FHE\.sub\s*\(/.test(line)) return false;
      // Check if FHE.min appears nearby (within 3 lines above)
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (/FHE\.min\s*\(/.test(lines[j])) return false;
      }
      return true;
    },
  },
  {
    id:       'AP-009',
    severity: 'error',
    message:  'FHE.allowTransient missing before confidentialTransferFrom — will revert silently',
    fix:      'Add FHE.allowTransient(amount, address(token)) immediately before the transfer',
    test:     (line, _i, lines, i) => {
      if (!/confidentialTransferFrom\s*\(/.test(line)) return false;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (/FHE\.allowTransient/.test(lines[j])) return false;
      }
      return true;
    },
  },
  {
    id:       'AP-010',
    severity: 'error',
    message:  'FHE.allowThis missing after FHE storage update — stale handle, unusable next tx',
    fix:      'Add FHE.allowThis(handle) immediately after every encrypted storage assignment',
    test:     (line, _i, lines, i) => {
      if (!/(collateral|debt|balance)\s*=\s*FHE\.(add|sub|mul|select|min|max)/.test(line)) return false;
      for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
        if (/FHE\.allowThis/.test(lines[j])) return false;
      }
      return true;
    },
  },
  {
    id:       'AP-011',
    severity: 'warning',
    message:  'euint256 used — consider euint64 for token amounts under 18 decimal precision',
    fix:      'Use euint64 for most token amounts (lower gas cost)',
    test:     (line) => /\beuint256\b/.test(line),
  },
  {
    id:       'AP-012',
    severity: 'warning',
    message:  'Possible missing ZamaEthereumConfig inheritance',
    fix:      'contract MyContract is ZamaEthereumConfig { ... }',
    test:     (line, _i, lines, i) => {
      if (!/^contract\s+\w+/.test(line)) return false;
      if (/ZamaEthereumConfig|ZamaConfig/.test(line)) return false;
      // Only warn for contracts that use FHE
      return lines.some(l => /FHE\./.test(l));
    },
  },
  {
    id:       'AP-013',
    severity: 'warning',
    message:  'approve() called on what may be a confidential token — ERC-7984 uses setOperator()',
    fix:      'Use token.setOperator(spender, until) instead of approve()',
    test:     (line) => /\.(approve)\s*\(/.test(line) && /token|Token|cweth|cWETH|CWETH/.test(line),
  },
  {
    id:       'AP-014',
    severity: 'warning',
    message:  'estimateGas called — blocked by FHEVM plugin on Sepolia',
    fix:      'Use plain Node.js with explicit { gasLimit: N } instead',
    test:     (line) => /estimateGas/.test(line),
  },
  {
    id:       'AP-015',
    severity: 'error',
    message:  'FHE.safeAdd/safeSub/safeMul do not exist yet in the Zama library',
    fix:      'Use FHE.add/sub/mul — safeX variants are not yet available',
    test:     (line) => /FHE\.(safeAdd|safeSub|safeMul)\s*\(/.test(line),
  },
];

// ─── File scanner ──────────────────────────────────────────────────────────
function lintFile(filePath) {
  const src   = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const issues = [];

  lines.forEach((line, i) => {
    // Skip comments
    const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    RULES.forEach(rule => {
      try {
        if (rule.test(stripped, i, lines, i)) {
          issues.push({
            rule:     rule.id,
            severity: rule.severity,
            line:     i + 1,
            code:     line.trim().slice(0, 80),
            message:  rule.message,
            fix:      rule.fix,
          });
        }
      } catch (_) {}
    });
  });

  return issues;
}

function findSolFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const stat = fs.statSync(dir);
  if (stat.isFile() && dir.endsWith('.sol')) return [dir];
  if (!stat.isDirectory()) return results;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      results.push(...findSolFiles(full));
    } else if (entry.endsWith('.sol')) {
      results.push(full);
    }
  }
  return results;
}

// ─── Main ──────────────────────────────────────────────────────────────────
const target = process.argv[2] || '.';
const files  = findSolFiles(target);

if (files.length === 0) {
  console.log('No .sol files found at:', target);
  process.exit(0);
}

let totalErrors = 0;
let totalWarns  = 0;

for (const file of files) {
  const issues = lintFile(file);
  if (issues.length === 0) continue;

  console.log(`\n${file}`);
  for (const issue of issues) {
    const icon = issue.severity === 'error' ? '✖' : '⚠';
    console.log(`  ${icon} line ${issue.line} [${issue.rule}] ${issue.message}`);
    console.log(`    Code: ${issue.code}`);
    console.log(`    Fix:  ${issue.fix}`);
    if (issue.severity === 'error') totalErrors++;
    else totalWarns++;
  }
}

console.log(`\n${'─'.repeat(60)}`);
if (totalErrors === 0 && totalWarns === 0) {
  console.log('✔ No FHEVM issues found');
} else {
  console.log(`Found ${totalErrors} error(s)  ${totalWarns} warning(s)`);
  if (totalErrors > 0) {
    console.log('Fix all errors before deploying to Sepolia.');
    process.exit(1);
  }
}
