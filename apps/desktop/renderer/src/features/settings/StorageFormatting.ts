export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  if (index === 0) return `${Math.round(value)} B`
  const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${formatted.replace(/\.0$/, '')} ${units[index]}`
}
