import React from 'react'
import { CAPABILITIES } from '../constants/Content'
import { Boxes, Blocks, Globe, Clock, Users2 } from 'lucide-react'

const CAPABILITY_ICONS = [Boxes, Blocks, Globe, Clock, Users2]

export const CapabilitiesGrid: React.FC = () => {
  return (
    <section className="py-24 sm:py-32 border-t border-white/10 text-[#f3f1ec]">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-10 lg:px-16">
        {/* Header */}
        <div className="max-w-2xl">
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-[#9daa94]">
            Extensible Ecosystem
          </span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-[#f3f1ec] sm:text-5xl">
            Engineered for expansion.
          </h2>
          <p className="mt-4 text-base sm:text-lg text-[#a9ada9]">
            Beyond core file manipulation, Pidex integrates protocols, browsers, timers, and
            multi-agent coordination.
          </p>
        </div>

        {/* 5 Capability Cards in an asymmetric modern layout */}
        <div className="mt-16 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {CAPABILITIES.map((item, idx) => {
            const Icon = CAPABILITY_ICONS[idx % CAPABILITY_ICONS.length]
            const isWide = idx === 0 || idx === 1

            return (
              <div
                key={item.title}
                className={`flex flex-col justify-between rounded-[28px] border border-white/11 bg-[#121313] p-8 shadow-2xs transition-all duration-300 hover:shadow-md hover:-translate-y-1 ${
                  isWide && idx === 0 ? 'lg:col-span-2' : ''
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0a0b0b] text-[#9daa94] border border-white/11">
                      <Icon className="h-6 w-6" />
                    </div>
                    <span className="font-mono text-[11px] font-bold tracking-wider text-[#9daa94] bg-[#0a0b0b] px-2.5 py-1 rounded-md">
                      {item.category}
                    </span>
                  </div>

                  <h3 className="text-xl font-bold text-[#f3f1ec]">{item.title}</h3>

                  <p className="mt-3 text-sm text-[#a9ada9] leading-relaxed">{item.description}</p>
                </div>

                <div className="mt-6 pt-4 border-t border-white/11 font-mono text-[11px] text-[#a9ada9]">
                  Native Desktop Bridge
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
