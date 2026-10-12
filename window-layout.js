/** Pure geometry for the floating request-diff window.
 * Kept separate from the DOM code so the mobile sizing rules are unit-testable.
 * All values are CSS pixels in the visual viewport coordinate space.
 */
export const MIN_WIDTH = 240;
export const MIN_HEIGHT = 180;
const EDGE = 8;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

/** A window that always leaves a draggable header on screen, even on tiny viewports. */
export function defaultLayout(viewport) {
    const width = Math.max(1, Math.round(viewport?.width ?? 0));
    const height = Math.max(1, Math.round(viewport?.height ?? 0));
    const narrow = width <= 600;
    const winWidth = narrow ? Math.max(MIN_WIDTH, width - EDGE * 2) : clamp(920, MIN_WIDTH, width - EDGE * 2);
    // On a phone this must be most of the visible height, not a thin strip.
    const winHeight = narrow ? Math.max(MIN_HEIGHT, height - EDGE * 2) : clamp(Math.round(height * 0.88), MIN_HEIGHT, height - EDGE * 2);
    const left = narrow ? EDGE : clamp(Math.round((width - winWidth) / 2), EDGE, Math.max(EDGE, width - winWidth - EDGE));
    const top = EDGE;
    return { left, top, width: winWidth, height: winHeight };
}

/** Clamp a user-chosen geometry so it stays usable inside the current viewport. */
export function clampLayout(layout, viewport) {
    const viewWidth = Math.max(1, Math.round(viewport?.width ?? 0));
    const viewHeight = Math.max(1, Math.round(viewport?.height ?? 0));
    const width = clamp(Math.round(layout.width), MIN_WIDTH, Math.max(MIN_WIDTH, viewWidth - EDGE));
    const height = clamp(Math.round(layout.height), MIN_HEIGHT, Math.max(MIN_HEIGHT, viewHeight - EDGE));
    const left = clamp(Math.round(layout.left), 0, Math.max(0, viewWidth - width));
    const top = clamp(Math.round(layout.top), 0, Math.max(0, viewHeight - height));
    return { left, top, width, height };
}