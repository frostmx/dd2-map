# Managed singletons & the in-game clock

Walking the CLR-style managed singleton table with plain ReadProcessMemory, and the first thing it bought us.

See also: [memory & RE](memory-re.md), [the AR layer](almanac-and-ar.md).

## Managed singletons via pure RPM — WORKS (`tools/singletonHunt.js`, 2026-07-17)

REFramework's singleton resolution (shared/sdk/REContext.cpp, MIT) is pointer reads all
the way down, so it ports to out-of-process ReadProcessMemory. The tool does the whole
chain and it is **verified live against DD2** (TDB version 73):

1. Pattern-scan DD2.exe for `48 8B 0D ?? ?? ?? ?? BA FF FF FF FF E8` (`mov rcx,
   [rip+disp]` loading the `via.clr.VM` global). Found: **`DD2.exe+0xf8cbce0`** —
   module-static, same class as the position block. The pattern scan re-finds it after
   a patch; the RVA is stable within a build.
2. VM+`0x3618` → TDB (magic `"TDB\0"`, version 73 at +4). 174,675 types.
3. VM+`0x35d0` → static tables (`{elements, size}`; size == numTypes — good check).
4. TDB tdb73 layout: `types[]`@+0x60 (0x48/entry, RETypeDefVersion71: index:19 |
   parent:19 | … , `managed_vt` @+0x40), `typesImpl[]`@+0x68 (0x30/entry, name/ns
   string offsets @0/@4, static_field_size @0xC), `stringPool`@+0xD0. Bulk-read all
   three and find any type by full name.
5. **The instance is NOT in the type's own statics.** It sits on the generic ancestor
   `AppSingleton`1<T>`'s statics (walk `parent_typeid`), slot +0x8 — validated by the
   slot target's first qword equalling the *derived* type's `managed_vt`.

`node tools/singletonHunt.js [--save] [TypeName ...]` (DD2 running) prints the chain and
instance addresses; `--save` writes `config/singletons.json` (RVA + type indices + the
per-session instance pointers). Resolved and vt-verified: `app.GenerateManager`,
`app.TimeManager`, `app.GimmickManager`.

**First live read:** `app.TimeManager` instance +0x10 is a double that advanced 3.0167
in 3.0 real seconds — the elapsed-seconds accumulator (~370,165 at time of reading;
semantics — day-relative vs total, timeScale interaction — still to pin down). This was
superseded by the real clock fields once found — see "In-game clock" below.

**`--deref <TypeName> <fieldName>` (2026-07-17):** resolves a field's offset the same
way `--fields` does, dereferences its live pointer, and dumps THAT object's own field
table — for reaching into a non-singleton nested object (a collection, a component) one
named hop at a time instead of hand-computing offsets. First use:
`--deref app.GenerateManager _NeverGenetateID` (see "Collected-token filtering" below).

Per-session instance pointers move between launches; the durable recipe is
RVA → VM → staticTbl → `elements[holderTypeIndex]` → slot +0x8, re-resolved at attach,
which the runtime reader should do each boot (cheap: four reads once the RVA is known).

## In-game clock — SHIPPED (`src/main/timeReader.js`, 2026-07-17)

Time of day lives in the RE Engine managed singleton **`app.TimeManager`**, reached via
the singleton-RPM chain above. Community accessor names (from the [Clock mod
source](https://github.com/xyzkljl1/MyDD2Mod)) pointed at the right object;
`tools/singletonHunt.js --fields app.TimeManager` then dumped the real tdb73 field table
with **live values**, which is how the actual layout below was found — no REFramework,
no il2cpp dump.

**Layout**, instance → `_TimeData` (a nested `app.TimeManager.TimeData`-shaped object,
field offset `+0x20` on the instance):

| field | offset | meaning |
|---|---|---|
| `_TimeData` pointer | instance `+0x20` | (`_TimeDataLook` at `+0x28` mirrors it, both observed identical) |
| day | `TimeData +0x2c` (i32) | in-game day counter |
| day-seconds | `TimeData +0x40` (f32) | seconds into the current day, **wraps at 2880** |

Clock constants are the game's own statics on `TimeManager` (read live, not guessed):
`InGameDaySeconds = 2880`, `InGameHourSeconds = 120`, `InGameMinuteSeconds = 2` — so a
day is 2880 *real* seconds (48 minutes), and `hh = daySec/120`, `mm = (daySec%120)/2`.

**The clock freezes** while the game pauses world time (menus, tutorial popups — a
frozen read is the game behaving, not a stale chain; verified by watching `WholePlayTime`
at instance `+0x10` keep advancing 1:1 with real time throughout).

`src/main/timeReader.js` re-resolves the 4-hop chain every read (config from
`config/singletons.json`'s `app.TimeManager` entry) and rejects out-of-range values
(`daySec` outside `[0, 2880]`, `day` outside `[0, MaxGameDay=1000000]`) rather than
showing a garbage clock. Wired onto `game-position` as `gameTime: {day, hh, mm}` (null
if unresolvable). Displayed in the control window's coords readout (`time  day 107
05:20`) and on its own line in the overlay's area-readout HUD (`#hudTime`), where a
ticking clock alone is now enough to keep the HUD visible on the open overworld.

