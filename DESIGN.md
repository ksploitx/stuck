# DESIGN.md — Stuck Visual Design System

This file is the single source of truth for all colors, typography, spacing, and component styles used in the Stuck webview UI. The HTML mockups (`mockups/session-list.html`, `mockups/postmortem-report.html`) implement this system. The VS Code webview templates in `src/webview/` adapt these tokens using VS Code CSS variables where appropriate.

## Color Palette

### Backgrounds
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--bg-primary`      | `#1a1a2e` | Main webview / panel background             |
| `--bg-secondary`    | `#16213e` | Cards, sections, elevated surfaces          |
| `--bg-tertiary`     | `#0f3460` | Hover states, active list items              |
| `--bg-surface`      | `#1e1e3a` | Input fields, subtle insets                  |

### Text
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--text-primary`    | `#e0e0e0` | Headings, primary content                   |
| `--text-secondary`  | `#a0a0b8` | Descriptions, secondary labels              |
| `--text-muted`      | `#6c6c8a` | Timestamps, metadata, disabled text         |
| `--text-inverse`    | `#1a1a2e` | Text on bright badges                       |

### Status Colors
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--status-success`  | `#4ade80` | Successful sessions, green dot              |
| `--status-warning`  | `#fbbf24` | Retry loops, amber dot                      |
| `--status-error`    | `#f87171` | Failed sessions, red dot                    |
| `--status-active`   | `#60a5fa` | Currently running session, blue pulse       |

### Accents
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--accent-primary`  | `#7c3aed` | Primary buttons, active highlights          |
| `--accent-hover`    | `#6d28d9` | Button hover states                         |
| `--accent-link`     | `#818cf8` | Links, "View in SigNoz" button              |

### Time Breakdown Bar Colors
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--phase-planning`  | `#818cf8` | Indigo — LLM / planning time               |
| `--phase-editing`   | `#4ade80` | Green — file editing time                   |
| `--phase-commands`  | `#fbbf24` | Amber — terminal commands time              |
| `--phase-waiting`   | `#6c6c8a` | Muted grey — idle / waiting time            |

### Borders & Dividers
| Token               | Hex       | Usage                                      |
|---------------------|-----------|---------------------------------------------|
| `--border-subtle`   | `#2a2a4a` | Card borders, list separators               |
| `--border-focus`    | `#7c3aed` | Focus rings, active states                  |

## Typography

| Element             | Font                          | Size   | Weight | Line Height |
|---------------------|-------------------------------|--------|--------|-------------|
| Section header      | System UI / `-apple-system`   | 11px   | 600    | 1.2         |
| Session title       | System UI                     | 13px   | 500    | 1.4         |
| Session metadata    | System UI                     | 11px   | 400    | 1.3         |
| Report heading (h2) | System UI                     | 16px   | 600    | 1.3         |
| Report body         | System UI                     | 13px   | 400    | 1.5         |
| Monospace data      | `'SF Mono', 'Cascadia Code', 'Fira Code', monospace` | 12px | 400 | 1.4 |
| Badge text          | System UI                     | 10px   | 700    | 1.0         |

Font stack: `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

## Spacing

Base unit: **4px**

| Token    | Value | Common use                    |
|----------|-------|-------------------------------|
| `--sp-1` | 4px   | Icon gaps, tight padding      |
| `--sp-2` | 8px   | Card inner padding, list gap  |
| `--sp-3` | 12px  | Section margins               |
| `--sp-4` | 16px  | Panel padding, card padding   |
| `--sp-5` | 20px  | Section separation            |
| `--sp-6` | 24px  | Large separations             |

## Border Radius

| Token        | Value |
|--------------|-------|
| `--radius-s` | 4px   |
| `--radius-m` | 6px   |
| `--radius-l` | 8px   |

## Component Specs

### Status Dot
- Size: 8px × 8px, `border-radius: 50%`
- Colors: `--status-success`, `--status-warning`, `--status-error`, `--status-active`
- Active state has a CSS pulse animation (2s infinite)

### Retry Badge
- Background: `--status-warning` at 20% opacity
- Text color: `--status-warning`
- Font: badge text (10px, weight 700)
- Padding: `2px 6px`, border-radius: `--radius-s`
- Only shown when retry count ≥ 1

### Session List Item
- Padding: `--sp-2` vertical, `--sp-3` horizontal
- Border-bottom: 1px solid `--border-subtle`
- Hover: background → `--bg-tertiary`
- Cursor: pointer
- Layout: flex row, status dot left, text center, duration right

### Section Group Header
- Text: uppercase, `--text-muted`, font-size 11px, weight 600
- Letter-spacing: 0.5px
- Padding: `--sp-3` horizontal, `--sp-2` vertical
- Margin-top: `--sp-4`

### Time Breakdown Bar
- Height: 8px, border-radius: `--radius-s`
- Background: `--bg-surface`
- Segments: flex, proportional widths per phase
- Each segment colored by its phase token
- Below the bar: legend with dot + label + percentage, laid out as inline-flex row

### Root Cause Card
- Background: `--status-error` at 8% opacity
- Left border: 3px solid `--status-error`
- Padding: `--sp-3`
- Border-radius: `--radius-m`
- Only rendered when session has errors

### SigNoz Button (Footer)
- Background: `--accent-primary`
- Hover: `--accent-hover`
- Text: white, 13px, weight 500
- Padding: `--sp-2` vertical, `--sp-4` horizontal
- Border-radius: `--radius-m`
- Full-width on mobile / narrow panels
- Disabled state: 50% opacity, cursor not-allowed, tooltip "SigNoz not reachable"

### Empty State
- Centered vertically and horizontally
- Icon: codicon `$(info)` or similar, 32px, `--text-muted`
- Text: "No sessions yet", `--text-secondary`, 13px
- Sub-text: "Sessions will appear here after agent activity", `--text-muted`, 11px

### Loading State
- Centered spinner (CSS-only, 24px)
- Text: "Generating postmortem…", `--text-secondary`, 13px
- Pulsing opacity animation
