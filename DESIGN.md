# Hopscotch UI contract

## Direction
Hopscotch is Milwaukee's live departure card: the page is built around one oversized, glanceable departure slip that answers "what leaves next?" before anything else. The visual language borrows Ticketline's confident consumer-product hierarchy, open white space, bold condensed display type, restrained workhorse body type, and one obvious action, then translates the ticket object into a transit object through a route-line spine, live vehicle glyphs, and Milwaukee blue. It is light, civic, calm, and useful rather than dashboard-like. The single accent is MCTS blue. Archivo Black handles display copy and Archivo handles every working label.

## Reference extraction
Source: Tyler's Ticketline screenshot, 1427 x 805.

### Colors by job
- Canvas: `#F6F8FB`, cool near-white behind the product.
- Surface: `#FFFFFF`, navigation, departure slips, controls.
- Ink: `#10213D`, deep navy rather than black.
- Muted: `#61708A`, supporting copy and utility labels.
- Hairline: `#D8E0EC`, borders and section rules.
- Accent: `#1769E0`, sampled/translated to Milwaukee transit blue for active states, links, live glyphs, and the primary action.
- Accent-dark: `#0E4EAE`, pressed/focus state only.
- Semantic status: `#287A52` on-time, `#A35C00` delayed, `#B4232F` disruption, `#7B879A` unknown. These communicate operational state and never decorate layout.

### Type scale
- 12px / 700 / +0.10em: eyebrow and compact labels.
- 14px / 600 / +0.01em: controls and metadata.
- 16px / 400 / 0: body.
- 20px / 700 / -0.01em: card title.
- 24px / 800 / -0.025em: section heading.
- 32px / 800 / -0.035em: mobile hero.
- 48px / 800 / -0.045em: desktop hero.
- Display line-height 0.98-1.12; body line-height 1.5; body measure max 62ch.

### Spacing
4px base: `4, 8, 12, 16, 24, 32, 48, 64`.
Mobile gutter 20px. Section spacing 48px. Component spacing 16-24px.

### Radius policy
Ticketline uses a controlled 6-8px radius on buttons and the featured product card. Hopscotch uses 8px on primary actions and select/input controls, 12px on the one featured departure slip and bottom sheet, and 4px on tiny vehicle glyphs. Tables, secondary groups, status labels, and ordinary sections stay square. No pills except truly circular map markers.

### Structural observations
1. Quiet top navigation leads into a large split hero with the product object as the visual anchor.
2. One large display promise, one short supporting paragraph, one primary action.
3. A hairline separates hero from the next task instead of a card stack.
4. Small icon-and-label utilities are secondary; the eye reads headline, object, action, then proof.
5. The product illustration is real and specific. For Hopscotch, live departure data itself is the illustration.

## Component rules
- The first departure card is the hero object. Later departures are lighter rows, never an equal-card grid.
- The primary action is "Open live map". Secondary actions use text or hairline outlines.
- Bottom navigation uses one SVG stroke family and labels. No emoji or text-symbol icons.
- Hierarchy comes from surface shifts and 1px rules, never shadows, gradients, blur, or colored edge stripes.
- Dense route tables use zebra rows.
- Buttons cover rest, hover, focus-visible, active, disabled/working states and confess loading state.

## Motion
- `--press: 140ms`, `--quick: 180ms`, `--enter: 240ms`.
- `--ease-out: cubic-bezier(0.23,1,0.32,1)`; `--ease-in-out: cubic-bezier(0.77,0,0.175,1)`.
- Active press scales to 0.97. View changes and departure reveals use opacity/translate only, under 300ms, staggered 50ms.
- Hover motion is wrapped in `(hover:hover) and (pointer:fine)`.
- `prefers-reduced-motion: reduce` removes transforms, animation, and smooth transitions.

## Decisions
- Keep all transit data, labels, actions, IDs, and JavaScript behavior intact.
- Use live data as the product artwork instead of adding stock or decorative illustration.
- Preserve route and delay colors only where they encode real data.
