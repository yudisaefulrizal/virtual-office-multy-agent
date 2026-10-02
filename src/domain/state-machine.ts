export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** State machine kecil: daftar transisi yang diizinkan per status. */
export function stateMachine<S extends string>(entity: string, allowed: Record<S, readonly S[]>) {
  const can = (from: S, to: S) => allowed[from].includes(to);
  return {
    statuses: Object.keys(allowed) as S[],
    can,
    assert(from: S, to: S) {
      if (!can(from, to)) throw new DomainError(`${entity}: transisi ${from} → ${to} tidak diizinkan`);
    },
    isTerminal: (s: S) => allowed[s].length === 0,
  };
}
