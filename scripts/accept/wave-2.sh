#!/usr/bin/env bash
# Wave 2 accept script: Lazy Meta-Tool Discovery Broker.
# Fail-closed: strict mode, no permissive fallbacks.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=== wave-2 accept: typecheck ==="
bun run check

echo "=== wave-2 accept: test suite ==="
bun test

echo "=== wave-2 accept: token budget + tool count + catalog size ==="
bun -e '
import { listMetaTools, estimateTokenCount, getDefaultCatalog } from "./src/lazy-broker/meta-router-mcp.ts";
const tools = listMetaTools();
if (tools.length !== 3) {
  console.error(`FAIL: tools/list exposes ${tools.length} meta-tools, expected exactly 3`);
  process.exit(1);
}
const tokens = estimateTokenCount();
if (tokens >= 500) {
  console.error(`FAIL: estimated schema footprint ${tokens} tokens exceeds the 500-token budget`);
  process.exit(1);
}
const catalog = getDefaultCatalog();
if (catalog.toolCount() < 30) {
  console.error(`FAIL: catalog indexes ${catalog.toolCount()} tools, expected at least 30`);
  process.exit(1);
}
const profiles = catalog.profiles();
if (profiles.length !== 5) {
  console.error(`FAIL: catalog covers ${profiles.length} profiles, expected 5`);
  process.exit(1);
}
console.log(`PASS: ${tools.length} meta-tools, ~${tokens} estimated tokens (<500), ${catalog.toolCount()} indexed tools across ${profiles.length} profiles`);
'

echo "=== wave-2 accept: BM25 ranking spot check ==="
bun -e '
import { searchTools } from "./src/lazy-broker/meta-router-mcp.ts";
const android = searchTools({ query: "android adb install apk device" });
if (!android[0]?.name.startsWith("adb__")) {
  console.error(`FAIL: android query top hit was ${android[0]?.name}`);
  process.exit(1);
}
const ghidra = searchTools({ query: "ghidra decompile function pseudocode" });
if (ghidra[0]?.name !== "ghidra__decompile_function") {
  console.error(`FAIL: ghidra query top hit was ${ghidra[0]?.name}`);
  process.exit(1);
}
const godot = searchTools({ query: "godot scene tree nodes" });
if (godot[0]?.name !== "godot__scene_tree") {
  console.error(`FAIL: godot query top hit was ${godot[0]?.name}`);
  process.exit(1);
}
console.log(`PASS: BM25 top-1 correct for android (${android[0]?.name}), ghidra (${ghidra[0]?.name}), godot (${godot[0]?.name})`);
'

echo "=== wave-2 accept: ALL CHECKS PASSED ==="
