// Loads the resolved brand fonts (URLs provided by the server-side font
// resolver) before any frame renders. Families without a URL are assumed
// pre-installed in the render browser (system fallbacks) and skipped.
// A font that fails to load logs and falls back to the role's generic
// stack — a render must never fail because a webfont 404'd.
//
// CRITICAL: do NOT use @remotion/fonts `loadFont`. That helper's catch path
// calls cancelRender() (node_modules/@remotion/fonts/dist/cjs/load-font.js),
// which is UNRECOVERABLE — a .catch around loadFont cannot un-cancel the
// render. Load via FontFace directly so a miss only warns and continues.
//
// delayRender/continueRender lifecycle (human review — a leaked handle hangs
// the render forever, which is worse than a missing webfont):
//   - Create the handle INSIDE the effect, not via useState. A sticky
//     useState handle is continued on the first cleanup; a second effect run
//     (React StrictMode remount, Player format switch, `fonts` prop identity
//     change) would then load against an already-continued handle and never
//     delay again — frames paint on fallback stacks while loads are in flight.
//   - ONE delayRender handle per effect run for the whole batch (not per-font).
//   - release() is idempotent for THAT run's handle so: (a) settle then cleanup,
//     (b) cleanup then late settle, and (c) batch-error then cleanup cannot
//     double-continue or leave a never-continued handle.
//   - Every exit path for a run must call release(): Promise settle, batch
//     catch, AND effect cleanup. Cleanup-on-unmount is what makes Player
//     format switches safe; without it the abandoned handle hangs forever.
//   - We still WAIT until every load settles (success OR soft-fail) before
//     release on the happy path, so successful fonts are applied before the
//     first painted frame. Cleanup may release earlier (unmount) — that is
//     intentional and still leak-free.

import { useEffect } from 'react';
import { continueRender, delayRender } from 'remotion';

/**
 * Derive CSS FontFace format keyword from URL extension.
 * Inlined from @remotion/fonts getFontFormat (we cannot import that package
 * without also risking a loadFont re-import). Unknown extensions omit the
 * format() hint rather than throwing — browser may still load the face.
 */
function getFontFormat(url) {
  const bare = String(url || '').split('?')[0].split('#')[0];
  const ext = bare.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'woff2': return 'woff2';
    case 'woff': return 'woff';
    case 'otf': return 'opentype';
    case 'ttf': return 'truetype';
    default: return null;
  }
}

/** Load one face without ever calling cancelRender. */
async function loadFontSafe({ family, url, weight, style }) {
  const fmt = getFontFormat(url);
  const source = fmt
    ? `url('${url}') format('${fmt}')`
    : `url('${url}')`;
  const font = new FontFace(family, source, {
    weight: weight != null && weight !== '' ? String(weight) : undefined,
    style: style || 'normal',
  });
  await font.load();
  document.fonts.add(font);
}

export function useBrandFonts(fonts) {
  useEffect(() => {
    // Fresh delay handle for THIS run only — see header lifecycle comment.
    // If this line is ever moved back to useState, re-runs silently lose the
    // wait and the "we still WAIT until every load settles" claim becomes a lie.
    const handle = delayRender('brand fonts');
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        continueRender(handle);
      }
    };

    const entries = Object.values(fonts || {}).filter((f) => f && f.family && f.url);
    // dedupe by family+weight+url
    const seen = new Set();
    const unique = entries.filter((f) => {
      const k = `${f.family}|${f.weight || ''}|${f.url}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Settle path: release only AFTER every load settles (success or soft-fail).
    // Do not call release() before this Promise — that is the fatal reordering
    // the offline harness pins (verifyFontServing F1c).
    Promise.all(
      unique.map((f) =>
        loadFontSafe({
          family: f.family,
          url: f.url,
          weight: f.weight,
          style: f.style || 'normal',
        }).catch((e) => {
          // Soft-fail only — never cancelRender. Role CSS keeps its generic stack.
          // eslint-disable-next-line no-console
          console.warn(`font load failed for ${f.family}: ${e.message} — using fallback stack`);
        })
      )
    )
      .then(release)
      .catch((e) => {
        // Unexpected batch error (should be unreachable — per-font catches).
        // Prefer release over a leaked handle hang.
        // eslint-disable-next-line no-console
        console.warn(`font load batch error: ${e?.message || e} — releasing delayRender`);
        release();
      });

    return () => {
      // MUST release this run's handle. Unmount / re-run without this leaks
      // forever. Idempotent with the settle path above.
      release();
    };
  }, [fonts]);
}
