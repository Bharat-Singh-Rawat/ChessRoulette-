export type Opening = { id: string; name: string };

export const OPENINGS: Opening[] = [
  { id: "kings_pawn", name: "King's Pawn (1.e4)" },
  { id: "queens_pawn", name: "Queen's Pawn (1.d4)" },
  { id: "english", name: "English Opening (1.c4)" },
  { id: "reti", name: "Réti Opening (1.Nf3)" },
  { id: "sicilian", name: "Sicilian Defense" },
  { id: "french", name: "French Defense" },
  { id: "caro_kann", name: "Caro-Kann Defense" },
  { id: "italian", name: "Italian Game" },
  { id: "ruy_lopez", name: "Ruy López" },
  { id: "scotch", name: "Scotch Game" },
  { id: "queens_gambit", name: "Queen's Gambit" },
  { id: "kings_indian", name: "King's Indian Defense" },
  { id: "nimzo_indian", name: "Nimzo-Indian Defense" },
  { id: "grunfeld", name: "Grünfeld Defense" },
  { id: "dutch", name: "Dutch Defense" },
];

const VALID_IDS = new Set(OPENINGS.map((o) => o.id));

export function parsePreferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && VALID_IDS.has(id));
  } catch {
    return [];
  }
}

export function serializePreferences(ids: string[]): string {
  const cleaned = Array.from(new Set(ids.filter((id) => VALID_IDS.has(id))));
  return JSON.stringify(cleaned);
}

export function nameForId(id: string): string {
  return OPENINGS.find((o) => o.id === id)?.name ?? id;
}
