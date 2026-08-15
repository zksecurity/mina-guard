/**
 * MinaGuard brand mark — translucent glass cube with the interior consensus
 * triangle + three signer nodes. Self-contained SVG (gradients / filters /
 * clip-paths inlined with `mg`-prefixed ids to avoid collisions). Size via
 * `className` (defaults to a header-friendly height); aspect ratio is fixed by
 * the viewBox.
 */
export default function CubeLogo({ className = 'h-9 w-auto' }: { className?: string }) {
  return (
    <svg
      viewBox="-70 -80 140 172"
      className={className}
      role="img"
      aria-label="MinaGuard"
    >
      <defs>
        <linearGradient id="mgInterior" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#CDD3F2" />
          <stop offset="55%" stopColor="#8A78DE" />
          <stop offset="100%" stopColor="#5F4DC2" />
        </linearGradient>
        <linearGradient id="mgTop" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E9EEF9" />
          <stop offset="55%" stopColor="#C9D6F2" />
          <stop offset="100%" stopColor="#AFBBEA" />
        </linearGradient>
        <linearGradient id="mgRight" x1="0%" y1="0%" x2="15%" y2="100%">
          <stop offset="0%" stopColor="#F7A25F" />
          <stop offset="45%" stopColor="#E0743A" />
          <stop offset="100%" stopColor="#C25320" />
        </linearGradient>
        <linearGradient id="mgLeft" x1="0%" y1="0%" x2="15%" y2="100%">
          <stop offset="0%" stopColor="#9683EC" />
          <stop offset="55%" stopColor="#7159D6" />
          <stop offset="100%" stopColor="#5643BD" />
        </linearGradient>

        <filter id="mgBloom" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id="mgSoft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="mgGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id="mgGrainD" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.8 0.8 0.8 0 0" />
        </filter>
        <filter id="mgGrainL" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="42" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.8 0.8 0.8 0 0" />
        </filter>

        <clipPath id="mgClipCube">
          <polygon points="0,-75 65,-37.5 65,37.5 0,75 -65,37.5 -65,-37.5" />
        </clipPath>
        <clipPath id="mgClipTop">
          <polygon points="0,-75 65,-37.5 0,0 -65,-37.5" />
        </clipPath>
        <clipPath id="mgClipRight">
          <polygon points="65,-37.5 65,37.5 0,75 0,0" />
        </clipPath>
        <clipPath id="mgClipLeft">
          <polygon points="-65,-37.5 -65,37.5 0,75 0,0" />
        </clipPath>
      </defs>

      {/* drop shadow */}
      <ellipse cx="0" cy="86" rx="50" ry="9" fill="#6A58CC" opacity="0.25" filter="url(#mgSoft)" />

      <g clipPath="url(#mgClipCube)">
        <rect x="-70" y="-80" width="140" height="160" fill="url(#mgInterior)" />
        <ellipse cx="-30" cy="-35" rx="34" ry="26" fill="#E8A585" opacity="0.4" filter="url(#mgBloom)" />
        <ellipse cx="15" cy="50" rx="38" ry="30" fill="#6A55CC" opacity="0.5" filter="url(#mgBloom)" />

        {/* interior mesh edges */}
        <g stroke="#7C6AD8" strokeWidth="1.2" opacity="0.35" fill="none">
          <line x1="0" y1="0" x2="0" y2="-75" />
          <line x1="0" y1="0" x2="-65" y2="37.5" />
          <line x1="0" y1="0" x2="65" y2="37.5" />
        </g>

        {/* consensus triangle + signer nodes (glow) */}
        <g filter="url(#mgGlow)" opacity="0.9">
          <polygon points="0,-37.5 -32.5,18.75 32.5,18.75" fill="none" stroke="#FFFFFF" strokeWidth="4" />
          <circle cx="0" cy="-37.5" r="9" fill="#FFFFFF" />
          <circle cx="-32.5" cy="18.75" r="9" fill="#FFFFFF" />
          <circle cx="32.5" cy="18.75" r="9" fill="#FFFFFF" />
        </g>
        <polygon points="0,-37.5 -32.5,18.75 32.5,18.75" fill="none" stroke="#FFFFFF" strokeWidth="2.2" />
        <circle cx="0" cy="-37.5" r="6.5" fill="#FFFFFF" />
        <circle cx="-32.5" cy="18.75" r="6.5" fill="#FFFFFF" />
        <circle cx="32.5" cy="18.75" r="6.5" fill="#FFFFFF" />

        {/* translucent faces */}
        <g opacity="0.70">
          <polygon points="0,-75 65,-37.5 0,0 -65,-37.5" fill="url(#mgTop)" />
          <polygon points="-65,-37.5 -65,37.5 0,75 0,0" fill="url(#mgLeft)" />
          <polygon points="65,-37.5 65,37.5 0,75 0,0" fill="url(#mgRight)" />

          <g clipPath="url(#mgClipTop)">
            <ellipse cx="-36" cy="-42" rx="26" ry="16" fill="#F4B49B" opacity="0.8" filter="url(#mgBloom)" />
            <ellipse cx="28" cy="-52" rx="24" ry="14" fill="#FFFFFF" opacity="0.55" filter="url(#mgBloom)" />
            <ellipse cx="8" cy="-12" rx="22" ry="12" fill="#9BA6E8" opacity="0.5" filter="url(#mgBloom)" />
          </g>
          <g clipPath="url(#mgClipRight)">
            <ellipse cx="38" cy="-22" rx="26" ry="18" fill="#FBBA79" opacity="0.7" filter="url(#mgBloom)" />
            <ellipse cx="12" cy="58" rx="22" ry="18" fill="#8B6FE0" opacity="0.45" filter="url(#mgBloom)" />
            <ellipse cx="58" cy="28" rx="20" ry="20" fill="#A8451A" opacity="0.5" filter="url(#mgBloom)" />
          </g>
          <g clipPath="url(#mgClipLeft)">
            <ellipse cx="-42" cy="-24" rx="22" ry="16" fill="#C983C6" opacity="0.5" filter="url(#mgBloom)" />
            <ellipse cx="-14" cy="56" rx="26" ry="20" fill="#4633A8" opacity="0.65" filter="url(#mgBloom)" />
            <ellipse cx="-52" cy="20" rx="16" ry="18" fill="#7E68E2" opacity="0.5" filter="url(#mgBloom)" />
          </g>

          <polygon points="0,-75 65,-37.5 0,0 -65,-37.5" fill="#FFFFFF" opacity="0.10" />
          <polygon points="-65,-37.5 -65,37.5 0,75 0,0" fill="#000000" opacity="0.10" />
        </g>

        {/* specular highlight */}
        <ellipse cx="22" cy="-52" rx="24" ry="7" fill="#FFFFFF" opacity="0.4" filter="url(#mgSoft)" transform="rotate(15 22 -52)" />

        {/* grain */}
        <rect x="-70" y="-80" width="140" height="160" filter="url(#mgGrainD)" opacity="0.09" />
        <rect x="-70" y="-80" width="140" height="160" filter="url(#mgGrainL)" opacity="0.11" />
      </g>

      {/* crisp outer + inner edges */}
      <g stroke="#FFFFFF" fill="none">
        <polygon points="0,-75 65,-37.5 65,37.5 0,75 -65,37.5 -65,-37.5" strokeWidth="1.8" opacity="0.55" />
        <line x1="0" y1="0" x2="-65" y2="-37.5" strokeWidth="1.4" opacity="0.5" />
        <line x1="0" y1="0" x2="65" y2="-37.5" strokeWidth="1.4" opacity="0.5" />
        <line x1="0" y1="0" x2="0" y2="75" strokeWidth="1.4" opacity="0.5" />
      </g>
    </svg>
  );
}
