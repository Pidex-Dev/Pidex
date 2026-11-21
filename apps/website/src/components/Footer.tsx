import React from 'react'
import {
  GITHUB_REPO_URL,
  GITHUB_RELEASES_URL,
  GITHUB_README_URL,
  GITHUB_LICENSE_URL,
  GITHUB_SECURITY_URL,
} from '../constants/Content'
import { ArrowUpRight } from 'lucide-react'

const CURRENT_YEAR = new Date().getFullYear()

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-white/10 bg-[#0a0b0b] py-16 text-sm text-[#a9ada9]">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-10 lg:px-16">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {/* Brand Info */}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#121313] p-2 border border-white/11">
              <img src="/pidex-mark-green.svg" alt="" className="h-full w-full object-contain" />
            </div>
            <div>
              <div className="text-base font-bold text-[#f3f1ec]">Pidex</div>
              <div className="text-xs text-[#a9ada9]">
                Open-source AI coding workbench for Windows.
              </div>
            </div>
          </div>

          {/* Links */}
          <div className="flex flex-wrap items-center gap-6 sm:gap-8 font-medium">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-[#f3f1ec] transition-colors"
            >
              <span>GitHub</span>
              <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
            </a>
            <a
              href={GITHUB_README_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-[#f3f1ec] transition-colors"
            >
              <span>README</span>
              <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
            </a>
            <a
              href={GITHUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-[#f3f1ec] transition-colors"
            >
              <span>Releases</span>
              <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
            </a>
            <a
              href={GITHUB_LICENSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-[#f3f1ec] transition-colors"
            >
              <span>MIT License</span>
              <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
            </a>
            <a
              href={GITHUB_SECURITY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-[#f3f1ec] transition-colors"
            >
              <span>Security</span>
              <ArrowUpRight className="h-3.5 w-3.5 opacity-60" />
            </a>
          </div>
        </div>

        {/* Bottom copyright */}
        <div className="mt-12 pt-8 border-t border-white/11 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
          <div>&copy; {CURRENT_YEAR} Pidex Contributors. Released under the MIT License.</div>
          <div className="font-mono text-[11px] text-[#9daa94]">Current Version: v0.2.0-beta.5</div>
        </div>
      </div>
    </footer>
  )
}
