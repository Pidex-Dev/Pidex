import React, { useCallback, useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'

import {
  findExternalFontByFamily,
  type DesktopExternalFontState,
} from '@pidex/shared/desktop-external-fonts'
import { APP_ICON_SIZES } from '../../components/ui/IconTokens.js'
import type { DesktopThemeFontFace } from '../../../shared/Types.js'
import {
  downloadExternalFont,
  ensureExternalFontLoaded,
  listExternalFonts,
} from '../theme/ThemeExternalFonts.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import {
  SYSTEM_DEFAULT_FAMILY_VALUE,
  buildFamilyOptions,
  buildWeightOptions,
  faceForExternalWeight,
  fontPickerCurrentFamilyValue,
  selectedWeightValue,
  type FontPickerKind,
} from './ThemeFontPickerModel.js'

type ThemeFontPickerProps = {
  ariaLabel: string
  placeholder?: string
  family: string | null
  face: DesktopThemeFontFace | null
  kind: FontPickerKind
  controls?: 'family' | 'style' | 'both'
  onCommit: (family: string | null, face: DesktopThemeFontFace | null) => void
}

export function ThemeFontPicker({
  ariaLabel,
  family,
  face,
  kind,
  controls = 'both',
  onCommit,
}: ThemeFontPickerProps): React.ReactNode {
  const [externalFonts, setExternalFonts] = useState<readonly DesktopExternalFontState[]>([])
  const [downloadingFontName, setDownloadingFontName] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.DesktopBridge?.listExternalFonts) return
    let active = true
    void listExternalFonts().then((states) => {
      if (active) setExternalFonts(states)
    })
    return () => {
      active = false
    }
  }, [])

  const handleOpenChange = useCallback((open: boolean): void => {
    if (!open) return
    if (typeof window !== 'undefined' && window.DesktopBridge?.listExternalFonts) {
      void listExternalFonts(true).then((states) => setExternalFonts(states))
    }
  }, [])

  const currentFamilyValue = fontPickerCurrentFamilyValue(family, kind)
  const selectedExternalSpec =
    currentFamilyValue !== SYSTEM_DEFAULT_FAMILY_VALUE
      ? findExternalFontByFamily(currentFamilyValue)
      : undefined
  const selectedExternalState = selectedExternalSpec
    ? externalFonts.find((item) => item.id === selectedExternalSpec.id)
    : undefined
  const showWeightControl =
    controls !== 'family' &&
    Boolean(selectedExternalSpec) &&
    selectedExternalState?.status === 'downloaded'

  if (controls === 'style') {
    if (!showWeightControl || !selectedExternalSpec) return null
    return (
      <SettingsDropdown
        ariaLabel={`${ariaLabel}字重`}
        disabled={downloadingFontName !== null}
        options={buildWeightOptions(selectedExternalSpec)}
        size="sm"
        triggerClassName="appearance-font-style"
        value={selectedWeightValue(selectedExternalSpec, face)}
        onChange={(weightValue) =>
          onCommit(selectedExternalSpec.family, faceForExternalWeight(selectedExternalSpec, weightValue))
        }
      />
    )
  }

  const familyOptions = buildFamilyOptions({ kind, externalFonts }).map((option) => {
    if (option.externalStatus === 'not-downloaded' || option.externalStatus === 'error') {
      return {
        ...option,
        trailing: <Download size={APP_ICON_SIZES.sm} aria-hidden="true" />,
        title: `${option.label}（点击下载）`,
      }
    }
    if (option.externalStatus === 'downloading') {
      return {
        ...option,
        trailing: <Loader2 className="tw:animate-spin" size={APP_ICON_SIZES.sm} aria-hidden="true" />,
        title: `${option.label}（正在下载…）`,
      }
    }
    return option
  })

  const handleFamilyChange = (familyValue: string): void => {
    setDownloadError(null)
    if (familyValue === SYSTEM_DEFAULT_FAMILY_VALUE) {
      onCommit(null, null)
      return
    }
    const external = externalFonts.find(
      (item) => item.kind === kind && item.family === familyValue,
    )
    if (!external) {
      onCommit(null, null)
      return
    }
    if (external.status === 'downloading') return
    if (external.status !== 'downloaded') {
      setDownloadingFontName(external.displayName)
      setExternalFonts((prev) =>
        prev.map((item) =>
          item.id === external.id ? { ...item, status: 'downloading', error: null } : item,
        ),
      )
      void downloadExternalFont(external.id)
        .then((result) => {
          setExternalFonts((prev) =>
            prev.map((item) => (item.id === external.id ? result.state : item)),
          )
          if (result.ok) {
            onCommit(external.family, null)
          } else {
            const message = 'error' in result ? result.error : '字体下载失败'
            setDownloadError(`下载失败：${message}`)
          }
        })
        .finally(() => {
          setDownloadingFontName((current) =>
            current === external.displayName ? null : current,
          )
        })
      return
    }
    void ensureExternalFontLoaded(external.id)
    onCommit(external.family, null)
  }

  return (
    <div
      aria-busy={downloadingFontName !== null}
      className="appearance-theme-font-row tw:inline-flex tw:w-max tw:max-w-full tw:min-w-0 tw:flex-wrap tw:items-center tw:gap-2"
    >
      {downloadingFontName ? (
        <span className="tw:text-app-text-meta tw:type-caption">
          正在下载 {downloadingFontName}…
        </span>
      ) : downloadError ? (
        <span className="tw:text-app-danger tw:type-caption">{downloadError}</span>
      ) : null}
      <SettingsDropdown
        ariaLabel={`${ariaLabel}字体家族`}
        disabled={downloadingFontName !== null}
        options={familyOptions}
        triggerClassName="appearance-font-family"
        value={currentFamilyValue}
        size="md"
        onChange={handleFamilyChange}
        onOpenChange={handleOpenChange}
      />
      {showWeightControl && selectedExternalSpec ? (
        <SettingsDropdown
          ariaLabel={`${ariaLabel}字重`}
          disabled={downloadingFontName !== null}
          options={buildWeightOptions(selectedExternalSpec)}
          size="sm"
          triggerClassName="appearance-font-style"
          value={selectedWeightValue(selectedExternalSpec, face)}
          onChange={(weightValue) =>
            onCommit(
              selectedExternalSpec.family,
              faceForExternalWeight(selectedExternalSpec, weightValue),
            )
          }
        />
      ) : null}
    </div>
  )
}
