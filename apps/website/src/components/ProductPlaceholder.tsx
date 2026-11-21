import React from 'react'

interface ProductPlaceholderProps {
  label: string
  aspectRatio?: '16:10' | '16:9' | '4:3' | '3:2'
  imageSrc?: string
  alt?: string
  caption?: string
  badge?: string
  className?: string
  frame?: 'hero' | 'surface'
  windowTitle?: string
}

const ASPECT_RATIO_CLASSES = {
  '16:10': 'aspect-[16/10]',
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
}

const FRAME_CLASSES = {
  hero: 'rounded-t-[20px] rounded-b-none border-white/10 bg-[#1d2021] shadow-[0_26px_80px_rgba(0,0,0,0.28)]',
  surface: 'rounded-[24px] border-white/12 bg-[#101111] shadow-[0_24px_70px_rgba(0,0,0,0.45)]',
}

export const ProductPlaceholder: React.FC<ProductPlaceholderProps> = ({
  label,
  aspectRatio = '16:10',
  imageSrc,
  alt = 'Pidex product preview',
  badge,
  className = '',
  frame = 'surface',
  windowTitle = 'Pidex — Local Workspace',
}) => {
  const aspectClass = ASPECT_RATIO_CLASSES[aspectRatio]
  const frameClass = FRAME_CLASSES[frame]

  return (
    <div
      className={`product-media group relative overflow-hidden border ${frameClass} ${className}`}
      role="region"
      aria-label={label}
    >
      {/* Pseudo-Window Top Chrome / Titlebar */}
      <div className="flex h-10 items-center justify-between border-b border-white/8 bg-[#242626] px-4 sm:px-5">
        {/* Window controls */}
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-white/12" />
          <span className="h-2 w-2 rounded-full bg-white/12" />
          <span className="h-2 w-2 rounded-full bg-white/12" />
        </div>

        {/* Window Title / Context */}
        <div className="truncate px-2 text-center font-mono text-[10px] font-medium tracking-wide text-white/35">
          {windowTitle}
        </div>

        {/* Aspect Ratio Badge */}
        <div className="flex items-center gap-1.5">
          {badge ? (
            <span className="font-mono text-[9px] text-white/35">{badge}</span>
          ) : (
            <span className="w-8" />
          )}
        </div>
      </div>

      {/* Main Container */}
      <div className={`relative w-full ${aspectClass} overflow-hidden bg-[#202324]`}>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={alt}
            loading="lazy"
            className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.01]"
          />
        ) : (
          <div
            className="product-media-fill h-full w-full"
            data-asset-slot={label}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  )
}
