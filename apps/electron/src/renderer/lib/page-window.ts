/**
 * Standalone Page window mode.
 *
 * The main process opens these as real OS windows (frameless BrowserWindows)
 * with `windowMode=page&pageSlug=<slug>`; the renderer then mounts only the
 * PageView shell instead of the full AppShell.
 */

export const PAGE_WINDOW_MODE_PARAM = 'windowMode'
export const PAGE_WINDOW_MODE = 'page'
export const PAGE_WINDOW_SLUG_PARAM = 'pageSlug'

export function isPageWindowMode(location: Pick<Location, 'search'> = window.location): boolean {
  return new URLSearchParams(location.search).get(PAGE_WINDOW_MODE_PARAM) === PAGE_WINDOW_MODE
}

export function pageSlugFromLocation(
  location: Pick<Location, 'search'> = window.location,
): string | null {
  const slug = new URLSearchParams(location.search).get(PAGE_WINDOW_SLUG_PARAM)
  return slug && slug.trim() ? slug : null
}
