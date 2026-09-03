'use strict';
/**
 * Segment prompt-override table — landing pad for adopted QC-insights
 * proposals. Entries are APPEND-ONLY prompt directives applied by
 * services/staticAdIntents.js behind STATIC_SEGMENT_PROMPT_OVERRIDES
 * (default ON; exact string 'false' disables).
 *
 * Shape:
 *   {
 *     id:            string,   // required; matched ids are stamped onto
 *                              // Ad.intentResolution.promptFlags.segmentOverrides
 *     enabled:       boolean,  // disabled entries skip
 *     match: {                 // every PRESENT field is AND; absent = match all
 *       seedStyle?:      string,
 *       variantKind?:    string,
 *       surface?:        string,   // Ad.platformFormat
 *       intent?:         string,   // intentResolution.delivered
 *       categoryPrefix?: string    // case-insensitive prefix of categoryPath
 *     },
 *     appendText:    string,   // appended under ADDITIONAL DIRECTIVES; empty skips
 *     source:        string,   // e.g. 'qc-insights:<reportId>'
 *     adoptedAt:     string    // ISO date
 *   }
 *
 * An empty table is a byte-identical no-op: buildPrompt returns the same
 * prompt string it would have without this hook. Do not add a rewrite or
 * removal entry — the applier is append-only by construction.
 *
 * ⚠️ INERT IN THIS REPO (adgen), unlike backend — verified 2026-09-03: the
 * consumer described above (`services/staticAdIntents.js` reading this table
 * behind `STATIC_SEGMENT_PROMPT_OVERRIDES`) is real in `liquidretail_backend`
 * but was never ported to adgen's own `src/services/staticAdIntents.js` —
 * `grep -rn 'segmentPromptOverrides\|STATIC_SEGMENT_PROMPT_OVERRIDES\|promptFlags'`
 * over `src/` matches nothing. The table happening to be empty makes that
 * moot today, but adding a real entry here would still do nothing at render
 * time — "APPEND-ONLY" above describes the shape contract, not a live wiring
 * guarantee on this side of the fork.
 */

module.exports = [];
