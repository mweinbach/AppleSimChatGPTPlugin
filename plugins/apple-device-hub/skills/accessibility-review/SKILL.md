---
name: accessibility-review
description: Review iOS screens for accessibility with Apple Device Hub — VoiceOver labels and roles, touch targets, Dynamic Type at the largest sizes, dark mode, increased contrast, and reduced motion and transparency — then report concrete fixes. Use when the user asks for an accessibility audit, a VoiceOver check, or Dynamic Type or dark mode testing.
---

# Accessibility review

Follow the device-hub skill for connecting. The element list is what VoiceOver reads; `accessibilityEnabled` only controls whether you receive it and does not turn VoiceOver on.

1. Open the screen to review and call `device_capture` with `screenshot: "always"`; this review is visual, so use it for every capture and settings change below. Record the original `settings` values so you can restore them.
2. Check the elements at the current settings:
   - Buttons, links and images without a label, or labelled with a symbol or file name ("Square grid 3x3", "icon_close").
   - Tappable controls exposed with the wrong role, such as a row reported as StaticText.
   - Visible text or controls missing from the list, which VoiceOver cannot reach.
   - Toggles, sliders and pickers without a value.
   - Controls smaller than 44 × 44 points; each element lists its size after its tap point.
3. Set `textSize` to `accessibility-extra-extra-extra-large`. Look for truncated, clipped or overlapping text and controls pushed off screen, scrolling if the screen scrolls.
4. Set `appearance` to `dark`, then `increasedContrast` to `true`. Look for text or icons that become hard to read.
5. Set `reduceMotion` and `reduceTransparency` to `true` and confirm the screen still works and stays legible.
6. Restore every setting to the value recorded in step 1. If an original value was unknown, tell the user what you left set.

Report findings by severity. For each, name the element (label or ref), what you observed and at which setting, and a fix, for example `.accessibilityLabel("Close")`, `.accessibilityAddTraits(.isButton)`, `@ScaledMetric` spacing, or a layout that wraps instead of truncating at large text sizes.
