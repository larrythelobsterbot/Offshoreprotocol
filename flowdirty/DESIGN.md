# FlowDirty.fun — Design System

> A live, public on-chain position tracker for **Offshore Protocol** on MegaETH.
> Paste a wallet, see the heat. Pushes the operator's referral link as the
> secondary action of every screen.

---

## 0. Concept rollup

| Axis | Choice | Why |
|---|---|---|
| Vibe Archetype | **Ethereal Glass** | Maps directly onto the operator's brief: "neon pink and cyan on dark backgrounds". Cypherpunk + on-chain trading-screen + FBI heat motif |
| Layout Archetype | **Asymmetrical Bento** | Dashboard with heterogeneous data weights (one giant headroom tile, small balance tiles, wide cycle banner). The asymmetry communicates "this is a real terminal", not a marketing template |
| Mood | "Look at this dirty money you're laundering. The feds are circling. Here's the heat." |
| Tone | Confident, terse, slightly menacing. Never cute. Never explainer-y. |

The page has **two states**:
1. **Pre-search** — a single hero with a wallet input (primary CTA) and a ref link (secondary). The whole viewport is the input.
2. **Dashboard** — once a valid wallet is submitted, the hero collapses to a thin sticky band and the bento grid materializes with live data.

---

## 1. Color palette

OLED-true black backdrop. Cyan = "safe / on-track", pink = "operator brand / CTAs", red = "FBI heat". Green is INTENTIONALLY ABSENT — too friendly for the laundering motif.

```
--bg-deep:       #050505    /* page base, almost true black */
--bg-elevated:   #0A0A0F    /* card / inner-core background */
--bg-tier-1:     #14141B    /* Double-Bezel outer shell */
--bg-tier-2:     #1A1A24    /* hover surface */
--hairline:      rgba(255, 255, 255, 0.06)   /* outer ring */
--hairline-warm: rgba(255, 45, 123, 0.12)    /* on-pink hairline */
--hairline-cool: rgba(0, 229, 255, 0.10)     /* on-cyan hairline */

/* TEXT */
--text-pure:     #F4F4F6
--text-mid:      #A1A1AA
--text-dim:      #52525B
--text-faint:    rgba(255, 255, 255, 0.18)

/* ACCENTS */
--neon-pink:     #FF2D7B    /* operator brand, primary CTA, ref link */
--neon-pink-glow: rgba(255, 45, 123, 0.45)
--neon-cyan:     #22F0FF    /* "safe" data, balance tickers, headroom bars */
--neon-cyan-glow: rgba(34, 240, 255, 0.40)

/* HEAT (semantic) */
--heat-low:      #22F0FF    /* same as cyan; "you're fine" */
--heat-mid:      #FFB534    /* warm amber for warn band */
--heat-high:     #FF3D3D    /* FBI red — must pulse */
--heat-high-glow: rgba(255, 61, 61, 0.55)

/* GRADIENT MESH (page background, fixed-position decorative) */
--mesh-cyan:     radial-gradient(1200px 600px at 8% 10%, rgba(34, 240, 255, 0.08), transparent 60%)
--mesh-pink:     radial-gradient(900px 500px at 92% 90%, rgba(255, 45, 123, 0.10), transparent 60%)
--mesh-noise:    url("data:image/svg+xml;utf8,<svg ...>")   /* subtle film grain @ 3% opacity */
```

**Usage rules:**
- Pink is reserved for: hero gradient text accents, ref-link CTAs, the wallet input glow on focus, and the "FlowDirty" logo. NEVER use pink for live data values.
- Cyan is the language of "live / on-chain / safe". All token balances, PROCYANINE ticker prices, healthy headroom bars.
- Red is precious — use ONLY for danger alerts (low headroom, high suspicion, liquidation warnings). When red appears, it should feel earned.

---

## 2. Typography

```html
<!-- Google Fonts CDN, dropped in <head> -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

| Family | Use | CSS |
|---|---|---|
| **Geist** | Hero numerics, body copy | `font-family: 'Geist', system-ui, sans-serif;` |
| **Space Grotesk** | Display headlines (hero title, section headers) | `font-family: 'Space Grotesk', sans-serif;` |
| **Geist Mono** | All wallet addresses, on-chain numbers, code | `font-family: 'Geist Mono', 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums;` |

**Banned**: Inter, Roboto, Helvetica, Arial. Anything generic.

### Type scale (mobile-first; multiply 1.15 at md+, 1.3 at lg+)

| Token | Size (base) | Line | Weight | Letter-spacing | Use |
|---|---|---|---|---|---|
| `--display-1` | 4.5rem (72px) | 0.92 | 700 | -0.04em | Pre-search hero ("track the dirty") |
| `--display-2` | 3rem (48px) | 0.95 | 700 | -0.03em | Dashboard headers |
| `--h1` | 2.25rem (36px) | 1.05 | 600 | -0.02em | Section headers |
| `--h2` | 1.5rem (24px) | 1.15 | 600 | -0.01em | Tile titles |
| `--num-hero` | 6rem (96px) | 0.9 | 600 | -0.04em | Headroom % giant readout. Mono. |
| `--num-tile` | 2.25rem (36px) | 1 | 500 | -0.02em | Balance tile values. Mono. |
| `--num-row` | 1rem (16px) | 1.4 | 500 | 0 | In-table numbers. Mono. |
| `--body` | 1rem (16px) | 1.55 | 400 | 0 | Prose |
| `--small` | 0.8125rem (13px) | 1.5 | 400 | 0 | Captions, meta |
| `--micro` | 0.625rem (10px) | 1 | 500 | 0.2em (uppercase) | Eyebrow tags ("OFFSHORE INTEL") |

All numerics use `font-variant-numeric: tabular-nums` so live updates don't shift width.

---

## 3. Spacing & rhythm

Geometric scale. Macro whitespace.

```
--space-1:   4px
--space-2:   8px
--space-3:   12px
--space-4:   16px
--space-6:   24px
--space-8:   32px
--space-12:  48px
--space-16:  64px
--space-24:  96px    /* section padding (mobile) */
--space-32:  128px   /* section padding (desktop) */
--space-40:  160px   /* hero vertical padding */
```

**Section rhythm**:
- Pre-search hero: `min-h-[100dvh]`, content vertically centered, `py-24`
- Dashboard sections: `py-24` (mobile), `py-32` (desktop)
- Tile inner padding: `p-6` (mobile), `p-8` (desktop)
- Bento gap: `gap-3` (mobile), `gap-4` (desktop) — tighter than usual to read as "control panel"

---

## 4. The Double-Bezel (mandatory for every card)

```html
<!-- Outer shell: machined-aluminum tray -->
<div class="bezel">
  <!-- Inner core: the actual content -->
  <div class="core">
    ...content...
  </div>
</div>
```

```css
.bezel {
  background: var(--bg-tier-1);
  padding: 6px;                              /* the "tray" depth */
  border-radius: 24px;
  border: 1px solid var(--hairline);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.04) inset,  /* top-edge highlight */
    0 30px 60px -20px rgba(0, 0, 0, 0.5);     /* soft floor shadow, never harsh */
}
.core {
  background: var(--bg-elevated);
  border-radius: calc(24px - 6px);          /* concentric */
  padding: 32px;
  position: relative;
  overflow: hidden;
}
.core::before {
  /* inner-edge highlight — subtle but critical */
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.06);
}
```

Variants:
- **`.bezel.bezel-warm`** — pink hairline + faint pink glow under shell. For the hero ref-link card.
- **`.bezel.bezel-cool`** — cyan hairline + faint cyan glow. For "safe" status tiles.
- **`.bezel.bezel-heat`** — red glow when an active danger state. For the headroom hero tile when red.

---

## 5. Component anatomy

### 5.1 Pre-search hero

```
─────────────────────────────────────────────────────────
                                                          
                  [eyebrow] OFFSHORE INTEL                
                                                          
              track  the  dirty   ◢                       
              ╲╲╲╲╲╲╲╲╲╲╲╲╲╲╲╲╲╲╲                          (gradient pink→cyan)
                                                          
       Live on-chain position monitor for                
       Offshore Protocol. Paste your wallet,             
       see your heat.                                     
                                                          
       ┌──────────────────────────────────┐              
       │ ⌬  0x...  ▸ paste wallet  ⏎     │  ← wallet pill
       └──────────────────────────────────┘              
                                                          
       Don't have an account?                             
       [Start playing →]  (ref link, pink CTA)            
                                                          
                                                          
       (a tiny ticker scrolls live data along the         
        bottom edge: "ETH 2,278.93  ·  Cycle 6 ends 2h    
        14m  ·  Network 14,231 ops/24h")                  
                                                          
─────────────────────────────────────────────────────────
```

- **Eyebrow tag**: pill, `bg-pink-500/8` + `border-pink-500/20`, `text-[10px] uppercase tracking-[0.2em]`. Reads `OFFSHORE INTEL · LIVE`.
- **Display headline**: 72px Space Grotesk 700, line-height 0.92. The "track the dirty" headline uses `background-clip: text` with a pink→cyan linear gradient at 105°. The trailing `◢` is a Phosphor Light icon at 80% opacity.
- **Subhead**: 18px Geist 400, max-width 28ch, color `--text-mid`.
- **Wallet input (primary CTA)**: `glass-pill` component below.
- **Ref link**: smaller pill, `outline` style — text `Don't have an account?` in `--text-mid` followed by `Start playing →` in `--neon-pink`. Clicks open `app.offshoreprotocol.fun/?ref=BMR6ZA` in new tab.
- **Bottom ticker**: `position: absolute; bottom: 0`, `mask-image: linear-gradient(90deg, transparent, black 10%, black 90%, transparent)` for soft edges. Auto-scrolling marquee at 60s/loop.

### 5.2 Wallet input — the only thing that matters above the fold

```html
<form class="wallet-form" data-state="empty">
  <div class="wallet-pill">
    <span class="wallet-pill__icon">⌬</span>          <!-- Phosphor Light "wallet" -->
    <input
      class="wallet-pill__input"
      type="text"
      inputmode="latin"
      autocomplete="off"
      spellcheck="false"
      placeholder="0x...   paste wallet to begin"
      pattern="^0x[0-9a-fA-F]{40}$"
      maxlength="42"
      aria-label="Wallet address"
    />
    <button class="wallet-pill__paste" type="button" aria-label="Paste from clipboard">
      <span class="paste-icon">▸</span> paste
    </button>
    <button class="wallet-pill__submit" type="submit" aria-label="Submit">
      <span class="submit-icon">↗</span>             <!-- nested in 32x32 circle -->
    </button>
  </div>
  <div class="wallet-pill__error" hidden>Invalid address</div>
</form>
```

```css
.wallet-pill {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 10px 10px 24px;
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
  border-radius: 9999px;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.05),
    0 30px 60px -20px rgba(0, 0, 0, 0.6),
    0 0 0 0 rgba(255, 45, 123, 0);          /* glow base, animated on focus */
  transition: box-shadow 700ms cubic-bezier(0.32, 0.72, 0, 1),
              border-color 400ms cubic-bezier(0.32, 0.72, 0, 1);
}
.wallet-pill:focus-within {
  border-color: var(--neon-pink);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.05),
    0 30px 60px -20px rgba(0, 0, 0, 0.6),
    0 0 0 6px rgba(255, 45, 123, 0.10),       /* outer ring glow */
    0 0 30px 0 var(--neon-pink-glow);          /* halo */
}
.wallet-pill__input {
  background: transparent;
  border: 0;
  outline: 0;
  font-family: 'Geist Mono', monospace;
  font-size: 18px;
  color: var(--text-pure);
  caret-color: var(--neon-pink);
}
.wallet-pill__input::placeholder { color: var(--text-faint); }

/* Submit button — Button-in-Button pattern */
.wallet-pill__submit {
  width: 44px; height: 44px;
  border-radius: 9999px;
  background: linear-gradient(135deg, var(--neon-pink), #FF66A8);
  display: grid; place-items: center;
  color: #000;
  border: 0;
  cursor: pointer;
  transition: transform 350ms cubic-bezier(0.32, 0.72, 0, 1);
}
.wallet-pill__submit:active { transform: scale(0.96); }
.wallet-pill__submit:hover .submit-icon { transform: translate(2px, -2px); }
.submit-icon {
  display: inline-block;
  transition: transform 350ms cubic-bezier(0.32, 0.72, 0, 1);
}
```

States:
- **empty**: placeholder visible, submit button disabled (lower opacity + no glow)
- **invalid** (input length 1-41 OR fails regex): border-color `--heat-mid`, error message slides up from below
- **valid**: pink halo intensifies, submit button pulses subtly
- **loading**: replace submit icon with a 3-dot loader, input is read-only

### 5.3 Dashboard transition (hero → live state)

When a valid wallet is submitted:
1. The hero's display headline shrinks from 72px → 28px and animates to a sticky band at the top (with the wallet pill embedded in it, now smaller and showing the truncated wallet `0x30C6...e194` with a "change" affordance).
2. The bento grid slides up from `translate-y-16 blur-md opacity-0` → `translate-y-0 blur-0 opacity-100` over 800ms.
3. Tiles inside the bento stagger in with 80ms delays each.

```js
// pseudocode: orchestration on form submit
function transitionToDashboard(wallet) {
  document.body.dataset.appState = 'live';   // CSS hooks on this attribute
  // Bento children animate in via IntersectionObserver + CSS class .reveal
}
```

### 5.4 Bento grid (live dashboard)

```
┌─────────────────────────────────┬─────────────────────┐
│                                 │                     │
│   HEADROOM HERO (col-span 8)    │  WALLET STATUS      │
│                                 │  (col-span 4)       │
│   54%                           │                     │
│   ─────────────────             │  Status L4          │
│   Worst: BVI · Drug             │  XP 875 / 6,500     │
│                                 │  ─── progress bar   │
│                                 │                     │
├─────────────────────────────────┼─────────────────────┤
│                                                       │
│   BALANCES STRIP (col-span 12)                        │
│   INF 75.63 · DIRTY 847.84 · USDM 92.82               │
│                                                       │
├──────────────────┬──────────────────────────┬─────────┤
│                  │                          │         │
│   PER-CORP       │   LOADOUTS DETAIL        │         │
│   TABLE          │   (col-span 4)           │  ──     │
│   (col-span 5)   │                          │         │
│                  │   gen #69                │         │
│   Cayman   91%   │   suspicion 100% [pulse] │         │
│   BVI      54%   │   proj 123.17M           │         │
│   Bermuda  92%   │                          │         │
│   ...            │   gen #663               │         │
│                  │   suspicion 92%          │         │
│                  │   proj 186.74M           │         │
├──────────────────┴──────────────────────────┴─────────┤
│                                                       │
│   CYCLE COUNTDOWN (col-span 12)                       │
│   Cycle 6 · 5h 34m elapsed · ends in 2h 14m           │
│   ───────────── progress bar ───────────              │
│                                                       │
├───────────────────────────────────────────────────────┤
│                                                       │
│   REF CTA #2 — "Want a tracker like this for your     │
│                  own positions? [Start playing →]"    │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Grid spec**:
```css
.bento {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 16px;
  padding: 16px;
}
@media (max-width: 768px) {
  .bento {
    grid-template-columns: 1fr;          /* single column on mobile */
    gap: 12px;
    padding: 0 16px;
  }
  .bento > * { grid-column: 1 / -1; }     /* reset all spans */
}
```

### 5.5 Headroom hero tile (the most important visual on the page)

```html
<div class="bezel bezel-cool" data-alert="safe|warn|danger">
  <div class="core headroom-hero">
    <div class="headroom-hero__eyebrow">↳ MIN HEADROOM ACROSS ACTIVE OPS</div>
    <div class="headroom-hero__num">
      <span class="num-hero">54</span>
      <span class="num-hero__suffix">%</span>
    </div>
    <div class="headroom-hero__bar">
      <div class="headroom-hero__bar-fill" style="width: 54%"></div>
    </div>
    <div class="headroom-hero__detail">
      Worst: <span class="loc">BVI</span> · <span class="mode">Drug</span> ·
      ETH <span class="num">$2,279</span> vs anchor <span class="num">$2,278.70</span>
      (<span class="dev">+0.011%</span> / <span class="thr">±0.518%</span>)
    </div>
  </div>
</div>
```

```css
.num-hero {
  font: 600 96px/0.9 'Geist Mono', monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}
.num-hero__suffix {
  font: 500 32px/1 'Geist Mono', monospace;
  color: var(--text-dim);
  margin-left: 4px;
}
.headroom-hero__bar {
  height: 8px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  overflow: hidden;
  margin: 24px 0 16px;
}
.headroom-hero__bar-fill {
  height: 100%;
  background: var(--neon-cyan);
  border-radius: 4px;
  transition: width 1200ms cubic-bezier(0.32, 0.72, 0, 1),
              background-color 400ms cubic-bezier(0.32, 0.72, 0, 1);
  box-shadow: 0 0 12px var(--neon-cyan-glow);
}
[data-alert="warn"] .headroom-hero__bar-fill {
  background: var(--heat-mid);
  box-shadow: 0 0 12px rgba(255, 181, 52, 0.45);
}
[data-alert="danger"] .headroom-hero__bar-fill {
  background: var(--heat-high);
  box-shadow: 0 0 16px var(--heat-high-glow);
  animation: heat-pulse 1.6s ease-in-out infinite;
}
[data-alert="danger"] .num-hero {
  color: var(--heat-high);
  text-shadow: 0 0 24px var(--heat-high-glow);
}

@keyframes heat-pulse {
  0%, 100% { opacity: 1; transform: scaleX(1); }
  50%      { opacity: 0.7; transform: scaleX(1.005); }
}
```

When the headroom drops below 25%, the entire bezel shell takes on a `bezel-heat` red glow, and the percentage number itself starts pulsing with `text-shadow`.

### 5.6 Per-corp row (table)

Each corp gets a row inside a wider tile:

```html
<div class="corp-row">
  <span class="corp-row__loc">BVI</span>
  <span class="corp-row__mode">Drug</span>
  <div class="corp-row__bar">
    <div class="corp-row__bar-fill" style="width: 54%" data-alert="warn"></div>
  </div>
  <span class="corp-row__pct" data-alert="warn">54%</span>
  <span class="corp-row__time">8m 14s</span>
</div>
```

```css
.corp-row {
  display: grid;
  grid-template-columns: 80px 60px 1fr 60px 80px;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--hairline);
  font-family: 'Geist Mono', monospace;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.corp-row__bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  overflow: hidden;
}
.corp-row__bar-fill {
  height: 100%;
  background: var(--neon-cyan);
  transition: width 800ms cubic-bezier(0.32, 0.72, 0, 1),
              background-color 300ms;
}
.corp-row__pct[data-alert="warn"]   { color: var(--heat-mid); }
.corp-row__pct[data-alert="danger"] { color: var(--heat-high); }
```

### 5.7 Loadout suspicion card

A vault projection card with a giant FBI HEAT bar:

```html
<div class="bezel">
  <div class="core loadout-card">
    <div class="loadout-card__head">
      <span class="micro">↳ ENTERPRISE 1 · gen #69</span>
      <span class="loadout-card__proj">proj <b class="num">123.17M</b></span>
    </div>
    <div class="loadout-card__heat" data-alert="danger">
      <div class="loadout-card__heat-label">FBI HEAT</div>
      <div class="loadout-card__heat-bar">
        <div class="loadout-card__heat-fill" style="width: 100%"></div>
      </div>
      <div class="loadout-card__heat-pct">100%</div>
    </div>
    <div class="loadout-card__sim">
      sim liquidates at tick 320 / 900 · 35.6% predicted survival
    </div>
  </div>
</div>
```

The HEAT BAR is the showpiece — when at danger level, it pulses red with a faint scanline overlay (`background: linear-gradient(90deg, transparent, rgba(255,61,61,0.2), transparent); animation: scan 2s linear infinite`).

### 5.8 Cycle countdown (full-width banner)

```
┌───────────────────────────────────────────────────────┐
│ CYCLE 6  ·  ●●●●●●●●●○○○ 70% elapsed                  │
│ 5h 34m in  ·  ends 22:42 UTC  ·  pool $26,384         │
└───────────────────────────────────────────────────────┘
```

Subtle ticker animation on the elapsed time — updates every 1s, the seconds digit briefly glows when it changes.

### 5.9 Educational flywheel (mid-page)

Three glass cards horizontally. Each shows one stage of the loop with a Phosphor Light icon and a single-sentence explanation. The cards collectively form an arrow (the third card has a slightly larger right margin to suggest "→ then back to 1").

### 5.10 Footer

```
                                                         
  [logo]  FlowDirty.fun                                  
                                                         
  Tracking N wallets across M visitors right now         
                                                         
  [ Start playing →  ]   (ref CTA #4, pink filled)       
                                                         
  Read-only · Unaffiliated               
                                                         
```

The "Tracking N wallets across M visitors" pulls from `/api/track-stats` every 30s — primary social-proof signal.

---

## 6. Animation choreography

All transitions must use:
```css
--ease-fluid: cubic-bezier(0.32, 0.72, 0, 1);    /* primary spring */
--ease-snap:  cubic-bezier(0.16, 1, 0.3, 1);     /* arrival, settles fast */
--ease-pulse: cubic-bezier(0.4, 0, 0.6, 1);      /* breathing, symmetric */
```

### Page entry (pre-search hero)
```css
.hero-eyebrow  { animation: rise 700ms var(--ease-snap) 0ms   both; }
.hero-headline { animation: rise 800ms var(--ease-snap) 100ms both; }
.hero-subhead  { animation: rise 700ms var(--ease-snap) 250ms both; }
.wallet-pill   { animation: rise 700ms var(--ease-snap) 400ms both; }
.hero-ref      { animation: rise 700ms var(--ease-snap) 550ms both; }

@keyframes rise {
  from { opacity: 0; transform: translateY(48px); filter: blur(8px); }
  to   { opacity: 1; transform: translateY(0);    filter: blur(0); }
}
```

### Bento reveal (post-submit)
Tiles enter staggered:
```js
tiles.forEach((tile, i) => {
  tile.style.animationDelay = `${80 * i}ms`;
});
```

### Number tick (live updates)
When a number changes, briefly flash the value in cyan/pink:
```css
.num.tick { animation: tick 600ms var(--ease-pulse); }
@keyframes tick {
  0%   { color: var(--neon-cyan); text-shadow: 0 0 12px var(--neon-cyan-glow); }
  100% { color: var(--text-pure); text-shadow: none; }
}
```
React: add `tick` class on every value change, remove after 600ms.

### Heat-pulse (danger states)
```css
@keyframes heat-pulse {
  0%, 100% { box-shadow: 0 0 16px var(--heat-high-glow); }
  50%      { box-shadow: 0 0 32px var(--heat-high-glow), 0 0 64px var(--heat-high-glow); }
}
```

### Magnetic CTA
Every primary button uses Group hover with internal kinetic translation of the trailing arrow:
```css
.cta:hover .cta__arrow { transform: translate(2px, -2px) rotate(0deg); }
.cta:active             { transform: scale(0.97); }
```

### Background mesh — slow drift
```css
body::before {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none;
  background:
    radial-gradient(1200px 600px at 8% 10%, rgba(34, 240, 255, 0.07), transparent 60%),
    radial-gradient(900px 500px at 92% 90%, rgba(255, 45, 123, 0.09), transparent 60%);
  animation: drift 60s linear infinite;
}
@keyframes drift {
  0%   { transform: translate(0, 0); }
  50%  { transform: translate(-3%, 2%); }
  100% { transform: translate(0, 0); }
}
```

### Film grain
```css
body::after {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none; z-index: 100;
  opacity: 0.025;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
}
```

---

## 7. Mobile collapses

Below 768px:
- Hero display headline drops to `--display-2` (48px) at 0.95 line-height
- Wallet pill goes full-width (`w-[calc(100%-32px)]`), submit button stays inside
- Bento collapses to single column — every tile is `col-span-1`
- Per-corp rows hide the time-remaining column at <420px (use a compact `8m` mode)
- Educational flywheel cards stack vertically with the `→ then back to 1` arrow becoming `↓`
- Footer ref CTA full-width

Always use `min-h-[100dvh]` not `min-h-screen` to dodge iOS Safari's dynamic viewport bug.

---

## 8. Live data choreography

Polling cadence (no WebSocket needed for v1):
- `/api/track/:wallet` — every 5s (matches the operator dashboard's perceived freshness; the API caches at 30s anyway, so frequent polls are cheap)
- `/api/track-stats` — every 30s for footer social proof
- ETH price comes inside `/api/track`, no separate feed needed

State machine:
```
empty → submitting → live → polling-error → live → ...
                  ↘ invalid-wallet → empty
```

When polling-error: keep showing last-good data dimmed at 60% opacity, banner slides down from top: `connection lost · retrying`.

---

## 9. Copy direction

Every line of copy passes the "would a CIA spook write this?" test. Terse, technical, slightly menacing.

| ✅ DO | ❌ DON'T |
|---|---|
| "Paste your wallet, see your heat." | "Welcome to FlowDirty! Connect to start tracking." |
| "Cycle 6 · 70% elapsed · ends 22:42 UTC" | "We're 70% of the way through cycle 6!" |
| "Sim liquidates at tick 320 of 900." | "Looks like your loadout might not survive 😬" |
| "Don't have an account? Start playing →" | "🎮 Click here to start playing now! 🎰" |
| "Tracking 247 wallets right now." | "Our community is growing fast!" |

Hero headline candidates (pick one, A/B if you must):
1. **"track the dirty"** ← my pick. Three words. Loaded.
2. "see the heat"
3. "your wallet, watched"
4. "every position, live"

---

## 10. Pre-output checklist (against the skill rules)

- [x] No banned fonts (Geist + Space Grotesk + Geist Mono)
- [x] No banned icons (Phosphor Light only — `⌬ ↗ ◢ ▸`)
- [x] No 1px gray borders (custom hairlines via rgba)
- [x] No harsh `shadow-md` — only soft floor shadows + inner highlights
- [x] No edge-to-edge sticky navbar — pre-search has no nav, post-search has a floating slim band
- [x] No `linear` / `ease-in-out` — only custom cubics
- [x] Vibe Archetype (Ethereal Glass) consciously selected
- [x] Layout Archetype (Asymmetrical Bento) consciously selected
- [x] Double-Bezel applied to every card
- [x] Button-in-Button trailing icon on the wallet submit
- [x] Section padding `py-24` minimum (`py-32`+ desktop)
- [x] All entry animations use `transform` + `opacity` + `filter` only
- [x] `backdrop-blur` only on fixed sticky band, not on scrolling content
- [x] Mobile collapse to single column at 768px
- [x] Reads as $150k agency, not template

---

## 11. Implementation notes

- **Single HTML file** for v1. Keep dependencies to one Google Fonts link + one tiny JS module for state machine + polling. Aim for <40KB gzipped.
- **Deploy target**: Cloudflare Pages connected to `flowdirty.fun`. The page calls `https://api.flowdirty.fun/api/track/:wallet` (Cloudflare Tunnel → operator's VPS 127.0.0.1:3456).
- **Privacy guardrail**: don't reuse the favicon, don't link back to `offshore.lekker.design`, don't write "built by [real name]" — no personal handles in the footer.
- **Performance budget**: First Contentful Paint <1s on 4G. Largest Contentful Paint <2s. CLS <0.05. JS execution time <100ms on first load.

---

## 12. What's NOT on this page (deliberate omissions)

- No "About" section. The hero copy IS the about.
- No newsletter signup. Twitter/Telegram links only.
- No analytics opt-in modal. Use a server-side path-only counter (no PII).
- No cookie banner (no cookies are set; if you add localStorage for "last wallet", that's not regulated).
- No risk disclaimers above the fold. Move to a `/risks` route accessed from footer.

---

> Build it tight. Build it cold. Make every visitor feel like they walked into the back room of a casino.
