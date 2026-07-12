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

  // A stale or degenerate transform can produce out-of-range coordinates, which
  // Mapbox rejects (throwing on every tick). Callers skip the update instead.
  function isValidLngLat(ll) {
    return !!ll
      && Number.isFinite(ll.lng) && Number.isFinite(ll.lat)
      && Math.abs(ll.lat) <= 90 && Math.abs(ll.lng) <= 180;
  }

  window.DD2Calib = { apply, isValidLngLat };
})();
