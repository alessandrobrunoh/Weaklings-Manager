# Albion Guild Keeper - Design Specification

This document defines the user interface and design system for the **Albion Guild Keeper** frontend, derived directly from the provided design mockup.

---

## 1. Visual Overview & Layout Structure

The layout is a modern, clean, immersive dark-themed dashboard tailored for gaming guilds (specifically Albion Online). It is structured into three main layout containers:

```
+-------------------------------------------------------------------+
|  LOGO  |  [GUILD SELECTOR]                     (Bell) (Avatar v)  |
|  (Gold)|  Header Bar                                              |
+--------+----------------------------------------------------------+
|        |                                                          |
|        |                                                          |
|        |                  MAIN CONTENT AREA                       |
|        |                                       +----------------+ |
| SIDE-  |                                       | PROFILE WIDGET | |
| BAR    |                                       | - Balance      | |
|        |                                       | - Avatar       | |
|        |                                       | - Manage Btn   | |
|        |                                       | - Lang & Log   | |
|        |                                       +----------------+ |
|        |                                                          |
+--------+----------------------------------------------------------+
```

### Layout Properties:
- **Left Sidebar**: Fixed-width navigation panel (approx. `260px`). Spans the full height of the viewport.
- **Top Header**: Horizontal bar containing global context controls (Guild Selector) and user quick-actions (Notifications, Profile status). Aligned next to the sidebar.
- **Main Workspace**: Flexible canvas that accommodates the active page content, with an overlay or right-aligned container for the context-sensitive widgets (e.g., the User Profile Card).

---

## 2. Color Palette & Dark Theme System

The interface uses a custom palette of deep charcoal, slate gray, and gold accents to evoke a premium fantasy-RPG atmosphere.

| Token | CSS Variable / Tailwind | Hex Value | Usage / Notes |
| :--- | :--- | :--- | :--- |
| **Sidebar BG** | `--color-sidebar-bg` | `#181c20` | Core navigation background |
| **Workspace BG** | `--color-workspace-bg` | `#2c2f35` | Main workspace backdrop |
| **Header BG** | `--color-header-bg` | `#202225` | Top header background |
| **Card BG** | `--color-card-bg` | `#1b1e22` | Profile widget and secondary modules |
| **Text Primary** | `--color-text-primary` | `#e3e5e8` | Active text, titles, values |
| **Text Secondary** | `--color-text-secondary` | `#9ba1a6` | Inactive links, labels, descriptions |
| **Accent Gold** | `--color-accent-gold` | `#c5a059` | Sidebar headers, brand highlights |
| **Accent Red** | `--color-accent-red` | `#f04747` | Indicators (No Guild), logout icons |

---

## 3. UI Component Specifications

### 3.1 Sidebar (Left Navigation)
- **Brand Header**:
  - Logo: A stylized gold/bronze medieval castle graphic.
  - Text: **ALBION** (Gold, bold, serif/semi-serif style font) stacked above **GUILD KEEPER** (Smaller, muted white/gray, sans-serif).
- **Navigation Groups**:
  - Root items: `Dashboard`, `Settings` (standard style).
  - Group Header: `GUILD` (Gold text, dropdown chevron).
    - Sub-items: `Applications`, `Members`, `Giveaways`, `Rewards`, `Leaderboards`, `Balance`, `All Events`.
  - Group Header: `BUILDS & COMPS` (Gold text, dropdown chevron).
    - Sub-items: `Builds`, `Comps`.
- **States**:
  - *Inactive*: Muted gray text, transparent background.
  - *Hover*: Slight white/gray highlight background.
  - *Active*: Semi-transparent light-gray background pill, white text.

### 3.2 Top Header
- **Guild Selector**:
  - Pill-shaped dropdown container.
  - Status indicator: Red circular badge with white `X` icon inside (for "No Guild Selected") or Green check (when a guild is active).
  - Text: `CURRENT GUILD: NO GUILD SELECTED` (or active guild name).
  - Dropdown indicator: Dual chevron (up/down).
- **Actions Bar (Right)**:
  - Notification icon (Bell) with hover animations.
  - Quick avatar preview (circular) with a downward arrow for user settings.

### 3.3 User Profile Widget
A floating or right-aligned card (`max-w-xs`) with a distinct dark background:
- **Header Row**:
  - Silver Coin Icon (Albion currency style).
  - Value: `23.000.000` (or user's silver balance).
- **Profile Area**:
  - Circular profile image with a gold border or highlight ring.
  - Subtitle: `Welcome, WolfyErPazzo` (semi-bold primary text).
- **Primary Actions**:
  - `MANAGE YOUR ACCOUNT` Button: Rectangular, rounded-lg, solid medium-gray background, white text. Flat styling.
- **Footer Actions**:
  - Language Selector (left): Flag icon + Language name (`English`), dropdown chevron.
  - Logout (right): Red door-arrow logout icon + `Logout` label.

---

## 4. Typography & Assets

- **Font Family**: Modern sans-serif (e.g., `Inter` or `Geist`) for general UI. Trajan/Roman-inspired serif fonts for headers/logos (can be simulated with uppercase tracking and serif options).
- **Icons**: Simple stroke-based SVG icons (e.g., Lucide React).
- **Borders**: Thin dark borders (`#2f3136`) with low contrast.

---

## 5. Integration Plan for Frontend

To integrate this layout into our existing Next.js frontend:
1. Update `apps/frontend/src/app/globals.css` with the custom design tokens (colors, font-weights, reset styles).
2. Refactor `apps/frontend/src/components/Header.tsx` to handle the top-bar visual components.
3. Build a new `Sidebar.tsx` navigation component mirroring the sidebar items and styling.
4. Implement a responsive layout container in `apps/frontend/src/app/layout.tsx` that includes:
   - Sidebar on the left (collapsible on mobile).
   - Top Header bar.
   - Main content scrollable viewport.
5. Create or adjust the `Dashboard` and other main pages to fit nicely into this layout, incorporating the User Profile widget as a floating or right-aligned component.
