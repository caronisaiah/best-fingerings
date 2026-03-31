```markdown
# Design System Specification: The Composer’s Study

## 1. Overview & Creative North Star
The Creative North Star for this system is **"The Digital Manuscript."** 

This is not a standard web interface; it is a high-end, bespoke environment that mimics the tactile and intellectual atmosphere of a composer’s study or a private library. We are moving away from the "app" feel and toward a "document" feel. The layout takes inspiration from professional music notation software and archival editorial design—prioritizing high-contrast structural anchors against soft, organic workspaces.

To break the "template" look, we utilize **Intentional Asymmetry**. Heavy, dark-wood structural elements (Sidebars/Headers) act as the "desk," while the parchment workspace (Main Content) acts as the "paper." We favor generous, breathable margins and overlapping elements to create a sense of physical depth.

---

## 2. Colors & Surface Logic
The palette is a sophisticated interplay between the organic warmth of parchment (`surface`) and the authoritative weight of dark mahogany (`primary`).

### The "No-Line" Rule
**Prohibit 1px solid borders for sectioning.** Boundaries must be defined solely through background color shifts or tonal transitions. For example, a navigation rail in `primary` (#321716) requires no border to separate it from the `surface` (#fcf9f0) workspace; the value contrast provides all the definition needed.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. Use the `surface-container` tiers to create "nested" depth:
*   **Base Layer:** `surface` (#fcf9f0) — The primary canvas.
*   **The Inset:** `surface-container-low` (#f6f3ea) — Use for secondary side-panels or recessed areas.
*   **The "Paper" Lift:** `surface-container-lowest` (#ffffff) — Use for active editing areas or high-priority cards to simulate a fresh sheet of paper laid on the desk.

### The "Glass & Wood" Rule
To elevate the "dark wood" accents (`primary`, `tertiary`), use a 20% opacity white `surface-tint` overlay on top of the dark backgrounds for hover states. This mimics the subtle reflection of a polished lacquer. For floating panels over the parchment, use a `surface-container-highest` background with a 12px backdrop-blur to create a "vellum" glass effect.

---

## 3. Typography
Typography is the heart of this system. We use **Newsreader** for its calligraphic, scholarly personality and **Public Sans** for technical metadata.

*   **The Heroic Display:** Use `display-lg` (Newsreader) for primary page titles. Tighten the letter-spacing slightly (-0.02em) to give it an authoritative, printed feel.
*   **The Notation Label:** All functional labels (buttons, tags, small captions) must use `label-md` (Public Sans). This creates a "technical overlay" look, similar to the small sans-serif annotations found in musical scores or blueprints.
*   **Body Content:** Use `body-lg` for all long-form text. The high x-height of Newsreader ensures legibility against the parchment background.

---

## 4. Elevation & Depth
We reject traditional drop shadows in favor of **Tonal Layering**.

*   **Layering Principle:** Place a `surface-container-lowest` (#ffffff) card on a `surface-container` (#f1eee5) background. The 5% shift in brightness is sufficient to indicate hierarchy without visual clutter.
*   **Ambient Shadows:** If a floating element (like a context menu) is required, use a shadow with a 32px blur, 0px offset, and 6% opacity using the `on-background` color (#1c1c17). This mimics the soft, omnidirectional light of a library.
*   **The "Ghost Border" Fallback:** If a container requires a boundary (e.g., an input field), use `outline-variant` (#d4c3c1) at 30% opacity. Never use 100% opaque lines.

---

## 5. Components

### The Anchor (Sidebar/Header)
The primary structural elements use `primary` (#321716). Typography within these elements should be `on-primary` (#ffffff) or `on-primary-fixed-variant` (#5f3e3c) for a subdued, etched look.

### Buttons
*   **Primary:** A solid block of `primary` (#321716) with `on-primary` text. Radius: `sm` (0.125rem). It should look like a stamped seal.
*   **Secondary:** `surface-container-highest` (#e5e2da) background. No border. Text in `primary`.
*   **Tertiary:** Ghost style. `label-md` (Public Sans) in all-caps with 0.05em tracking.

### Cards & Lists
*   **Forbid dividers.** To separate list items, use a `2.5` (0.5rem) vertical gap. 
*   **Active States:** An active list item should transition its background to `surface-container-high` (#ebe8df) with a `DEFAULT` (0.25rem) corner radius.

### Input Fields
Inputs should mimic a ledger. Use a `surface-container-low` (#f6f3ea) background with a "Ghost Border" bottom-only stroke (1px, `outline-variant` at 40%). When focused, the stroke transitions to `secondary` (#77574d).

---

## 6. Do’s and Don’ts

### Do
*   **Use Intentional White Space:** Use the `20` (4.5rem) or `24` (5.5rem) spacing tokens for page margins to create an "archival" feel.
*   **Mix Weights:** Pair a `display-sm` (Light italic Newsreader) with a `label-sm` (Bold Public Sans) for a high-end editorial contrast.
*   **Think in Layers:** Always ask, "Can I define this area with a background color shift instead of a line?"

### Don’t
*   **Don't use pure black.** Use `on-background` (#1c1c17) for text to maintain the organic, ink-on-paper warmth.
*   **Don't use large radii.** Avoid `xl` or `full` rounding unless it's for a specific status indicator. This system is architectural; stick to `none`, `sm`, and `md`.
*   **Don't use standard "Primary Blue."** Every accent must pull from the `secondary` (warm clay) or `tertiary` (deep amber) tokens to keep the "Study" palette cohesive.

---

## 7. Signature Element: The "Desk Overlap"
To truly capture the "Composer’s Study" aesthetic, allow main content containers (`surface-container-lowest`) to visually overlap the dark sidebar (`primary`) by a margin of `8` (1.75rem). This creates a 3D effect of a manuscript resting on a dark wood desk, instantly breaking the "grid-locked" feel of standard SaaS applications.