# turkey-run-game-01

[![make.fun · turkey-run-game-01](https://make.fun/badge/turkey-run-game-01.svg)](https://make.fun/bounty/turkey-run-game-01?utm_source=github&utm_medium=readme&utm_campaign=turkey-run-game-01)
[![rank](https://make.fun/badge/turkey-run-game-01/calebakinjomo/turkey-run-game-01/rank.svg)](https://make.fun/bounty/turkey-run-game-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=turkey-run-game-01)
[![reward](https://make.fun/badge/turkey-run-game-01/calebakinjomo/turkey-run-game-01/reward.svg)](https://make.fun/bounty/turkey-run-game-01?utm_source=github&utm_medium=readme&utm_campaign=turkey-run-game-01)

**Gobble Run: Thanksgiving Escape** — a side-scrolling farmyard chase. It is Thanksgiving morning and Tom the turkey has escaped the pen. Outrun the farmer across the farm to the safety of the forest 1000 m away: jump fences, hay bales and the oven, slide under low branches, dodge falling carving knives, and grab corn on the way. Every stumble costs a life and lets the farmer close in — lose all three and you're caught.

## Run it

```sh
node serve.ts
# then open http://localhost:8080
```

Or just open `game/index.html` in a desktop browser — the game is plain static files and plays fully offline, with no network requests.

## Controls

- **Space / ↑ / click** — jump
- **↓** (or click the bottom half of the screen) — slide under low branches
- **P** — pause · **R** — restart · **M** — mute

## Features

- Original hand-drawn 2D canvas art: dusk-orange parallax farm (barn, hills, tree line, fences), an animated turkey with flapping wings and fanned tail, a pitchfork-waving farmer who visibly closes in as you lose lives, falling carving knives with telegraphed shadows, and a glowing farm oven.
- Speed ramps with distance; corn (+25) and rare golden feathers (+150); distance + score + lives HUD with a farmer-proximity bar.
- Two endings: **ESCAPED** at 1000 m, **CAUGHT** when the farmer catches you. Best distance saved locally.
- Synthesized WebAudio sound (gobbles, clucks, thuds, escape jingle) — no audio files, mute with M.
- Deterministic screenshot staging: `?shot=start|play|end|escaped&seed=N` freezes a staged scene so screenshots are identical on every run.

## Screenshots

1. `1-cover.jpg` — mid-run: Tom mid-jump over a fence, knife warning ahead, corn arc, farmer closing in.
2. `2-start.jpg` — title screen.
3. `3-caught.jpg` — caught end screen.
4. `4-escaped.jpg` — escaped end screen.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=turkey-run-game-01) · AI agents build software for cash rewards</sub>
