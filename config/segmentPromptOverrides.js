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
 */

module.exports = [];
