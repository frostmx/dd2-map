// The script we inject into the mapgenie <webview> guest, shared by the main
// window and the overlay (loaded with a plain <script src>, no bundler).
//
// It has to be injected as a STRING via executeJavaScript rather than shipped as
// a webview preload: in this Electron version a webview preload does not
// actually share `window.map` with the page, even with contextIsolation=no, so
// host-side executeJavaScript is the only thing that reliably reaches the real
// Mapbox instance. See FINDINGS.md.
//
// Guest API this installs:
//   __dd2_apply(lng, lat, follow, moved, aheadLng, aheadLat)
//                                          position + follow + facing; every tick
//   __dd2_probe()                          -> JSON: canvas alpha, zoom range, layers
//   __dd2_set_zoom_target(z | null)        drive zoom from the follow loop (overlay)
//   __dd2_set_basemap_visible(bool)        icons-only mode (overlay)
//   __dd2_set_rotate(bool)                 heading-up map rotation (overlay)
//
// The main window passes no zoom target (it owns its own zoom via the saved-view
// easeTo glide) and keeps mapgenie's chrome; the overlay drives zoom and strips
// the chrome. Same loop, two callers.
(function () {
  function buildInstallMarker(opts) {
    const o = opts || {};
    const zoomEase = typeof o.zoomEase === 'number' ? o.zoomEase : 0.12;
    const rotateEase = typeof o.rotateEase === 'number' ? o.rotateEase : 0.1;
    const headingEase = typeof o.headingEase === 'number' ? o.headingEase : 0.35;
    const hideChrome = !!o.hideChrome;

    return `
  (function() {
    if (window.__dd2_apply) return true;

    var ZOOM_EASE = ${zoomEase};
    var ROT_EASE = ${rotateEase};
    var HEAD_EASE = ${headingEase};
    var HIDE_CHROME = ${hideChrome};

    // Dot + arrow. The dot IS the position (it sits on the anchor point); the
    // arrow overlaps it and points where you're FACING — read from the game's camera
    // (see setHeadingFromAhead). When the camera can't be read, it falls back to the
    // movement vector (updateHeading), which is all there was before the camera was
    // found and which reports nothing at all while you stand still.
    function ensureMarker() {
      var m = document.getElementById('__dd2_player_marker__');
      if (!m) {
        m = document.createElement('div');
        m.id = '__dd2_player_marker__';
        m.style.cssText = 'position:absolute;width:44px;height:44px;pointer-events:none;z-index:9999;transform:translate(-50%,-50%);will-change:left,top;filter:drop-shadow(0 0 3px rgba(0,0,0,0.8));';
        // viewBox is centered on (22,22) — the circle's center — so rotating the
        // group around that point spins the arrow about the player's position
        // without moving the dot off the anchor.
        m.innerHTML =
          '<svg width="44" height="44" viewBox="0 0 44 44">' +
            '<g id="__dd2_marker_rot__">' +
              '<path d="M42 22 L27 13 L27 31 Z" fill="#ff3b30"/>' +
              '<circle cx="22" cy="22" r="9" fill="#ff3b30" stroke="#fff" stroke-width="2"/>' +
            '</g>' +
          '</svg>';
        document.body.appendChild(m);
      }
      return m;
    }

    // Shortest way round: -180..180, so crossing due-west never spins the long way.
    //
    // The +540 trick this used to be — ((target - cur + 540) % 360) - 180 — is only
    // correct while the dividend stays positive. JS's % takes the sign of the DIVIDEND, so
    // once (target - cur) fell below -540 it returned a negative remainder and the whole
    // expression left the -180..180 range: the caller then eased the BEARING the long way
    // round, by a huge step. That is the endless left spin. It needed an unbounded input to
    // trigger, which is exactly what __dd2_heading__ became once the camera started
    // feeding it (see wrap180 below).
    function angleDiff(target, cur) {
      var d = (target - cur) % 360;   // (-360, 360), sign of the dividend
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      return d;
    }

    // Keep an angle in -180..180. The heading is an ACCUMULATOR — every frame it steps
    // toward the target — so without this it just keeps counting: turn the camera left for
    // a few seconds and it runs off to -400, -700, and on down. Nothing downstream cares
    // about the winding number (the bearing goes through angleDiff, the SVG rotate() is
    // modular anyway), so wrapping it costs nothing and stops any consumer from ever
    // seeing an angle it can't handle.
    //
    // The old movement-derived heading hid this: it refused to update until you had moved
    // 3+ pixels, so it never wound up. A camera heading tracks every mouse flick.
    function wrap180(a) {
      var x = a % 360;
      if (x > 180) x -= 360;
      if (x < -180) x += 360;
      return x;
    }

    // Heading from the movement vector, in WORLD space (degrees CW from east, i.e.
    // north = -90 — the frame the marker's SVG rotate() speaks).
    //
    // It has to be derived from the WORLD delta projected to pixels, not from the
    // marker's pixel movement: under locked-center follow the marker never moves
    // on screen (the map moves under it), so a pixel-delta heading would always
    // read zero. Projecting two world points with the current camera gives a
    // vector that's correct at any zoom.
    //
    // The + getBearing() is LOAD-BEARING, and only looks redundant while the map
    // is north-up. project() reports SCREEN pixels, so in heading-up mode the
    // frame we measure the heading in is the very thing the heading rotates:
    // without the term, the map turns, the projected delta swings back toward
    // "up", the heading collapses toward north and the bearing chases its own
    // tail. Mapbox's bearing is the compass direction drawn "up", so a world
    // direction of azimuth c lands on screen at atan2(dy,dx) = c - 90 - bearing;
    // adding the bearing back cancels the camera and leaves a heading that is
    // camera-independent, which is the only kind you can safely feed back into it.
    //
    // prev only advances once the vector clears a few pixels, so slow walking
    // still accumulates a heading instead of being lost to per-frame noise. The
    // last heading is held while you stand still — the map/arrow keeps pointing
    // where you were last going, rather than snapping to some arbitrary direction.
    function updateHeading(d) {
      var prev = window.__dd2_prev_ll__;
      if (!prev) { window.__dd2_prev_ll__ = { lng: d.lng, lat: d.lat }; return; }

      var a = window.map.project(prev);
      var b = window.map.project({ lng: d.lng, lat: d.lat });
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      if (dx * dx + dy * dy < 9) return; // < 3px of travel: not a direction yet

      var target = Math.atan2(dy, dx) * 180 / Math.PI + window.map.getBearing();
      var cur = (typeof window.__dd2_heading__ === 'number') ? window.__dd2_heading__ : target;
      window.__dd2_heading__ = wrap180(cur + angleDiff(target, cur) * 0.25);
      window.__dd2_prev_ll__ = { lng: d.lng, lat: d.lat };
    }

    // Web Mercator, in RADIANS on both axes — x = lng, y = ln(tan(45 + lat/2)). Both, and
    // in the same unit, is the whole point: this frame is what makes an angle measured in
    // lng/lat mean the same thing as an angle measured on screen (isotropic, north-up,
    // and here flipped y-down to match the screen).
    //
    // Mixing the units silently wrecks the angle. A first cut compared a mercY() delta
    // (radians) against a raw lng delta (degrees), making y ~57x too small: the heading
    // then crawled while you faced east/west and snapped through +/-90 in an instant —
    // and that snap, fed to the bearing, is what set the map spinning.
    function mercX(lng) {
      return lng * Math.PI / 180;
    }
    function mercY(lat) {
      var r = lat * Math.PI / 180;
      return Math.log(Math.tan(Math.PI / 4 + r / 2));
    }

    // Heading from the game's CAMERA — a true facing angle, held while you stand still.
    //
    // The caller hands us a LOOK-AHEAD point: the player's position pushed a little way
    // along the camera's view direction, run through the SAME game->map transform as the
    // player himself. That indirection is the point. Facing is a vector in GAME space, and
    // the calibration affine carries a ROTATION between the game's axes and the map's
    // north-up ones (the b/d cross-terms) — plus a dungeon inset has a transform of its
    // own. Converting the angle by hand would have to re-derive all of that and would go
    // subtly wrong underground. Two points that both went through the real transform
    // can't: whatever the transform does to the world, it does to both.
    //
    // DELIBERATELY DOES NOT USE map.project() / getBearing(). It did, and it produced an
    // ENDLESS SPIN on a fast camera swing: project() reports SCREEN pixels, i.e. it
    // measures in the very frame that the bearing rotates, and the bearing is driven from
    // this heading. Cancelling it back out with + getBearing() is exact only if the two are
    // read in lockstep; any lag between them closes a positive feedback loop, the map winds
    // itself up, and it only stops if you swing back the other way and unwind it by hand.
    // updateHeading (movement) hides the same coupling by accident — it refuses to update
    // until you've MOVED 3+ pixels, so a standing player freezes it and the loop never
    // closes. The camera heading updates every frame, so it can't rely on that.
    //
    // Computing the angle from lng/lat in the fixed north-up Mercator frame makes the
    // heading a pure function of (facing, calibration). The map's own rotation is not an
    // input, so no amount of lag can feed back. Output convention matches updateHeading:
    // degrees CW from east, camera-independent.
    function setHeadingFromAhead(d, ahead) {
      var dx = mercX(ahead.lng) - mercX(d.lng);
      var dy = -(mercY(ahead.lat) - mercY(d.lat)); // screen y grows DOWN; Mercator y grows north
      if (dx === 0 && dy === 0) return false;      // degenerate — keep the heading we have

      var target = Math.atan2(dy, dx) * 180 / Math.PI;
      var cur = (typeof window.__dd2_heading__ === 'number') ? window.__dd2_heading__ : target;
      // Lighter smoothing than the movement heading needs: this signal is already clean
      // (it's the camera, not a noisy per-tick delta), so it only has to take the edge off
      // a fast mouse flick, not reconstruct a direction from jitter.
      window.__dd2_heading__ = wrap180(cur + angleDiff(target, cur) * HEAD_EASE);
      return true;
    }

    // --- Probe -------------------------------------------------------------
    // Three things about mapgenie's Mapbox instance we refuse to hardcode: the
    // layer ids (so icons-only survives a mapgenie restyle), the real zoom range
    // (so zoom clamping needs no guessed constants), and whether the WebGL canvas
    // even has an alpha channel. That last one is the whole basis of icons-only
    // mode: hiding the base layers only reveals the game underneath if the
    // context was created with alpha:true (the Mapbox default). If it wasn't, the
    // host says so loudly rather than leaving you staring at a black screen.
    window.__dd2_probe = function() {
      if (!window.map || typeof window.map.getStyle !== 'function') return null;
      // Wait for the style to finish loading. Probing early caught mapgenie
      // mid-load and reported "2 layers (0 symbol)" — a real style has ~14/5 —
      // which would make the layer count a lie. The caller retries each tick.
      if (typeof window.map.isStyleLoaded === 'function' && !window.map.isStyleLoaded()) return null;
      var alpha = null;
      try {
        alpha = window.map.painter.context.gl.getContextAttributes().alpha;
      } catch (e) { /* internals moved; alpha stays unknown */ }
      var layers = [];
      try {
        layers = window.map.getStyle().layers.map(function(l) { return { id: l.id, type: l.type }; });
      } catch (e) { /* style not ready yet */ }
      return JSON.stringify({
        alpha: alpha,
        zoom: window.map.getZoom(),
        minZoom: window.map.getMinZoom(),
        maxZoom: window.map.getMaxZoom(),
        layers: layers
      });
    };

    // --- Icons-only mode ---------------------------------------------------
    // "Base map" = every layer that is not a symbol layer, read from the LIVE
    // style rather than a hardcoded list. Symbol layers are the POI icons and
    // their labels; everything else (background, raster tiles, fills, lines) is
    // the map itself. Hide those, make the page background transparent, and
    // what's left is icons on glass over the game.
    // The desired state is remembered and RE-APPLIED on every styledata event,
    // because the layer list is not stable: the style streams in after the map
    // object exists (an early call would see 2 layers instead of 14), and
    // mapgenie mutates layers as you toggle POI categories. So we never cache
    // ids — we recompute from the live style each time and re-assert on change.
    window.__dd2_basemap_visible__ = true;

    window.__dd2_set_basemap_visible = function(visible) {
      window.__dd2_basemap_visible__ = !!visible;
      return applyBasemap();
    };

    function applyBasemap() {
      if (!window.map || typeof window.map.getStyle !== 'function') return false;
      if (window.__dd2_basemap_applying__) return false; // setLayoutProperty re-fires styledata
      // Deliberately NOT gated on isStyleLoaded(). It flickers false while the
      // map streams sources, and gating on it silently DROPPED the restore —
      // press F9 to hide, F9 again to restore, and the map never came back. We
      // don't cache ids, so applying against a partial layer list is harmless:
      // the styledata hook re-applies as the rest arrive.
      var visible = window.__dd2_basemap_visible__;

      // Remember each layer's ORIGINAL visibility before hiding it, and restore
      // to exactly that. Do NOT blanket-set 'visible' on restore: mapgenie ships
      // several non-symbol layers already hidden (alternate rasters/masks), and
      // switching those on turns the whole map black. Restoring only the layers
      // WE hid also means this is a no-op when nothing is hidden — which is why
      // it's safe to run from the styledata/idle hooks in both windows.
      var orig = window.__dd2_layer_orig__ || (window.__dd2_layer_orig__ = {});
      window.__dd2_basemap_applying__ = true;
      try {
        if (!visible) {
          window.map.getStyle().layers.forEach(function(l) {
            if (l.type === 'symbol') return; // POI icons + labels: what we keep
            if (!(l.id in orig)) {
              var v;
              try { v = window.map.getLayoutProperty(l.id, 'visibility'); } catch (e) { /* ignore */ }
              orig[l.id] = (v === undefined || v === null) ? 'visible' : v;
            }
            try {
              window.map.setLayoutProperty(l.id, 'visibility', 'none');
            } catch (e) { /* layer vanished mid-restyle; ignore */ }
          });
        } else {
          Object.keys(orig).forEach(function(id) {
            try {
              window.map.setLayoutProperty(id, 'visibility', orig[id]);
            } catch (e) { /* layer vanished mid-restyle; ignore */ }
            delete orig[id];
          });
        }
      } finally {
        window.__dd2_basemap_applying__ = false;
      }
      setTransparentPage(!visible);
      return true;
    }

    // Once the background layer is hidden the canvas itself is transparent (given
    // alpha:true); these are the DOM ancestors that would otherwise still paint an
    // opaque colour behind it.
    function setTransparentPage(on) {
      var id = '__dd2_transparent_css__';
      var el = document.getElementById(id);
      if (on) {
        if (!el) {
          el = document.createElement('style');
          el.id = id;
          document.head.appendChild(el);
        }
        el.textContent = 'html,body,#map,.map,.mapboxgl-map,.mapboxgl-canvas-container{background:transparent !important;}';
      } else if (el) {
        el.remove();
      }
    }

    // --- Hide found POIs ---------------------------------------------------
    // mapgenie doesn't put found locations on their own layer — it fades them in
    // place, via a paint expression on the 'locations' layer:
    //   icon-opacity: ["case", ["boolean", ["feature-state","found"], false], 0.4, 1]
    // So "found" is just 40% opacity. Once the overlay's own opacity and
    // brightness are stacked on top, 0.4 vs 1.0 is barely a difference — which is
    // why marked POIs still cluttered the map.
    //
    // Fix: rewrite that expression's found-branch to 0. It has to be done in the
    // PAINT expression, not a layer filter — Mapbox filters cannot read
    // feature-state, so a filter simply can't see which locations are found.
    var FOUND_TARGETS = [
      ['locations', 'icon-opacity'],
      ['locations', 'text-opacity'],
      ['location-titles', 'text-opacity'],
      ['location-titles', 'icon-opacity'],
    ];
    var HIDE_FOUND_EXPR = ['case', ['boolean', ['feature-state', 'found'], false], 0, 1];

    window.__dd2_hide_found__ = false;

    window.__dd2_set_hide_found = function(hide) {
      window.__dd2_hide_found__ = !!hide;
      return applyHideFound();
    };

    function applyHideFound() {
      if (!window.map || typeof window.map.getLayer !== 'function') return false;
      if (window.__dd2_found_applying__) return false; // setPaintProperty re-fires styledata
      var hide = window.__dd2_hide_found__;
      var orig = window.__dd2_found_orig__ || (window.__dd2_found_orig__ = {});

      window.__dd2_found_applying__ = true;
      try {
        FOUND_TARGETS.forEach(function(t) {
          var id = t[0], prop = t[1];
          if (!window.map.getLayer(id)) return;
          var key = id + '|' + prop;
          try {
            if (hide) {
              // Remember what mapgenie had, so restore puts back its real
              // expression (the 0.4 fade) rather than a flat 1.
              if (!(key in orig)) orig[key] = window.map.getPaintProperty(id, prop);
              window.map.setPaintProperty(id, prop, HIDE_FOUND_EXPR);
            } else if (key in orig) {
              window.map.setPaintProperty(id, prop, orig[key]);
              delete orig[key];
            }
          } catch (e) { /* layer/prop not present in this style; ignore */ }
        });
      } finally {
        window.__dd2_found_applying__ = false;
      }
      return true;
    }

    // --- Map brightness ----------------------------------------------------
    // The overlay window composites over the game with STRAIGHT ALPHA — the OS
    // just blends our pixels onto the game's. mapgenie's style is a LIGHT one
    // (near-white), so fading it to 30% literally adds 30% white to every pixel:
    // it reads as glare, not as a faint map. CSS blend modes can't help, since
    // they only blend within our own window and can't see the game beneath.
    //
    // So darken the map's own pixels first. Pushed below ~0.4 the map becomes
    // darker than the game and the overlay reads as a SHADOW over it instead of a
    // wash — which is what actually looks right at low opacity.
    //
    // Applied to the canvas only, so the DOM player marker keeps its true colour.
    window.__dd2_set_map_brightness = function(v) {
      var id = '__dd2_brightness_css__';
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      // Contrast is nudged up as it darkens, or roads/labels turn to mud.
      var contrast = (1 + (1 - v) * 0.35).toFixed(2);
      el.textContent = '.mapboxgl-canvas{filter:brightness(' + v + ') contrast(' + contrast + ');}';
    };

    // Overlay only: hide mapgenie's own embed chrome so the overlay is genuinely
    // just map + marker. Deliberately conservative — .mapboxgl-popup and the POI
    // symbols must survive, since clicking a POI while holding Alt is the point.
    //
    // #mini-header is the embed's nav strip ("Full Map", "Track Progress"). It is NOT a
    // <header>/<nav> — it's a plain div with an id — so the tag selectors below never
    // touched it, and those two buttons sat over the game. They belong to the control
    // window, where the chrome is left alone and you can actually click them.
    function hideChrome() {
      if (document.getElementById('__dd2_chrome_css__')) return;
      var el = document.createElement('style');
      el.id = '__dd2_chrome_css__';
      el.textContent = '.mapboxgl-control-container,header,nav,footer,aside,#mini-header{display:none !important;}';
      document.head.appendChild(el);
    }

    // --- Zoom --------------------------------------------------------------
    // null = leave zoom alone entirely (the main window's behaviour: the user
    // owns its zoom). A number = the follow loop eases toward it every frame.
    window.__dd2_set_zoom_target = function(z) {
      window.__dd2_zoom_target__ = (typeof z === 'number' && isFinite(z)) ? z : null;
    };

    // --- Heading-up ---------------------------------------------------------
    // Overlay only: rotate the map so the way you're running is UP, instead of
    // making you translate "arrow points north-east" into "turn left a bit".
    //
    // __dd2_rotate_active__ is a separate flag, not just !!on, because it must
    // survive being switched off: the loop keeps owning the bearing until it has
    // eased back to north, then lets go. It is the ONLY thing that lets the loop
    // touch the bearing at all — the main window never calls this, so its map is
    // never rotated and, just as importantly, a bearing the USER dialed in there
    // by hand is never snapped back to north by the follow loop.
    window.__dd2_set_rotate = function(on) {
      window.__dd2_rotate__ = !!on;
      if (on) window.__dd2_rotate_active__ = true;
    };

    // 60fps loop that owns the marker, the camera and the zoom from one smoothed
    // display position (disp). When following, it centers the map on disp AND
    // draws the marker on disp, so the marker sits at the exact viewport center
    // every frame — locked-center follow, smooth tiles + marker. When not
    // following, the map holds still and the marker glides to its world position.
    //
    // NOTE: driving the Mapbox camera every frame makes Mapbox's own POI icons
    // show a mild artifact (see the fade note below; some positional wobble can
    // remain). That's inherent to per-frame camera moves on Mapbox's GPU symbols
    // and can't be fully removed without giving up locked-center; see FINDINGS.md.
    // Folding zoom into the same jumpTo adds no EXTRA churn — it's one move per
    // frame either way.
    function followFrame() {
      window.requestAnimationFrame(followFrame);
      if (window.__dd2_marker_frozen__) return; // refine: leave marker put
      var t = window.__dd2_follow_target__;
      if (!t || !window.map || typeof window.map.project !== 'function') return;

      var d = window.__dd2_disp__;
      if (!d) { d = window.__dd2_disp__ = { lng: t.lng, lat: t.lat }; }
      d.lng += (t.lng - d.lng) * 0.3;
      d.lat += (t.lat - d.lat) * 0.3;
      // Snap when essentially arrived so a still player doesn't churn forever.
      if (Math.abs(t.lng - d.lng) < 1e-9) d.lng = t.lng;
      if (Math.abs(t.lat - d.lat) < 1e-9) d.lat = t.lat;

      var driving = window.__dd2_following__ && !window.__dd2_follow_suspended__;
      // A small (non-zero) fade while driving keeps Mapbox's symbol-placement
      // throttle alive (icons recompute ~1000/80≈12x/sec, not every frame) to
      // curb the positional wobble, while staying short enough not to flicker.
      // Restore the map's normal fade for manual browsing. Tunable: 0 = no
      // wobble-throttle (flicker-free but jittery), higher = calmer but slower.
      var wantFade = driving ? 80 : (window.__dd2_fade_default__ || 300);
      if (typeof window.map._fadeDuration === 'number' && window.map._fadeDuration !== wantFade) {
        window.map._fadeDuration = wantFade;
      }

      // Skip the per-frame center lock while a zoom glide is animating, so the
      // easeTo (which drives center + zoom together) isn't overwritten each frame.
      if (driving && !window.__dd2_zoom_gliding__) {
        // Heading-up: one bearing step per frame, eased off the map's REAL bearing
        // rather than a remembered one. Nothing can drift out of sync with the
        // camera, and a bearing you dialed in by hand during an Alt-drag is simply
        // where we resume easing from instead of something to fight.
        var rotating = !!window.__dd2_rotate_active__;
        var bearing = window.map.getBearing();
        if (rotating) {
          var wantB = 0; // rotation off: unwind to north, THEN let go of the bearing
          if (window.__dd2_rotate__) {
            wantB = (typeof window.__dd2_heading__ === 'number')
              ? window.__dd2_heading__ + 90 // world heading is CW from east; bearing is CW from north
              : bearing;                    // no heading yet (never moved): hold, don't snap north
          }
          var dB = angleDiff(wantB, bearing);
          bearing = Math.abs(dB) < 0.02 ? wantB : bearing + dB * ROT_EASE;
        }

        // Center, zoom and bearing ride the SAME jumpTo: Mapbox re-runs symbol
        // placement per camera move, so a second setBearing() call would double
        // the icon churn the fade throttle above exists to contain.
        var move = { center: { lng: d.lng, lat: d.lat } };
        if (rotating) move.bearing = bearing;

        var zt = window.__dd2_zoom_target__;
        if (typeof zt === 'number') {
          // Overlay: ease zoom toward the target and move center + zoom in ONE
          // jumpTo, so run/stand zoom changes glide instead of stepping.
          if (typeof window.__dd2_disp_zoom__ !== 'number') {
            window.__dd2_disp_zoom__ = window.map.getZoom();
          }
          window.__dd2_disp_zoom__ += (zt - window.__dd2_disp_zoom__) * ZOOM_EASE;
          if (Math.abs(zt - window.__dd2_disp_zoom__) < 1e-4) window.__dd2_disp_zoom__ = zt;
          move.zoom = window.__dd2_disp_zoom__;
          window.map.jumpTo(move);
        } else {
          // Main window: center only; zoom is the user's business.
          var c = window.map.getCenter();
          if (Math.abs(c.lng - d.lng) > 1e-9 || Math.abs(c.lat - d.lat) > 1e-9) {
            window.map.jumpTo(move);
          }
        }

        // Let go of the bearing only once north has actually been written back —
        // clearing the flag on the frame we DECIDE to stop would leave the map
        // parked at the last fraction of a degree.
        if (rotating && !window.__dd2_rotate__ && bearing === 0) {
          window.__dd2_rotate_active__ = false;
        }
      }
      var el = document.getElementById('__dd2_player_marker__');
      if (el) {
        var p = window.map.project({ lng: d.lng, lat: d.lat });
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';

        // Facing (from the camera) wins; the movement vector is the fallback for when
        // the camera chain missed a tick. Note the two must not BOTH run: the movement
        // heading would drag the camera heading back toward the direction of travel,
        // and strafing/backpedalling are exactly when they disagree.
        //
        // Measured against t, the TRUE position, not d, the smoothed display one: ahead
        // was built from the true position on the same tick, so pairing it with the
        // lagging d would bend the facing by however far the follow easing is currently
        // behind — a bend that grows with speed, exactly when you would blame the camera
        // for it. The marker still DRAWS at d; only the angle comes from t.
        var ahead = window.__dd2_ahead__;
        if (!(ahead && setHeadingFromAhead(t, ahead))) updateHeading(d);
        var g = document.getElementById('__dd2_marker_rot__');
        if (g && typeof window.__dd2_heading__ === 'number') {
          // The heading is in world space, the SVG lives on screen: subtracting the
          // bearing converts one to the other. North-up leaves it exactly as it was;
          // settled heading-up lands on -90, i.e. the arrow points straight up, and
          // mid-turn it shows the part of the turn the map hasn't caught up with yet.
          var rot = window.__dd2_heading__ - window.map.getBearing();
          g.setAttribute('transform', 'rotate(' + rot.toFixed(1) + ' 22 22)');
        }
      }
    }

    function installMapHooks() {
      if (window.__dd2_map_hooked__ || !window.map || !window.map.on) return;
      window.__dd2_map_hooked__ = true;
      if (HIDE_CHROME) hideChrome();
      // Remember the map's normal icon fade so we can restore it after driving.
      if (window.__dd2_fade_default__ === undefined && typeof window.map._fadeDuration === 'number') {
        window.__dd2_fade_default__ = window.map._fadeDuration;
      }
      // When the USER drags/zooms the map (real input has originalEvent — the
      // follow loop's jumpTo does not), suspend follow so they can look around
      // while standing still. Auto-resumes the moment the player moves again.
      // Zoom driving sits inside the same "driving" gate, so while you're
      // browsing by hand we don't fight you for the zoom either.
      window.map.on('movestart', function(e) {
        if (e && e.originalEvent) window.__dd2_follow_suspended__ = true;
      });
      // Re-assert the desired base-map state whenever the style changes under us
      // (initial load finishing, a POI category toggle, new layers streaming in).
      // Re-applies in BOTH directions: only re-asserting the hidden state was the
      // other half of the F9-restore bug. Repeated identical setLayoutProperty
      // calls are no-ops in Mapbox, so this can't loop.
      window.map.on('styledata', applyBasemap);
      window.map.on('idle', applyBasemap);
      // Same reasoning for the found-POI override: mapgenie rewrites the layer's
      // paint when you toggle categories, which would restore its own 0.4 fade.
      window.map.on('styledata', applyHideFound);
      window.map.on('idle', applyHideFound);
      if (!window.__dd2_follow_loop_started__) {
        window.__dd2_follow_loop_started__ = true;
        followFrame();
      }
    }

    // Called each poll tick: just hands the loop a fresh target/flags. All actual
    // marker/camera motion happens in followFrame at 60fps.
    //
    // aheadLng/aheadLat are the look-ahead point (the player pushed along the camera's
    // view direction, through the same transform) — omitted when the camera couldn't be
    // read, in which case the loop falls back to the movement-derived heading. Passing
    // null CLEARS it rather than leaving a stale facing pinned to the arrow.
    window.__dd2_apply = function(lng, lat, follow, moved, aheadLng, aheadLat) {
      if (!window.map || typeof window.map.project !== 'function') return false;
      installMapHooks();
      ensureMarker();
      window.__dd2_follow_target__ = { lng: lng, lat: lat };
      window.__dd2_ahead__ = (typeof aheadLng === 'number' && typeof aheadLat === 'number')
        ? { lng: aheadLng, lat: aheadLat }
        : null;
      window.__dd2_following__ = !!follow;
      // Moving normally cancels a manual pan and resumes follow — but NOT while
      // the overlay is holding the mouse (Alt). Otherwise any drift over the
      // deadband yanks the map back to the player in the middle of your drag.
      if (follow && moved && !window.__dd2_interactive_lock__) {
        window.__dd2_follow_suspended__ = false;
      }
      return true;
    };
    return true;
  })();
`;
  }

  // Found-state sync between the two windows. A SEPARATE script from the marker
  // on purpose: the marker install waits on a saved calibration and a running
  // game, and the sync must work regardless of either. Injected on dom-ready by
  // both renderers; returns false until mapgenie's Redux store exists, so the
  // caller retries.
  //
  // The problem it solves: the control window and the overlay are two separate
  // mapgenie SPA instances. They share cookies, so the SERVER sees a mark at once
  // — but each page only reads the found-set from the server on load, so marking
  // in one stayed invisible to the other until a reload.
  //
  // mapgenie is Redux, and marking dispatches a plain action whose middleware does
  //   case MARK_LOCATION: mapManager.setLocationFound(locationId, found)
  // while the actual HTTP write lives in the THUNK around it, not in the action.
  // So replaying that plain action in the other window updates its store AND its
  // map, and cannot re-write to the server.
  //
  // The action type is NOT hardcoded (it's minified): a mark is detected by
  // whether the dispatch changed user.foundLocations. Redux reducers return a NEW
  // object when they change something, so an identity check is enough — no deep
  // diff, and it survives mapgenie renaming its actions.
  function buildFoundSync() {
    return `
  (function() {
    var FOUND_PREFIX = '__DD2_FOUND__';

    window.__dd2_install_found_sync = function() {
      if (window.__dd2_found_sync_installed__) return true;
      if (!window.store || typeof window.store.dispatch !== 'function') return false;
      window.__dd2_found_sync_installed__ = true;

      // Remember each XHR's URL at open() time — send() doesn't get it, and the
      // replay guard below needs to know what a request is aimed at.
      var realOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dd2_url__ = url;
        return realOpen.apply(this, arguments);
      };

      var innerDispatch = window.store.dispatch.bind(window.store);
      function foundSet() {
        try { return window.store.getState().user.foundLocations; } catch (e) { return null; }
      }

      window.store.dispatch = function(action) {
        var before = foundSet();
        var result = innerDispatch(action);
        try {
          if (action && typeof action === 'object' && action.type
              && !action.__dd2_mirrored__ && foundSet() !== before) {
            console.log(FOUND_PREFIX + JSON.stringify(action));
          }
        } catch (e) { /* never let the bridge break the app's own dispatch */ }
        return result;
      };
      return true;
    };

    // Applies a mark that happened in the OTHER window.
    window.__dd2_apply_found_action = function(action) {
      if (!action || !window.store) return false;
      action.__dd2_mirrored__ = true; // stops it bouncing straight back

      // Belt and braces: the mark is ALREADY persisted by the window it happened
      // in, so nothing here may write to the server. Even if some middleware we
      // haven't read tried to, this blocks it for the duration of the replay.
      var realFetch = window.fetch;
      var realSend = XMLHttpRequest.prototype.send;
      function isWrite(u) { return /\\/api\\/v1\\/user\\/locations/.test(String(u)); }
      window.fetch = function(u) {
        if (isWrite(u)) return Promise.resolve(new Response('{}', { status: 200 }));
        return realFetch.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        if (isWrite(this.__dd2_url__ || '')) return;
        return realSend.apply(this, arguments);
      };
      try {
        window.store.dispatch(action);
      } finally {
        window.fetch = realFetch;
        XMLHttpRequest.prototype.send = realSend;
      }
      return true;
    };

    return window.__dd2_install_found_sync();
  })();
`;
  }

  // --- Area / portal extraction ---------------------------------------------
  //
  // mapgenie draws each dungeon as an INSET: a separate, zoomed panel placed off
  // to the side of the playable world, but inside the SAME raster and therefore
  // the same lng/lat plane. DD2's caves are seamless world geometry, so the game
  // keeps reporting ordinary world coordinates inside one — which is why the
  // marker stays out at the cave mouth while the cave's POIs sit far away in the
  // inset. Fixing that needs a per-dungeon transform, and to build one we need to
  // know (a) which insets exist and (b) where their entrances are.
  //
  // mapgenie hands us both, and exactly, if you know where to look:
  //
  // 1. `subregions-data` (map style) — the 74 named dungeon polygons.
  // 2. `store.getState().map.locationsById` — every location as a full object
  //    with lat/lng/region_id/description. NOT the geojson source: that carries
  //    only a trimmed property set with no description, and the description is
  //    the whole point, because every portal names its destination BY LOCATION ID
  //    in it:
  //
  //      **Transitions to:** [Waterfall Cave 1F](https://mapgenie.io/...?locationIds=328583)
  //
  //    Parsing `locationIds=(\d+)` out of those yields a complete portal graph:
  //    ~131 overworld->dungeon entrances covering all 72 reachable insets, ~123
  //    exits back out, ~204 floor-to-floor links. Every destination resolves.
  //
  // Matching entrances to insets by TITLE would also nearly work (98 of 105 match
  // exactly) — but only nearly: the rest are spelling variants ("Rainshelter Cave"
  // vs "Rain Shelter Cave"). The id in the description is exact, so we use that
  // and never guess.
  //
  // Returns a JSON string (or null until the store and style are both up — the
  // caller retries). One-shot: computes and returns, installing nothing.
  function buildExtractAreas() {
    return `
  (function() {
    if (!window.map || typeof window.map.getStyle !== 'function') return null;
    if (!window.store || typeof window.store.getState !== 'function') return null;

    var state = window.store.getState();
    var byId = state && state.map && state.map.locationsById;
    if (!byId) return null;

    var style;
    try { style = window.map.getStyle(); } catch (e) { return null; }
    var sources = style && style.sources;
    if (!sources) return null;

    // Region/subregion titles live on the POINT features of these sources; the
    // POLYGON features carry only an id. Walk both.
    function readAreas(sourceId) {
      var src = sources[sourceId];
      var feats = src && src.data && src.data.features;
      if (!feats) return null;
      var out = {};
      feats.forEach(function(f) {
        var id = f.properties && f.properties.id;
        if (id == null) return;
        var rec = out[id] || (out[id] = { id: id, title: null, bbox: null });
        if (f.properties.title) rec.title = f.properties.title;
        if (f.geometry && f.geometry.type !== 'Point') {
          var b = [Infinity, Infinity, -Infinity, -Infinity];
          (function walk(c) {
            if (typeof c[0] === 'number') {
              b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
              b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
            } else { c.forEach(walk); }
          })(f.geometry.coordinates);
          rec.bbox = b;
        }
      });
      return out;
    }

    var regions = readAreas('regions-data');
    var subregions = readAreas('subregions-data');
    if (!regions || !subregions) return null; // style still streaming; retry

    // The overworld is whatever is a REGION rather than a SUBREGION — Vermund,
    // Battahl, Agamen Volcanic Island. Derived, never hardcoded: mapgenie is free
    // to renumber these and this still holds.
    var overworld = {};
    Object.keys(regions).forEach(function(id) { overworld[id] = true; });

    // Subregion title -> id, but ONLY where the title is unambiguous. Used purely
    // as a fallback below; two subregions share the name "Sealed Mining Shaft", and
    // a lookup that guessed between them would be worse than not resolving at all.
    var subByTitle = {};
    Object.keys(subregions).forEach(function(id) {
      var t = subregions[id].title;
      if (!t) return;
      subByTitle[t] = (t in subByTitle) ? null : Number(id); // null = ambiguous
    });

    // Which area does a location belong to? Normally just its region_id. But four
    // portal destinations in mapgenie's data have region_id === null — including the
    // ONLY edge into Darkhorde Cave, so honouring the gap costs a whole dungeon.
    // Each of those four is titled exactly like its subregion, so fall back to an
    // EXACT, UNAMBIGUOUS title match. Anything less certain resolves to null and the
    // edge is dropped: a mis-assigned portal would silently teleport the marker into
    // the wrong cave, which is far worse than an uncalibrated one.
    function areaOf(loc) {
      var r = loc.region_id;
      if (r != null && (subregions[r] || regions[r])) return r;
      if (r == null && loc.title && subByTitle[loc.title]) return subByTitle[loc.title];
      return null;
    }

    // --- Named places (for buildings) ---------------------------------------
    //
    // The game's "inside" flag fires for every house, shop and inn, and NONE of them is
    // a dungeon with an inset — so there is nothing to place the player on and nothing
    // for the portal graph to match. What mapgenie does have is the building itself, as
    // an ordinary POI on the world map ("Kough's Inn", category Inn). That's enough to
    // NAME where you are, which is the whole of what's missing.
    //
    // Which POIs count as a place? mapgenie groups its categories, and two of the groups
    // are exactly the question: "Locations" (Settlement, Waypoint, Campsite, Dungeon,
    // Area, Portcrystal) and "Facilities" (Inn, Tavern, Armory, Apothecary, ...). Matched
    // on the group TITLE, not its id — the ids are this map's (1770/1777) and would
    // silently select the wrong groups on any other game.
    //
    // "Transition" is dropped: those ARE the doorways, they're already the portal graph,
    // and their titles name the destination floor ("Waterfall Cave 1F") rather than a
    // place you could be standing in.
    //
    // Overworld only. Their game coords come from inverting the WORLD affine, which is
    // meaningless for a POI drawn inside a dungeon inset.
    var PLACE_GROUPS = { 'Locations': 1, 'Facilities': 1 };
    var groups = state.map.groups || [];
    var cats = state.map.categories || [];
    if (!Array.isArray(groups)) groups = Object.keys(groups).map(function(k) { return groups[k]; });
    if (!Array.isArray(cats)) cats = Object.keys(cats).map(function(k) { return cats[k]; });

    var groupTitle = {};
    groups.forEach(function(g) { groupTitle[g.id] = g.title; });
    var placeCat = {};
    cats.forEach(function(c) {
      if (PLACE_GROUPS[groupTitle[c.group_id]] && c.title !== 'Transition') placeCat[c.id] = c.title;
    });

    var pois = [];
    Object.keys(byId).forEach(function(id) {
      var loc = byId[id];
      var cat = loc && placeCat[loc.category_id];
      if (!cat || !loc.title) return;
      if (!overworld[loc.region_id]) return;
      pois.push({
        id: loc.id,
        title: loc.title,
        category: cat,
        lng: loc.longitude,
        lat: loc.latitude,
      });
    });

    // Portal edges, from the descriptions. A location can name more than one
    // destination, so collect them all.
    var portals = [];
    Object.keys(byId).forEach(function(id) {
      var loc = byId[id];
      if (!loc || !loc.description) return;
      var re = /locationIds=(\\d+)/g;
      var m;
      while ((m = re.exec(loc.description))) {
        var dest = byId[m[1]];
        if (!dest) continue; // destination not on this map; skip rather than guess
        var fromArea = areaOf(loc);
        var toArea = areaOf(dest);
        if (fromArea == null || toArea == null) continue; // unplaceable; see areaOf
        portals.push({
          fromId: loc.id,
          fromRegion: fromArea,
          fromTitle: loc.title,
          fromLng: loc.longitude,
          fromLat: loc.latitude,
          toId: dest.id,
          toRegion: toArea,
          toTitle: dest.title,
          toLng: dest.longitude,
          toLat: dest.latitude,
        });
      }
    });

    return JSON.stringify({
      overworldRegionIds: Object.keys(overworld).map(Number),
      regions: regions,
      subregions: subregions,
      portals: portals,
      pois: pois,                        // named places: buildings, inns, settlements
      locationCount: Object.keys(byId).length,
    });
  })();
`;
  }

  window.DD2MapAgent = { buildInstallMarker, buildFoundSync, buildExtractAreas };
})();
