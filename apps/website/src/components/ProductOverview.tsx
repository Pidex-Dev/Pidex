import React from 'react'
import { PRODUCT_OVERVIEW } from '../constants/Content'
import { HardDrive, Cpu, GitPullRequest } from 'lucide-react'

const PILLAR_ICONS = [HardDrive, Cpu, GitPullRequest]

export const ProductOverview: React.FC = () => {
  return (
    <section id="product" className="py-24 sm:py-32 border-t border-white/10 text-[#f3f1ec]">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-10 lg:px-16">
        {/* Editorial Section Header */}
        <div className="max-w-3xl">
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-[#9daa94]">
            Product Architecture
          </span>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-[#f3f1ec] sm:text-5xl leading-tight">
            {PRODUCT_OVERVIEW.sectionTitle}
          </h2>
          <p className="mt-6 text-xl sm:text-2xl font-medium text-[#f3f1ec] leading-snug">
            {PRODUCT_OVERVIEW.narrativeLead}
          </p>
          <p className="mt-4 text-base sm:text-lg text-[#a9ada9] leading-relaxed">
            {PRODUCT_OVERVIEW.sectionSubtitle}
          </p>
        </div>

        {/* 3 Narrative Pillar Cards */}
        <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-3">
          {PRODUCT_OVERVIEW.pillars.map((pillar, idx) => {
            const Icon = PILLAR_ICONS[idx % PILLAR_ICONS.length]
            return (
              <div
                key={pillar.title}
                className="group relative flex flex-col justify-between rounded-[28px] border border-white/11 bg-[#121313] p-8 shadow-xs transition-all duration-300 hover:shadow-md hover:-translate-y-1"
              >
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0a0b0b] text-[#9daa94] border border-white/11 transition-transform duration-300 group-hover:scale-105">
                      <Icon className="h-6 w-6" />
                    </div>
                    <span className="rounded-full bg-[#0a0b0b] px-3 py-1 font-mono text-[11px] font-semibold text-[#a9ada9]">
                      {pillar.tag}
                    </span>
                  </div>

                  <h3 className="text-xl font-bold text-[#f3f1ec]">{pillar.title}</h3>

                  <p className="mt-4 text-sm text-[#a9ada9] leading-relaxed">
                    {pillar.description}
                  </p>
                </div>

                <div className="mt-8 pt-6 border-t border-white/11 font-mono text-xs text-[#9daa94] font-medium flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#9daa94]" />
                  <span>Native Windows Execution</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
