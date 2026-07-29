/**
 * Cloudflare Web Analytics.
 *
 * The beacon is cookieless: it writes nothing to the visitor's device and
 * builds no cross-site profile, so ePrivacy Art. 5(3) — the clause that
 * compels consent banners — never applies. We ask anyway and load the beacon
 * only on a "granted" answer, which makes consent (GDPR Art. 6(1)(a)) the
 * legal basis for the one field Cloudflare does receive: the IP address it
 * turns into a country and discards.
 */

/** Public site tag. Visible in page source; Cloudflare scopes it by hostname. */
export const CF_BEACON_TOKEN = '5f8aa38a1203463d881387cfc4eb0bb4'

export const CF_BEACON_SRC =
  'https://static.cloudflareinsights.com/beacon.min.js'

/**
 * localStorage key holding the answer. Local storage rather than a cookie
 * keeps the site cookie-free; storing the answer is what lets us stop asking,
 * so it is strictly necessary and needs no consent of its own. Bump the
 * version to re-ask every visitor after a material change to what we measure.
 */
export const CONSENT_STORAGE_KEY = 'fp-consent:v1'

export const CONSENT_GRANTED = 'granted'
export const CONSENT_DENIED = 'denied'

/** Last substantive change to the privacy page, rendered per locale. */
export const PRIVACY_UPDATED = '2026-07-29'
