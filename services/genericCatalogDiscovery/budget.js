// services/genericCatalogDiscovery/budget.js
//
// Pure wall-clock budget for the generic catalog scraper. No I/O, no
// requires — just arithmetic over an injected clock so harnesses are
// deterministic. The scan loops consult expired() / remainingMs() next
// to abortCheck(); progressService.MAX_RUN_MS is a separate dead-process
// safety net and is deliberately left alone.

'use strict';

/**
 * createBudget({ totalMs, now })
 *
 * `now` MUST be injected (defaults to the Date.now reference) — never
 * invoke the system clock anywhere else inside this module; tests advance
 * a fake clock.
 *
 * Unbounded totalMs: a non-finite or absent value, OR totalMs <= 0, means
 * "no wall-clock budget". expired() is always false. That is intentional
 * safety: an unset / blank / typo'd env var must not make every run expire
 * instantly. Operators who want a real cap set a positive finite number.
 *
 * @param {{ totalMs?: number, now?: () => number }} [opts]
 * @returns {{
 *   startedAt: number,
 *   deadlineAt: number,
 *   remainingMs: () => number,
 *   expired: () => boolean,
 *   spentMs: () => number,
 *   enterRung: (name: string, allotmentMs: number) => {
 *     name: string,
 *     remainingMs: () => number,
 *     expired: () => boolean,
 *     elapsedMs: () => number
 *   }
 * }}
 */
function createBudget({ totalMs, now = Date.now } = {}) {
  // Non-finite (undefined / NaN / Infinity) OR non-positive → unbounded.
  // totalMs <= 0 is treated as unbounded so a misconfigured "0" cannot
  // expire every run at the first check.
  const unbounded = !Number.isFinite(totalMs) || totalMs <= 0;
  const startedAt = now();
  const deadlineAt = unbounded ? Infinity : startedAt + totalMs;

  function remainingMs() {
    if (unbounded) return Infinity;
    return Math.max(0, deadlineAt - now());
  }

  function expired() {
    if (unbounded) return false;
    return now() >= deadlineAt;
  }

  function spentMs() {
    return Math.max(0, now() - startedAt);
  }

  /**
   * Open a named sub-budget. Allotment is clamped to the parent's
   * remaining time so a rung can never outlive its parent. A finite
   * allotment of 0 means "no time left for this rung" (immediately
   * expired) — that is intentional, unlike the root totalMs<=0
   * "unbounded" safety above. Non-finite / negative allotment falls
   * through to the parent's full remainder.
   */
  function enterRung(name, allotmentMs) {
    const parentRem = remainingMs();
    let capped;
    if (!Number.isFinite(allotmentMs) || allotmentMs < 0) {
      capped = parentRem;
    } else {
      // min(allotment, parent remainder); 0 stays 0 (rung already spent).
      capped = Math.min(allotmentMs, parentRem);
    }

    const rungStartedAt = now();
    // Rung deadline is the earlier of (parent deadline, start + capped).
    // When parent is unbounded and capped is finite, only the rung clock binds.
    const rungDeadlineAt = !Number.isFinite(capped)
      ? deadlineAt
      : Math.min(
          Number.isFinite(deadlineAt) ? deadlineAt : Infinity,
          rungStartedAt + capped
        );

    return {
      name: String(name || ''),
      remainingMs() {
        if (!Number.isFinite(rungDeadlineAt)) return Infinity;
        // Never report more time than the parent still has.
        return Math.max(0, Math.min(rungDeadlineAt - now(), remainingMs()));
      },
      expired() {
        // Parent expiry forces every open rung closed.
        if (expired()) return true;
        if (!Number.isFinite(rungDeadlineAt)) return false;
        return now() >= rungDeadlineAt;
      },
      elapsedMs() {
        return Math.max(0, now() - rungStartedAt);
      }
    };
  }

  return {
    startedAt,
    deadlineAt,
    remainingMs,
    expired,
    spentMs,
    enterRung
  };
}

module.exports = { createBudget };
