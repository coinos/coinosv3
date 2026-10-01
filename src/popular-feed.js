// Shared by the relay fallback and the server's public snapshot builder.
export const PUBLIC_FEED_RELAYS = ['wss://relay.coinos.io', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export function popularCandidates(reactions) {
  const counts = new Map();
  for (const r of reactions) {
    const who = r.kind === 9735 ? (r.tags.find((x) => x[0] === 'P')?.[1] || r.pubkey) : r.pubkey;
    for (const x of r.tags) if (x[0] === 'e' && /^[0-9a-f]{64}$/.test(x[1] || '')) {
      if (!counts.has(x[1])) counts.set(x[1], new Set());
      counts.get(x[1]).add(who);
    }
  }
  return {
    ids: [...counts].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 80).map(([id]) => id),
    qualifies: (e) => e?.kind === 1 && (counts.get(e.id)?.size || 0) - (counts.get(e.id)?.has(e.pubkey) ? 1 : 0) >= 2,
  };
}
