import { extendTailwindMerge } from 'tailwind-merge'
import { cx, type ClassValue } from './Cx.js'

const mergeClasses = extendTailwindMerge<'type-role' | 'weight-role' | 'arbitrary..font'>({
  prefix: 'tw',
  extend: {
    classGroups: {
      'type-role': [
        {
          type: ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'code'],
        },
      ],
      'weight-role': [
        {
          weight: ['light', 'regular', 'medium', 'bold'],
        },
      ],
      size: [{ size: ['icon', 'icon-sm', 'icon-md', 'icon-lg'] }],
    },
    // Both a typography role and [font:...] own the complete font shorthand.
    conflictingClassGroups: {
      'type-role': ['arbitrary..font'],
      'arbitrary..font': ['type-role'],
    },
  },
})

export function cn(...values: readonly ClassValue[]): string {
  return mergeClasses(cx(...values))
}
