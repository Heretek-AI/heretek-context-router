#!/usr/bin/env bash
# Wave 1 accept script: 4-Layer Invariant Prompt Prefix Assembler & Typed Handoffs.
# Fail-closed: strict mode, no permissive fallbacks.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=== wave-1 accept: typecheck ==="
bun run check

echo "=== wave-1 accept: test suite ==="
bun test

echo "=== wave-1 accept: prefix equality spot check (director vs qa-adversary) ==="
bun -e '
import { assemblePrefixCachedPrompt } from "./src/prefix-builder/assemble-prompt.ts";
const root = process.cwd();
const a = assemblePrefixCachedPrompt({ role: "director", workspaceRoot: root });
const b = assemblePrefixCachedPrompt({ role: "qa-adversary", workspaceRoot: root });
if (a.frozenPrefixBytes !== b.frozenPrefixBytes) {
  console.error(`FAIL: frozenPrefixBytes differ (${a.frozenPrefixBytes} vs ${b.frozenPrefixBytes})`);
  process.exit(1);
}
const frozenA = a.systemPrompt.slice(0, a.frozenPrefixBytes);
const frozenB = b.systemPrompt.slice(0, b.frozenPrefixBytes);
if (frozenA !== frozenB) {
  console.error("FAIL: frozen prefix slices differ between director and qa-adversary");
  process.exit(1);
}
console.log(`PASS: frozen prefix identical for director and qa-adversary (${a.frozenPrefixBytes} bytes, breakpoints [${a.cacheBreakpoints}])`);
'

echo "=== wave-1 accept: ALL CHECKS PASSED ==="
