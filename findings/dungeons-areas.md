# Dungeons, insets & area tracking

Why dungeons need their own transform, mapgenie's portal graph, and how the app decides which area and floor you are in.

See also: [dungeon art & alignment](dungeon-art-and-alignment.md), [the paused inset re-resolve](inset-resolve-wip.md).

## Dungeons: the inset problem, and mapgenie's portal graph

mapgenie draws every dungeon as an **inset** — a separate, zoomed panel parked off to
the side of the playable world, but inside the *same* raster and therefore the same
lng/lat plane. DD2's caves are seamless world geometry, so the game just keeps
reporting ordinary world coordinates when you walk into one. With a single global
affine that means the marker stays out at the cave mouth while the cave's POIs sit far
away in the inset: **1,227 of the map's 5,354 POIs (23%) are in the 72 dungeon insets
and were unreachable.**

Fixed by making the transform **piecewise**: an affine per area (overworld + one per
dungeon floor), selected each tick from the live position (`src/main/areaTracker.js`).
Everything downstream is untouched — swapping the affine flies the camera to the inset
where the POIs already are.

### mapgenie states the whole dungeon graph outright (the thing that made this cheap)

Read live from the guest, never hardcoded (`mapAgent.js` `__dd2_extract_areas`):

- `sources['subregions-data']` — **74 named dungeon polygons** (`{id, title}` + bbox).
  Three *regions* (2438 Battahl, 2439 Vermund, 2440 Agamen) are the overworld; the
  overworld set is derived as "is a region, not a subregion", never a hardcoded id list.
- **`store.getState().map.locationsById`** — all 5,372 locations as FULL objects. This
  is the load-bearing part: the geojson source (`locations-data`) carries only a
  trimmed property set with **no `description`**, and the description is the whole
  story. Every portal names its destination **by location id**:

  ```
  **Transitions to:** [Waterfall Cave 1F](https://mapgenie.io/…?locationIds=328583)
  ```

  Parsing `locationIds=(\d+)` out of those yields **913 edges, every destination
  resolving**: 131 overworld→dungeon entrances covering **72 of the 74** insets, 123
  exits, 204 floor-to-floor links.

Matching entrances to insets **by title** also nearly works (98 of 105 exact) — and
that "nearly" is a trap. Four destinations have `region_id: null`, one of which is the
**only** edge into Darkhorde Cave, so the id alone loses a whole dungeon. Those four
fall back to an *exact, unambiguous* subregion-title match (two subregions are both
called "Sealed Mining Shaft", so uniqueness is checked); anything less certain drops
the edge. A mis-assigned portal would silently teleport the marker into the wrong
cave, which is worse than an uncalibrated one.

Not auto-reachable: **Vernworth - Southern Ruins** and **Sealed Mining Shaft** — no
entrance edge exists in mapgenie's data at all. They need manual calibration.

### mapgenie's category taxonomy (verified live — this is what any FILTER would be built on)

Every POI carries `category_id`, every category belongs to a **group**, and the groups are
exactly the headings the site's own filter sidebar renders. Read from the guest's Redux
store (identical on `?embed=light` and the full map, so the embed we load has all of it):

| path | what |
|---|---|
| `store.getState().map.groups` | `{ id, title }` — the 8 groups below |
| `store.getState().map.categories` | `{ id, group_id, title, icon, order, locations_count, premium, … }` |
| `store.getState().map.locationsById[id].category_id` | which category a POI is in |
| `store.getState().map.locationsByCategory` | the reverse index, already built |
| `store.getState().map.categoryIds` | the ids in display order |

The 8 groups, with their categories and POI counts (DD2, 2026-07):

| group | categories (count) |
|---|---|
| **Locations** | Area (19), Portcrystal (11), Waypoint (111), Campsite (84), Dungeon (106), **Transition (260)**, Settlement (10) |
| **Facilities** | Riftstone (11), Ox Station (6), Apothecary (10), Peddler (7), **Inn (12)**, Barberie (2), Tavern (4), Forgotten Riftstone (90), Armory (9), Vocation Guild (3), Bordelrie (1), Oracle (2), Mortuary (2) |
| **Key Items** | Seeker's Token (240), Implement (25), Golden Beetle (82), Key (4), Wakestone Shard (80), Ferrystone (47), Key Item (2) |
| **Equipment** | Weapon (149), Armor (151), Cloak (28), Ring (48), Ammunition (35) |
| **Items** | Grimoire (84), Valuable (270), Material (90), Curative (1253), Chest (435), Loot Pile (597) |
| **Quests** | Main Quest (26), Side Quest (48) |
| **Enemies** | Enemy (704), Boss (124) |
| **Other** | Miscellaneous (21), NPC (46) |

Match on the group **title**, never the id (`Locations` is 1770, `Facilities` 1777 — those
are *this map's* numbers and mean nothing on another game).

`Transition` is the odd one: those POIs **are the doorways** — the same objects the portal
graph is parsed out of — and their titles name a destination floor ("Waterfall Cave 1F"),
not a place you can stand in. Exclude it from anything that means "where am I".

For a future filter UI this is everything needed: 5,372 POIs, 8 groups, 39 categories, with
counts, icons and display order already supplied. Note POIs all live on **one** Mapbox
layer (`locations`), and *found* state is a **feature-state paint expression**, not a layer
or a filterable property (see "Found POIs are a paint expression"), so a
category filter has to work on the category property, not by hiding layers.

### Named places: most interiors are BUILDINGS, and buildings are POIs, not insets

The inside-flag fires for every house, shop and inn — and mapgenie draws an inset for none
of them, so there is no panel to place the marker on and no entrance in the portal graph to
match. This is *why* the unbounded nearest-entrance rule went wrong (above): it was being
asked which dungeon a tavern was.

But nothing needs placing. **Indoors, DD2 still reports true world coordinates**, so inside
a house you are already drawn in the right house. The only thing missing is the **name** —
and mapgenie has it, as an ordinary POI in the `Locations`/`Facilities` groups ("Kough's
Inn", category Inn; 475 of them on the overworld).

Nothing in memory links the interior you're standing in to that POI, and no geometry can
supply it (the flag says *inside*, not *inside what*). So it is **taught, once, per
building**: `Home` binds the nearest place POI to the spot you're standing on, main saves it
to `areas.json` under `places`, and from then on that doorway is recognised — the HUD names
the building and no dungeon is ever guessed there again.

**`Home` is unbound by default now** (`hotkeys.rememberPlace: null`, `overlayConfig.js`) —
the LocalArea pointer names buildings on its own, so the manual bind is no longer needed.
`bind()` skips a null accelerator and `describeHint` gates the offer on
`keys.rememberPlace &&`, so on stock config the action line never appears and the mechanic
below is dormant, not gone. Set `hotkeys.rememberPlace` in `config/overlay.json` to get it
back. The machinery is kept because the pointer has no id for every interior.

Two details that matter:

- It binds **your position**, not the POI's. mapgenie draws a building's icon wherever it
  looks right on the world map — a roof, a courtyard — which can be tens of units from the
  door you actually walk through. The **door** is where the flag flips, so the door is what
  has to be recognised. The POI-to-door offset is stored alongside (`dist`), and it is
  small in practice: measured **2u** standing in Kough's Inn.
- `Home` **refuses** past `placeRadius` (40u). A "nearest" inn 300u away is not the room
  you're in, and binding it would be the 219u dungeon bug wearing a friendlier name.

### Height is NOT usable to detect "inside" (measured in-game — this killed the first design)

The obvious detector — a z-band per dungeon — does not work, and it's worth writing
down so nobody rebuilds it:

- Entering a cave produces **no step change in height**. The coordinate runs
  continuously straight through the doorway.
- Inside is **not reliably lower**. A tower's interior climbs *above* its own entrance.

So there is no height band separating inside from outside, and any z-gate misfires on
towers. Height is still read and broadcast, but nothing keys off it.

### What we detect on: the game's flag for WHETHER, the nearest entrance for WHICH

Two questions, and they get different answers.

**1. Am I inside? The game tells us.** Found by CE value-scanning (2026-07-13); a
module-static int, **no pointer chain** (same kind of read as the local-position mirror,
so restart-stable by construction):

```
DD2.exe+FA62CAC   insideFlag   0 = overworld,  1 and 2 = inside a dungeon
```

Both non-zero values mean inside (user-observed) — 2 is some *second kind* of interior,
and what distinguishes it from 1 isn't known yet. Since both mean inside, nothing in the
app needs to care; `tools/zoneLog.js` is collecting the data to find out what it is.

**It lags the in-game map**, and this cost us a wrong conclusion worth recording. Walking
out of a cave, the game's own map had already switched back to the overworld while the
flag still read `1` — sampled there, it looks like a dead value that never updates, and
we briefly concluded it was a stale copy (which this project has a real precedent for —
see the teleport lesson under `globalPosition`). It isn't. It settles once you are
properly outside. **Don't judge it mid-transition.**

The struct around it, read live: `+4` (`zoneIndex`) is **`-1`, not `0`**, in the
overworld — a sentinel. `-24` is a **room hash** (see below). `+12` is a float, 0.0
outside and wandering 0.46–0.75 inside; unknown, probably a blend/fog factor.

This **replaced a doorway-proximity guess**: invert the world affine to place each
entrance in game coordinates, and treat coming within `enterRadius` of one as having
crossed it, with a containment backstop (do I still map inside the inset panel?) for
exits that missed the radius. It worked, but it inherited the world affine's fit error,
needed a radius *plus* a re-arm band *plus* a dwell to stop it strobing when you idled in
a doorway (three tries to get right — see the git log), and structurally could never see
the two dungeons with no portal entrance in mapgenie's data. All of that is now deleted:
`enterRadius`, `rearmMargin`, `rearmDwellTicks`, `outsideDwellTicks` and the containment
check are gone.

**2. Which dungeon? The nearest known entrance.** There is a second static int beside the
flag:

```
DD2.exe+FA62CB0   zoneIndex    the GAME's own dungeon id
```

It is tempting to read this as "the dungeon", and it very nearly is — but it is the
**game's** numbering, and mapgenie's is different: mapgenie's subregion ids run
**2441–2514**, while an observed `zoneIndex` was **18**. They do not coincide, so
`zoneIndex` cannot name a dungeon until a **mapping table is built**, dungeon by dungeon.

Until then: the flag says *when* to jump into an inset, and the **nearest known entrance**
(from mapgenie's portal graph) says *which* one — **provided it is actually near** (see
the next section, which is where this bit an entire dungeon).

### The flag means "inside", not "inside a DUNGEON" — cap the entry distance

The nearest-entrance rule looked forgiving: the right entrance only has to be nearer than
the next-nearest, so the affine's fit error would have to be enormous to pick the wrong
cave. **That reasoning has a hole, and it is not about the affine at all.** It assumes the
right answer is *in the list*. It often isn't:

`insideFlag` is set by **every interior in the game** — houses, shops, the Vernworth
barracks — and mapgenie has an entrance POI for **none of them**. Walk into a house and
the app is asked "which dungeon is this?", a question with no true answer; unbounded, it
returns whichever dungeon is least far away, at any distance whatsoever. Observed:

```
[areas] auto-calibrated "Ancestral Chamber"  from the crossing (219.4u from the nearest known doorway)
[areas] Ancestral Chamber sits at height 125.4 (measured 125.4)
```

That is not a near miss. It **wrote a transform anchored on 219u of error into
`areas.json`**, and a floor height of 125.4 (the player was up a tower somewhere), so a
dungeon the player had never entered was permanently mis-placed — and the floor height,
which *averages* across visits, would have stayed poisoned even after a real visit.

The fix is a radius (`dungeonEnterRadius`, default **20u**, in `config/overlay.json`): a
crossing anchor is only worth anything if you are standing *in* the doorway, so beyond it
we decline to answer. The marker then stays on the **overworld** — which is right, because
DD2 reports ordinary world coordinates indoors, so a building draws you at the building —
and the overlay's area readout offers the nearest dungeon with `Insert` to accept it. That
override deliberately **skips the radius**: at that point the guess isn't ours, it's one
you looked at and confirmed, and it is also the only way into the two orphan dungeons.

Rule of thumb for anything downstream: **a hint the player can't see is a guess the player
can't correct.** The 219u line was in the console the whole time and no one was reading it
mid-fight; that's why the same information now sits on the overlay.

The saved area now records the anchor's `dist`, so a placement that looks off can be
diagnosed instead of re-guessed.

Note the id must be keyed on `(insideFlag, zoneIndex)`, **not zoneIndex alone**: the flag
appears to select an id *namespace*. Measured so far —

| flag | zone | dungeon | mapgenie subregion | matched at |
|---|---|---|---|---|
| 1 | 18 | Forgotten Tunnel | 2447 | 28u |
| 2 | 2010 | Stormwind Cave | 2460 | 13u |
| 1 | 69 | Stragglers' Cave | 2443 | 7u |

flag-1 ids are small (18, 69); the one flag-2 id is four digits (2010). "Nearest entrance"
picked correctly all three times.

**`tools/zoneLog.js` exists to finish this.** Run it while playing; on every change of
zone state it appends a line pairing `(insideFlag, zoneIndex)` with the nearest mapgenie
entrance's name and how far away it was. Only the CLOSE lines are usable — a line logged
deep inside a dungeon pairs a zone number with whatever entrance happened to be nearest,
which may be a different cave entirely. Visit enough dungeons and the mapping falls out.

The free-anchor calibration trick (below) is unaffected: entry still hands over the
player's world position paired with the matched entrance's inset position.

### 3. Which floor? — the height mechanic, RETIRED (kept as the record of why)

> **RETIRED (2026-07-19). Floor now comes from the LocalArea pointer, not height.** The
> premise below — "only height can separate floors" — held only until the LocalArea pointer
> (`localAreaReader.js`) existed. That pointer returns an id **unique per (area, floor)** and
> immune to falls/lifts/teleports; a walk through The Gracious Hand's Vaults confirmed it
> (1F = `628`, B1F = `627`, distinct). So height is redundant — and it was also *wrong*: the
> mechanic was fed **local** height, which rebases to 0 at every streaming-cell boundary, so
> the same walk read 1F at local `-125.5` but B1F at local `-9.9` (inverted), while global
> height read them correctly (102.5 vs 90.1). A floor thus reads "~100u off itself" whenever a
> dungeon spans cells — the source of the false "floor may be wrong" nag. The whole height-floor
> path (`floorByHeight`/`learnHeight`, `areas.floorHeights`, the `floor-off`/`floor-unknown`
> hints, `PageUp`/`PageDown`) was deleted; the tracker now just holds the floor it entered on
> as the pointer's null-tick fallback. Also tried and reverted the same day: forcing overworld
> when `localArea === -1` — it regressed city detection, because `-1` also appears at unmapped
> spots *inside* a city's footprint (under Vernworth) and during dungeon-entry transitions. The
> section below is kept as the historical record of why height was used at all.

**Only height can carry this, as a matter of fact rather than preference: the game reports
the SAME (x, y) on every floor of a dungeon.** Two floors differ in z and in nothing else.
So no x/y signal — not a room id, not the portal graph, not the panel geometry — can ever
separate them, however clever. This is worth being blunt about because two plausible ideas
were built and both failed on exactly this.

**The room hash is not a floor id (dead end, cost a day).** The third int in the struct:

```
DD2.exe+FA62C94   roomHash   -1 in the overworld; inside, an id for a streaming cell
```

It looked perfect: deterministic (walking Forgotten Tunnel one way and back gave the
identical five hashes in reverse order), so it was used as a *learned key* — press
`PageUp`, record the room you're in against that floor. It does not work, and cannot:

- **The same hash appears on two floors.** In The Gracious Hand's Vaults, `1bc90b46` and
  `ae32b49d` both occur at h=-13.7 *and* h=-5.2. It's a cell that spans floors vertically.
- Two of them **flicker back and forth three times a second** while you stand still on a
  boundary.
- Recording it taught the table contradictions, which then *fought the player*: walk into
  the stairwell, get flipped to the wrong floor, correct it, get flipped the other way
  next time. Every room ends up marked ambiguous and the mechanism is dead weight.

Read it, log it (`tools/zoneLog.js`), but never key a floor on it.

**What works: learn where each floor SITS, per dungeon.** Stand on a floor, press
`PageUp`/`PageDown` to name it; once your height settles, that height is recorded in
`areas.floorHeights`. From then on your height picks the nearest floor by itself.

- **Absolute height, never height CHANGE.** Measured floor gaps run **5.8u** (The Gracious
  Hand's Vaults) to **16.6u** (Forgotten Tunnel), while the height wanders up to **4u
  within a single floor**. A change threshold would need to sit below 5.8 and above 4 — a
  1.8u window — and be wrong in the next dungeon regardless. A 12u threshold picked from
  Forgotten Tunnel is precisely what silently broke the previous attempt: it never fired in
  the Vaults, so the app never noticed the player had changed floor and confidently wrote
  every floor's rooms down as 1F.
- **The height is taken once it SETTLES** (~1s flat, ≤1.5u spread), not when you press the
  key — you press it *on the stairs*, and the stairs are between floors, which is the one
  height that belongs to neither. Verified in simulation replaying the real log: pressing
  PageDown mid-staircase still records B1F correctly.
- Averaged over visits, so a second pass sharpens a floor rather than replacing it.
- A rival floor must beat the current one by `SWITCH_MARGIN` (1.5u), so walking a ramp
  can't flicker the map between two panels. An untaught floor is never guessed at.

Simulated against the real Vaults data: teach three floors (one keypress each), then walk
the same route again and all three follow with **zero input**.

**Floors must be ordered by ELEVATION, not alphabetically.** `B` = basement, so B1F sits
*under* 1F, and a string sort gives `['1F', 'B1F']` — which made `PageUp` from B1F walk off
the end of the list and silently do nothing. `floorRank()` exists for this (`B1F → -1`,
`1F → +1`). Also: mapgenie has portals whose titles carry **no floor label at all** (three
into the Vaults), and `''` ranks between B1F and 1F — a phantom floor with no panel behind
it, which `PageDown` would step onto. `''` is only a real floor when it is the only one.

**Floors reached only by stairs have no entrance**, so no free anchor from a doorway
crossing ever lands on them — they'd stay uncalibrated forever, the marker would simply
vanish up there, and Refine couldn't rescue it (it *shifts* an existing transform; there'd
be nothing to shift). A floor change now offers the **stair crossing** as that floor's
anchor, using mapgenie's 203 internal portal edges: the floor you came *from* is
calibrated, so inverting it places its stairs in game coords and the nearest is the one you
took. Confirmed live.

### Retired: dungeons used to calibrate themselves from doorway crossings

Every inset shares one 2x2 linear part and differs only by translation:

```
lng = A*gx + B*gy + c        A,B,D,E = insetLinear: solved ONCE
lat = D*gx + E*gy + f        c,f     = per-area: ONE correspondence each
```

One correspondence therefore places a whole dungeon — and walking through a doorway used
to hand that correspondence over for nothing: we know the player's world position *and*
(from the portal graph) exactly where that doorway comes out on the inset. So a dungeon
calibrated itself the first time you walked in, and main wrote the result straight to
`config/areas.json`.

**That runtime write-back is gone (`3c01215`).** Dungeon transforms are authored in
`config/dungeons.json` now and the app only ever reads them. The reason to keep it gone is
not that the free anchors were bad — it is that a silent per-launch write is invisible when
it is wrong. Main re-merged its learned table over the authored one on every start, so a
hand-tuned rescale looked applied, played correctly for one session, then quietly reverted
with nothing in the log to say so. Anything that re-introduces a runtime writer for dungeon
transforms brings that failure mode back.

What survives from this era: `insetLinear` itself, seeded once by running the ordinary
3-point flow inside a single dungeon, which is why every dungeon after the first cost zero
clicks. `config/calibration.json` (the world affine, and Refine) is still written **only by
the renderer** — one file with two writers would let a world Refine clobber dungeon work.
`config/mapgenie-areas.json` remains a derived cache of the extracted graph (gitignored;
re-extracted on every launch).

### Not done yet (dungeons)

**1. The game↔mapgenie dungeon-id mapping (`tools/zoneLog.js` is collecting it).**
`DD2.exe+FA62CB0` holds the game's own dungeon id, but it is not mapgenie's numbering
(game: 18 observed; mapgenie subregions: 2441–2514). Building the table would let the
game name the dungeon outright instead of us picking the nearest entrance — which would
drop the last dependence on the world affine and reach the two orphan dungeons below.

Run `node tools/zoneLog.js` while playing (it needs DD2 running and
`config/mapgenie-areas.json` present; the app writes that on launch). Every change of
zone state appends a line to `zone_log.txt` pairing `(insideFlag, zoneIndex)` with the
nearest entrance's name and its distance. **Only the CLOSE samples are trustworthy** —
a line logged deep inside a dungeon (large distance) is pairing a zone number with
whatever entrance happened to be nearest, which may be a different cave entirely.

The same log settles **what flag value 2 means**: both 1 and 2 are "inside", but the
distinction is unknown. If 2 is (say) towns rather than caves, the log will show it.

**2. Two dungeons have no entrance in mapgenie's data at all** — *Vernworth - Southern
Ruins* and *Sealed Mining Shaft*. The flag detects that you're inside *something*, but
"nearest entrance" has nothing right to pick, so they used to need `Insert` plus a manual
3-point calibration. **Mostly closed since:** both now carry trusted `LocalArea` ids, so the
pointer names them on entry and `Insert` is a legacy fallback. The id mapping above would
close it properly.

**3. The inset scale — SETTLED at exactly 2.0 (`355455f`).**
It used to be *derived* from doorway anchors at 1.92 ±5%, and the derivation could not do
better: the noise floor was the ~20-unit door-vs-arrival offset, and the estimators
disagreed systematically (least-squares 1.86 — a projection, so rotation noise drags it
down; median-of-ratios 1.92–1.97 — magnitudes, which noise inflates). Measuring it off the
art instead settled it: `insetLinear` is exactly **twice** the world affine's linear part.
`.map/resolveInsets.py` recomputes it that way rather than trusting the stored value.

### Crowdsourcing the database (design note — NOT built)

The idea: hand the app to several players, have them each explore, and pool what they
learn. Everything that costs playtime is in **one file**, and most of it pools cleanly —
but not all of it, and the part that doesn't is the part that would silently corrupt the
pool, so this is written down before anyone tries.

**The file to collect is `areas.json`.** In a packaged build it is NOT next to the .exe:

```
%APPDATA%\dd2-map\config\areas.json      (packaged — userData; the folder is package.json `name`, "dd2-map", not productName)
config/areas.json                        (dev)
```

Nothing else is worth collecting. `overlay.json` is personal taste, `mapgenie-areas.json`
is a re-derivable cache (gitignored), and `calibration.json` is the one file that should
travel **outward** — see below.

| key | what it is | pools? |
|---|---|---|
| `places` | buildings: mapgenie `poiId` + the game coords of the door you walked through | **perfectly** — both halves are absolute |
| `floorHeights` | the height a floor sits at, `{ h, n }` | **perfectly** — absolute game height. `n` is a visit count, so a merge can weight-average instead of last-write-wins |
| `areas` | the per-dungeon transforms | **only via `points`** — see below |
| `insetLinear` | the shared inset scale/rotation | **never take someone else's** — it's derived from *their* world affine |

**The trap.** A dungeon's `c`/`f` are solved against that player's `insetLinear`, which is
derived from *their* `calibration.json`. Two players who calibrated the world separately
have slightly different affines, so their `c`/`f` are expressed in slightly different
frames, and merging them by copying the numbers slides each imported dungeon by the
difference. It would look like it worked, and be a few units wrong everywhere.

**The way through** is already in the file: each area carries `points` — the raw
correspondence `game (x, y) ↔ mapgenie (lng, lat)` that produced it. Both halves are
**absolute**: the game coords come out of DD2's memory, the lng/lat out of mapgenie's
portal graph. Neither passed through anybody's calibration. So a merge must re-solve
`c`/`f` from `points` using the *local* `insetLinear` (`areaStore.solveTranslation` does
exactly this), never copy `c`/`f` across.

**Or sidestep it entirely:** `configStore` seeds a packaged build's userData from the copy
of `config/` inside the asar on first run. So ship the .exe with a good `calibration.json`
and ask contributors not to re-calibrate — then everyone derives the *same* `insetLinear`,
and even `c`/`f` agree. That is the cheap version, and it makes the pool trivially mergeable.

Sketch of `tools/mergeAreas.js`, if we build it:

- `places` — union by `poiId`. Conflict worth reporting rather than resolving: two players
  binding the *same* doorway to *different* POIs means one of them mis-pressed `Home`.
- `floorHeights` — weighted mean by `n` (the counter is already there for this).
- `areas` — re-solve from `points`; hand-calibrated (`auto: false`) beats auto, and prefer
  the point with the **smallest `dist`** (that field is the anchor's error — a 2u crossing
  is a better anchor than a 19u one).
- `insetLinear` — keep ours; ignore theirs.

Worth knowing before shipping the app around: `Insert` (and `Home`, if reassigned from its
default-null) is registered as a **global** shortcut, so it is swallowed system-wide while
the app runs. (`PageUp`/`PageDown` used to be too, for floor-learning — removed 2026-07-19.)

