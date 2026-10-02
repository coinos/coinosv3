// Merge prepared events without inserting between visible posts or evicting
// the reading position. Row geometry comes from the currently rendered feed.
export function mergeFeedWindow(notes, shown, additions, { rows = [], height = 0, keep = 200, page = 20, holdHead = false } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const first = rows.find((r) => r.bottom > 0 && r.top < height);
  const seen = new Set(notes.map((e) => e.id));
  const added = [], deferred = [];
  for (const e of additions) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    // Equal timestamps sort after existing events. Ignore hidden rows when
    // locating the next rendered post: they cannot serve as an anchor.
    const next = notes.find((n) => n.created_at < e.created_at && byId.has(n.id));
    const row = next && byId.get(next.id);
    // Above the first post on screen is fine even with the header showing:
    // that post is held where it is and the header goes up with the rest,
    // so the scrollbar shows there's more above without anything you're
    // reading moving. holdHead (someone is writing up there) keeps the old
    // rule, so the composer isn't scrolled out from under a typing thumb.
    const inView = row && row.top < height
      && (row === first ? holdHead && row.top > 0 : row.top >= 0);
    (inView ? deferred : added).push(e);
  }
  if (!added.length) return { notes, shown, added, deferred };
  const held = new Set([...notes.slice(0, shown).map((e) => e.id), ...byId.keys()]);
  const merged = [...notes, ...added].sort((a, b) => b.created_at - a.created_at);
  for (let i = 0; i < merged.length; i++) if (held.has(merged[i].id)) shown = Math.max(shown, i + 1);
  // Keep another page beyond the displayed window so paging still advances
  // after the reader has reached the normal in-memory cache limit.
  return { notes: merged.slice(0, Math.max(keep, shown + page)), shown, added, deferred };
}
