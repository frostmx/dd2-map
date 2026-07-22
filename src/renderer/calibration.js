// Shared by both renderers (loaded with a plain <script src>, no bundler).
// The overlay needs to apply the calibration too, and this must not drift from
// the version the calibration flow writes — so it lives in exactly one place.
//
// Full 2D affine:
//   lng = a*gameX + b*gameY + c
//   lat = d*gameX + e*gameY + f
// The b/d cross-terms carry the rotation between the game's world axes and the
// map's north-up axes. Legacy saved files use the old separable form
// (lng = a*gx + b, lat = c*gy + d) — detected by the absence of e/f — and are
// still honored on load.
(function () {
  function apply(cal, gameX, gameY) {
    if (!cal) return null;
    if (typeof cal.e === 'number' && typeof cal.f === 'number') {
      return {
        lng: cal.a * gameX + cal.b * gameY + cal.c + (cal.offsetLng || 0),
        lat: cal.d * gameX + cal.e * gameY + cal.f + (cal.offsetLat || 0),
      };
    }
    return {
      lng: cal.a * gameX + cal.b + (cal.offsetLng || 0),
      lat: cal.c * gameY + cal.d + (cal.offsetLat || 0),
    };
  }

  // The other direction: map lng/lat -> game coords. Needed to place mapgenie's
  // own POIs (specifically the dungeon-entrance portals) in the game's coordinate
  // space, so the app can tell when the player walks into one.
  //
  // Inverting the 2x2 linear part [[a,b],[d,e]] and undoing the translation.
  // Only defined for the full affine form; the legacy separable form has no
  // cross-terms to invert and predates any of this.
  function invert(cal, lng, lat) {
    if (!cal || typeof cal.e !== 'number' || typeof cal.f !== 'number') return null;
    const det = cal.a * cal.e - cal.b * cal.d;
    if (!Number.isFinite(det) || det === 0) return null;
    const dl = lng - cal.c - (cal.offsetLng || 0);
    const dt = lat - cal.f - (cal.offsetLat || 0);
    return {
      x: (cal.e * dl - cal.b * dt) / det,
      y: (-cal.d * dl + cal.a * dt) / det,
    };
  }

  // A stale or degenerate transform can produce out-of-range coordinates, which
  // Mapbox rejects (throwing on every tick). Callers skip the update instead.
  function isValidLngLat(ll) {
    return !!ll
      && Number.isFinite(ll.lng) && Number.isFinite(ll.lat)
      && Math.abs(ll.lat) <= 90 && Math.abs(ll.lng) <= 180;
  }

  // Which transform applies right now: the overworld affine, or the inset one for
  // the dungeon floor you're standing in.
  //
  // Almost every inset shares one 2x2 linear part (`insetLinear`) and differs only by
  // translation; a few carry an optional per-area `scale`. Those transforms are
  // AUTHORED in config/dungeons.json (by the `.map` tooling and by hand) — the app
  // only reads them; nothing calibrates a dungeon at runtime any more.
  //
  // Returns null for an area with no authored transform in the table. Callers must
  // treat that as "don't move the marker" rather than falling back to the overworld
  // affine, which would confidently draw you in the wrong place.
  function forArea(worldCal, areas, areaKey) {
    if (!areaKey) return worldCal;
    if (!areas || !areas.insetLinear) return null;
    const area = areas.areas && areas.areas[areaKey];
    if (!area || typeof area.c !== 'number' || typeof area.f !== 'number') return null;
    const lin = areas.insetLinear;
    // Almost every inset shares one linear part and differs only by translation (c, f).
    // A few are drawn at their own scale on mapgenie (Ancestral Chamber's inset is ~0.68x
    // the shared scale); an optional per-area `scale` multiplies the shared linear for just
    // that area. Absent -> 1, so the shared-linear areas are untouched. `c`/`f` are stored
    // for the SCALED linear, so the area's box centre stays put and the marker/edge scale
    // around it. See FINDINGS "Dungeon edge art" and DD2Calib.forArea in CLAUDE.md.
    const s = typeof area.scale === 'number' ? area.scale : 1;
    return { a: lin.a * s, b: lin.b * s, c: area.c, d: lin.d * s, e: lin.e * s, f: area.f };
  }

  // The player's position pushed a little way along `facing` (a unit vector in GAME
  // coords, from main's camera read), mapped through the SAME transform as the player.
  //
  // The guest turns these two points into an angle. It has to be done as a POINT and not
  // as an angle: the affine's b/d cross-terms carry the rotation between the game's axes
  // and the map's north-up ones, and a dungeon inset applies its own transform on top —
  // so a facing angle converted by hand would be wrong in the overworld and wrong in a
  // different way underground. Send a point through the real transform and the rotation
  // comes along for free.
  //
  // AHEAD_UNITS just has to be big enough to project to more than a pixel at any zoom;
  // the transform is linear, so the distance cannot change the resulting angle.
  const AHEAD_UNITS = 25;

  function aheadPoint(cal, gameX, gameY, facing) {
    if (!cal || !facing) return null;
    const p = apply(cal, gameX + facing.x * AHEAD_UNITS, gameY + facing.y * AHEAD_UNITS);
    return isValidLngLat(p) ? p : null;
  }

  window.DD2Calib = { apply, invert, forArea, isValidLngLat, aheadPoint };
})();
