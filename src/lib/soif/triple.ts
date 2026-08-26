import type { Triple } from "./types";

/**
 * Arithmetic on (low, mid, high) scenario triples.
 *
 * Triples multiply bound-wise: low × low, mid × mid, high × high. That is what
 * makes the reported range a best/central/worst *scenario* spread rather than a
 * statistical interval, and it is why the spread is often ~100× wide. Collapsing
 * a triple to its mid anywhere upstream of display throws that away.
 */

export const ZERO: Triple = { low: 0, mid: 0, high: 0 };

export function triple(low: number, mid: number, high: number): Triple {
  return { low, mid, high };
}

/** Widen a scalar into a triple with no spread — used for raw factor overrides. */
export function asTriple(value: number | Triple): Triple {
  return typeof value === "number" ? { low: value, mid: value, high: value } : value;
}

export function add(a: Triple, b: Triple): Triple {
  return { low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high };
}

export function sum(triples: readonly Triple[]): Triple {
  return triples.reduce(add, ZERO);
}

export function mul(a: Triple, b: Triple): Triple {
  return { low: a.low * b.low, mid: a.mid * b.mid, high: a.high * b.high };
}

export function scale(t: Triple, k: number): Triple {
  return { low: t.low * k, mid: t.mid * k, high: t.high * k };
}

/** Add a scalar to every bound. `shift(lifecycle, -1)` gives the embodied adder. */
export function shift(t: Triple, k: number): Triple {
  return { low: t.low + k, mid: t.mid + k, high: t.high + k };
}

export function isZero(t: Triple): boolean {
  return t.low === 0 && t.mid === 0 && t.high === 0;
}
