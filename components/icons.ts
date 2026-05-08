// Hand-drawn, multi-colored SVG markers for FlashForce.
// Returned as inline SVG strings to feed into Leaflet's L.divIcon({ html }).

// Empty defs (kept for backwards compat). The hand-drawn look comes from
// irregular path quaders + rounded line caps now — the previous feTurbulence
// filter was charming but destroyed pan/zoom performance with 2,000+ markers.
const COMMON_DEFS = ``;

/**
 * 固定測速 — Hand-drawn radar/camera icon, coral + teal accents.
 * If a speed limit is given, a tilted "price-tag" hangs from the camera's
 * bottom-right corner, hand-drawn rope and all.
 */
export function fixedCameraSvg(speedLimit?: number): string {
  const limit = speedLimit ?? null;
  const tag = limit
    ? `
    <!-- string tying tag to camera -->
    <path d="M48 28 l8 6" stroke="#0f1218" stroke-width="1.8" stroke-linecap="round"/>
    <!-- tag body (slightly larger, slanted) -->
    <path d="M52 32 q11 0 22 3 q-1 8 -2 16 q-12 -1 -22 -3 z"
          fill="#fffaeb" stroke="#0f1218" stroke-width="2.2" stroke-linejoin="round"/>
    <!-- tag eyelet -->
    <circle cx="55" cy="35" r="1.6" fill="#0f1218"/>
    <!-- speed limit number -->
    <text x="63" y="46" text-anchor="middle"
          font-family="Patrick Hand, Caveat, sans-serif"
          font-weight="700" font-size="14" fill="#e8431e">${limit}</text>`
    : "";

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="58" viewBox="0 0 80 58" overflow="visible">
  ${COMMON_DEFS}
  <g>
    <!-- camera body -->
    <path d="M10 16 q-1 -2 1 -3 l32 -1 q3 0 4 3 l3 8 q1 3 -2 4 l-32 1 q-4 0 -5 -3 z"
          fill="#ff7a59" stroke="#0f1218" stroke-width="2.2" stroke-linejoin="round"/>
    <!-- top viewfinder -->
    <path d="M22 13 l4 -6 l12 0 l4 6 z"
          fill="#ffc043" stroke="#0f1218" stroke-width="2" stroke-linejoin="round"/>
    <!-- big lens -->
    <circle cx="36" cy="24" r="9" fill="#22b8a3" stroke="#0f1218" stroke-width="2"/>
    <circle cx="36" cy="24" r="5" fill="#0f1218"/>
    <circle cx="34" cy="22" r="1.6" fill="#fff"/>
    <!-- small flash bulb -->
    <circle cx="16" cy="20" r="2.6" fill="#ffe27a" stroke="#0f1218" stroke-width="1.6"/>
    <!-- speed lines -->
    <path d="M50 9 l6 -2 M52 14 l6 -1 M53 19 l6 0"
          stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" fill="none"/>
    ${tag}
  </g>
</svg>`.trim();
}

/**
 * 科技執法 — sketch AI eye / sensor, blue + violet accents.
 */
export function techEnforcementSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="68" viewBox="0 0 60 68" overflow="visible">
  ${COMMON_DEFS}
  <g>
    <!-- shield-ish base -->
    <path d="M30 6 q12 1 18 6 q-1 22 -18 32 q-17 -10 -18 -32 q6 -5 18 -6 z"
          fill="#3aa9ff" stroke="#0f1218" stroke-width="2.2" stroke-linejoin="round"/>
    <!-- eye -->
    <path d="M14 24 q16 -14 32 0 q-16 14 -32 0 z"
          fill="#fffaeb" stroke="#0f1218" stroke-width="2"/>
    <circle cx="30" cy="24" r="6" fill="#8b5cf6" stroke="#0f1218" stroke-width="2"/>
    <circle cx="30" cy="24" r="2.6" fill="#0f1218"/>
    <circle cx="28.5" cy="22.5" r="1.1" fill="#fff"/>
    <!-- circuit dots -->
    <circle cx="10" cy="14" r="1.8" fill="#22b8a3" stroke="#0f1218" stroke-width="1.2"/>
    <circle cx="50" cy="14" r="1.8" fill="#ffc043" stroke="#0f1218" stroke-width="1.2"/>
    <path d="M10 14 q4 4 8 2 M50 14 q-4 4 -8 2"
          stroke="#0f1218" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  </g>
</svg>`.trim();
}

/**
 * 機動測速 — sketch tripod radar gun, amber + teal accents.
 */
export function mobileTrapSvg(): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="72" viewBox="0 0 60 72" overflow="visible">
  ${COMMON_DEFS}
  <g>
    <!-- radar gun body -->
    <path d="M8 16 q0 -3 3 -3 l28 0 q4 0 5 3 l4 8 q1 3 -3 4 l-30 0 q-4 0 -5 -3 z"
          fill="#ffc043" stroke="#0f1218" stroke-width="2.2" stroke-linejoin="round"/>
    <!-- handle -->
    <path d="M22 28 l4 0 l1 8 l-6 0 z"
          fill="#e8431e" stroke="#0f1218" stroke-width="2" stroke-linejoin="round"/>
    <!-- antenna dish -->
    <path d="M44 14 q8 4 6 12 q-7 -1 -10 -6 z"
          fill="#22b8a3" stroke="#0f1218" stroke-width="2" stroke-linejoin="round"/>
    <!-- waves -->
    <path d="M48 8 q6 6 4 14 M52 6 q8 8 5 18"
          stroke="#8b5cf6" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    <!-- tripod -->
    <path d="M24 36 l-8 22 M28 36 l0 22 M32 36 l8 22"
          stroke="#0f1218" stroke-width="2" stroke-linecap="round" fill="none"/>
    <!-- ground -->
    <path d="M12 60 q16 -2 32 0" stroke="#3aa9ff" stroke-width="2" fill="none" stroke-linecap="round"/>
  </g>
</svg>`.trim();
}

export const ICON_FOR = {
  fixed: (limit?: number) => fixedCameraSvg(limit),
  tech: () => techEnforcementSvg(),
  mobile: () => mobileTrapSvg(),
} as const;
