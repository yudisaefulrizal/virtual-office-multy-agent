export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
}

const SKIN = ['#f1c9a5', '#e8b98f', '#d9a57b', '#c68b5e', '#a86f45', '#8c5a3a'];
const HAIR = ['#1b1512', '#2a1f1a', '#3b2a20', '#6b4a2b', '#b8862e', '#a33b2b', '#555a60'];
const PANTS = ['#1e232b', '#2a2f36', '#2f4a6b', '#3a3f47', '#4a5560'];
const SHIRT_BY_DEPT: Record<string, string[]> = {
  executive: ['#2f3a4f', '#2f6b4f', '#2e5aa8', '#c0563a', '#3d3a4f'],
  rnd: ['#f2f2ee', '#d8e6e3', '#e9e4d4'],
  operations: ['#6a4fa3', '#5a4790'],
  content: ['#d9a62e', '#e07b54', '#4f9a8f'],
};

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Aman juga untuk id pendek, kosong, dan Unicode. */
export function animationSeed(id: string) {
  return hash(id) % 17;
}

/** Tampilan avatar tetap per agent (berasal dari id), jadi setiap karyawan punya wajah sendiri. */
export function lookFor(id: string, department: string): Look {
  const h = hash(id);
  const pick = <T,>(arr: T[], salt: number) => arr[(h >>> salt) % arr.length]!;
  return {
    skin: pick(SKIN, 0),
    hair: pick(HAIR, 5),
    shirt: pick(SHIRT_BY_DEPT[department] ?? SHIRT_BY_DEPT.content!, 11),
    pants: pick(PANTS, 17),
  };
}
