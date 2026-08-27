#!/bin/bash
# Revert-proof matrix for scripts/verifyTruthfulReporting.js.
#
# Each mutation backs out one part of the fix and demands the harness goes RED.
# A mutation that leaves it green is a check that proves nothing.
#
# Restore is by file COPY, never `git checkout <commit> -- <file>` (that
# pollutes the index). Every iteration verifies the tree is clean-vs-HEAD-diff
# again before moving on, so one failed restore cannot silently poison the rest.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BK="$(mktemp -d)"
cd "$REPO" || exit 2

FILES=(services/seedTextTruth.js services/adDeliveryCounts.js routes/catalog.js routes/campaigns.js routes/ads.js services/atlasVideoService.js services/veoPromptBuilder.js)
for f in "${FILES[@]}"; do mkdir -p "$BK/$(dirname "$f")"; cp "$f" "$BK/$f"; done

BASE_SNAPSHOT="$(git diff --numstat | sort | md5)"

restore() {
  for f in "${FILES[@]}"; do cp "$BK/$f" "$f"; done
  local now
  now="$(git diff --numstat | sort | md5)"
  if [ "$now" != "$BASE_SNAPSHOT" ]; then
    echo "!! RESTORE FAILED — tree differs from baseline. ABORTING." >&2
    exit 3
  fi
}

run() {
  TRUTHFUL_VERIFY_MONGODB_URI="${TRUTHFUL_VERIFY_MONGODB_URI:-mongodb://127.0.0.1:27099}" \
    node scripts/verifyTruthfulReporting.js >"$BK/out.txt" 2>&1
  echo $?
}

echo "=== control: unmutated MUST be green ==="
rc=$(run)
if [ "$rc" != "0" ]; then
  echo "CONTROL FAILED (rc=$rc) — harness is not green before mutating:"; tail -12 "$BK/out.txt"; exit 4
fi
echo "control: GREEN ($(grep -o '[0-9]*/[0-9]* checks passed' "$BK/out.txt" | head -1))"
echo

pass=0; vacuous=0
mutate() {
  local name="$1"; shift
  "$@"
  local rc; rc=$(run)
  local failed; failed=$(grep -c '^  [0-9]*\. ' "$BK/out.txt" 2>/dev/null || echo 0)
  if [ "$rc" != "0" ]; then
    echo "✅ RED   | $name  (${failed} check(s) failed)"
    grep '^  [0-9]*\. ' "$BK/out.txt" | head -3 | sed 's/^/          /'
    pass=$((pass+1))
  else
    echo "❌ GREEN | $name  <-- VACUOUS: harness did not notice this reversion"
    vacuous=$((vacuous+1))
  fi
  restore
}

# 1 — drop `.content` from the decoder (the literal original defect).
m1() { perl -0pi -e "s/return el\.content \|\| el\.text \|\| el\.value \|\| null;/return el.text || el.value || null;/" services/seedTextTruth.js; }
mutate "M1 decoder stops reading .content (the original bug)" m1

# 2 — derive the boolean from the DECODED list again.
m2() { perl -0pi -e "s/const seedHasText = fromPrompt === true \? true : fromMedia;/const seedHasText = burnedInText.length > 0;/" services/seedTextTruth.js; }
mutate "M2 boolean re-derived from burnedInText.length" m2

# 3 — mirror function starts decoding instead of counting.
m3() { perl -0pi -e "s/return Array\.isArray\(media\?\.text\) && media\.text\.length > 0;/return Array.isArray(media?.text) \&\& media.text.map(decodeSeedTextElement).filter(Boolean).length > 0;/" services/seedTextTruth.js; }
mutate "M3 producer-mirror decodes instead of counting" m3

# 4 — collapse the tri-state: a genuine raw override reported as a confident false.
m4() { perl -0pi -e "s/  if \(promptIsTheRawOverride\) return null;/  if (promptIsTheRawOverride) return false;/" services/seedTextTruth.js; }
mutate "M4 genuine raw-override reported as FALSE (tri-state collapsed)" m4

# 5 — the prompt signal stops winning; back to media-only.
m5() { perl -0pi -e "s/const seedHasText = fromPrompt === true \? true : fromMedia;/const seedHasText = fromMedia;/" services/seedTextTruth.js; }
mutate "M5 persisted-prompt signal no longer wins" m5

# 6 — 'failed' counted as delivered.
m6() { perl -0pi -e "s/^const DELIVERED_STATUSES = \['draft', 'live'\];/const DELIVERED_STATUSES = ['draft', 'live', 'failed'];/m" services/adDeliveryCounts.js; }
mutate "M6 'failed' admitted to DELIVERED_STATUSES" m6

# 7 — in-flight counted as delivered.
m7() { perl -0pi -e "s/^const DELIVERED_STATUSES = \['draft', 'live'\];/const DELIVERED_STATUSES = ['draft', 'live', 'queued', 'rendering'];/m" services/adDeliveryCounts.js; }
mutate "M7 queued/rendering admitted to DELIVERED_STATUSES" m7

# 8 — coverage loses its non-finite guard (NaN/Infinity reaches the SPA).
m8() { perl -0pi -e "s/  if \(!Number\.isFinite\(t\) \|\| t <= 0\) return 0;/  \/\/ guard removed/" services/adDeliveryCounts.js; }
mutate "M8 coverage loses its zero/NaN target guard" m8

# 9 — catalog coverage back to adCount / target (the shipped defect).
m9() { perl -0pi -e "s/const coveragePct   = coveragePctFromDelivered\(deliveredCount, TARGET_ADS_PER_PRODUCT\);/const coveragePct   = Math.min(100, Math.round((adCount \/ TARGET_ADS_PER_PRODUCT) * 100));/" routes/catalog.js; }
mutate "M9 catalog coveragePct back to adCount/target" m9

# 10 — 'products covered' back to any row.
m10() { perl -0pi -e "s/productsOut\.filter\(p => p\.deliveredCount > 0\)\.length/productsOut.filter(p => p.adCount > 0).length/" routes/catalog.js; }
mutate "M10 'N of M products covered' back to adCount>0" m10

# 11 — campaigns 'with ads' back to any row.
m11() { perl -0pi -e "s/out\.filter\(c => c\.deliveredCount > 0\)\.length/out.filter(c => c.adCount > 0).length/" routes/campaigns.js; }
mutate "M11 campaigns campaignsWithAds back to adCount>0" m11

# 12 — the approximation declaration removed from the scaffold response.
m12() { perl -0pi -e "s/      isApproximation: true,/      isApproximation: false,/" services/atlasVideoService.js; }
mutate "M12 scaffold stops declaring isApproximation:true" m12

# 13 — the shared helper import removed from the route.
m13() { perl -0pi -e "s|const \{ resolveSeedTextTruth \} = require\('\.\./services/seedTextTruth'\);||" routes/ads.js; }
mutate "M13 routes/ads.js loses the seedTextTruth import" m13

# 14 — the guard constant no longer exported from the builder.
m14() { perl -0pi -e "s/^  SEED_BURNED_IN_TEXT_GUARD_LINE,\$//m" services/veoPromptBuilder.js; }
mutate "M14 guard constant no longer exported from veoPromptBuilder" m14

# 15 — THE ADVERSARIAL FINDING: delivered drops the titling conjunct.
m15() { perl -0pi -e "s/      \{ \\\$in: \['\\\$status', DELIVERED_STATUSES\] \},\n      titlingSettledExpr\(\)/      { \\\$in: ['\\\$status', DELIVERED_STATUSES] }/" services/adDeliveryCounts.js; }
mutate "M15 deliveredExpr drops the titling conjunct (status-only)" m15

# 16 — THE STALE-FIELD HOLE: gate on the field being set, not on the prompt.
m16() { perl -0pi -e "s/  const promptIsTheRawOverride = rawTrim\.length > 0 && rawTrim\.startsWith\(prompt\.trim\(\)\);/  const promptIsTheRawOverride = rawTrim.length > 0;/" services/seedTextTruth.js; }
mutate "M16 raw gate keys on the FIELD being set, not the persisted prompt" m16

# 17 — the reverse disagreement stops being reported.
m17() { perl -0pi -e "s/    guardMissingAtRender: fromPrompt === false && fromMedia/    guardMissingAtRender: false/" services/seedTextTruth.js; }
mutate "M17 guardMissingAtRender hard-wired false (reverse disagreement silenced)" m17

# 18 — presence checked AFTER the override gate, so a raw prompt carrying the
#      guard reports null instead of true.
m18() { perl -0pi -e "s/  if \(prompt\.includes\(guardLine\)\) return true;\n\n/  \/\/ moved\n/" services/seedTextTruth.js; }
mutate "M18 guard-presence no longer checked before the override gate" m18

# 19 — distinctOnDelivered reverts to a status-only predicate.
m19() { perl -0pi -e "s/      \\\$cond: \[deliveredExpr\(\), fieldRef, null\]/      \\\$cond: [{ \\\$in: ['\\\$status', DELIVERED_STATUSES] }, fieldRef, null]/" services/adDeliveryCounts.js; }
mutate "M19 distinctOnDelivered reverts to status-only" m19

# 20 — the untitled population stops being reported.
m20() { perl -0pi -e "s/    untitledDeliverableCount: \{/    unusedRenamed: {/" services/adDeliveryCounts.js; }
mutate "M20 untitledDeliverableCount no longer returned" m20

echo
echo "=== final restore verification ==="
restore
echo "tree restored OK; git diff --stat:"
git diff --stat | tail -10
echo
echo "RESULT: $pass mutations caught RED, $vacuous vacuous"
rm -rf "$BK"
[ "$vacuous" -eq 0 ] || exit 1
