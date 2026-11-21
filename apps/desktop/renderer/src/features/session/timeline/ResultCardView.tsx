import React from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Globe2,
  Info,
  Link2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type {
  ResultCard,
  ResultCardReference,
  ResultCardSection,
  ResultCardTone,
} from '@pidex/shared/thread-result-card'

import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { DisclosureContent } from '../../../components/ui/DisclosureContent.js'
import { Tooltip } from '../../../components/ui/Tooltip.js'
import { FileTypeIcon } from '../../layout/FileTypeIcon.js'
import {
  classifyMarkdownTarget,
  formatFileReferenceShortLabel,
  formatFileReferenceTooltip,
  parseMarkdownFileReference,
  type MarkdownFileOpenOptions,
  type MarkdownFileReference,
} from '../../markdown/index.js'
import { ConversationItemContext } from './ConversationItemContext.js'
import { CopyButton } from './CopyButton.js'
import { safeCitationUrl } from './CitationUrl.js'

/** Items beyond this count stay behind the existing disclosure control. */
const VISIBLE_ITEM_LIMIT = 3

/**
 * Tone is never the only status cue: every tone carries a stable icon and a
 * visible text label next to the semantic color.
 */
const TONE_PRESENTATION: Record<ResultCardTone, { icon: LucideIcon; label: string }> = {
  neutral: { icon: Info, label: '信息' },
  success: { icon: Check, label: '成功' },
  warning: { icon: TriangleAlert, label: '需关注' },
  danger: { icon: CircleAlert, label: '风险' },
}

const REFERENCE_ICON: Record<ResultCardReference['kind'], LucideIcon> = {
  file: FileText,
  url: Globe2,
  thread: Link2,
  subagent: Bot,
}

/** Deterministic plain-text projection of a card, used by the copy action. */
export function resultCardPlainText(card: ResultCard): string {
  const lines = [card.title, card.summary]
  for (const section of card.sections) {
    lines.push('', section.title)
    for (const item of section.items) {
      lines.push(`- ${item.value ? `${item.label}：${item.value}` : item.label}`)
    }
  }
  if (card.references.length > 0) {
    lines.push('', '引用')
    for (const reference of card.references) {
      lines.push(
        `- ${reference.label ? `${reference.label}：${reference.value}` : reference.value}`,
      )
    }
  }
  return lines.join('\n')
}

function resultCardFileReference(
  value: string,
  workspacePath: string | null | undefined,
): MarkdownFileReference | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^file:/iu.test(trimmed)) {
    const classified = classifyMarkdownTarget(trimmed)
    if (classified.kind !== 'file') return null
    return {
      path: classified.path,
      ...(classified.line !== undefined ? { line: classified.line } : {}),
      ...(classified.column !== undefined ? { column: classified.column } : {}),
      ...(classified.endLine !== undefined ? { endLine: classified.endLine } : {}),
      ...(classified.endColumn !== undefined ? { endColumn: classified.endColumn } : {}),
    }
  }
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(trimmed)) {
    return parseMarkdownFileReference(trimmed)
  }
  if (!workspacePath) return null
  const parsed = parseMarkdownFileReference(trimmed)
  const normalized = parsed.path.replaceAll('\\', '/').replace(/^\.\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (!parts.length || parts.includes('..')) return null
  return { ...parsed, path: parts.join('/') }
}

/**
 * Parse a ResultCard file reference path: accepts workspace-relative paths
 * when `workspacePath` is known, plus explicit absolute or `file://` paths.
 */
export function resultCardFilePath(
  value: string,
  workspacePath: string | null | undefined,
): string | null {
  return resultCardFileReference(value, workspacePath)?.path ?? null
}

/**
 * Shared result card for a normalized Pidex envelope: main-agent and
 * subagent deliveries and opt-in tool results all render through this view.
 * Semantic `article` / `section` / `dl` / `ul` structure, no actions beyond
 * copying, safe external links and workspace-confirmed file previews.
 */
export function ResultCardView({ card }: { card: ResultCard }): React.ReactNode {
  const conversation = React.useContext(ConversationItemContext)
  const titleId = React.useId()
  const tone = TONE_PRESENTATION[card.tone]
  const ToneIcon = tone.icon
  return (
    <article aria-labelledby={titleId} className="canonical-result-card" data-tone={card.tone}>
      <header className="canonical-result-card__header">
        <ToneIcon
          aria-hidden="true"
          className="canonical-result-card__icon"
          size={APP_ICON_SIZES.lg}
        />
        <h3 className="canonical-result-card__title" id={titleId}>
          {card.title}
        </h3>
        <span className="canonical-result-card__tone">{tone.label}</span>
        <CopyButton ariaLabel="复制结构化结果" text={resultCardPlainText(card)} />
      </header>
      <p className="canonical-result-card__summary">{card.summary}</p>
      {card.sections.map((section, index) => (
        <ResultCardSectionView key={`${index}:${section.title}`} section={section} />
      ))}
      {card.references.length > 0 ? (
        <section aria-label="引用" className="canonical-result-card__section">
          <h4 className="canonical-result-card__section-title">引用</h4>
          <ul className="canonical-result-card__references">
            {card.references.map((reference, index) => (
              <ResultCardReferenceItem
                key={`${index}:${reference.kind}:${reference.value}`}
                onOpenFileReference={conversation?.onOpenFileReference}
                reference={reference}
                workspacePath={conversation?.workspacePath}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  )
}

function ResultCardSectionView({ section }: { section: ResultCardSection }): React.ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  const contentId = React.useId()
  const titleId = React.useId()
  const hiddenItems = section.items.slice(VISIBLE_ITEM_LIMIT)
  const hiddenCount = hiddenItems.length
  return (
    <section aria-labelledby={titleId} className="canonical-result-card__section">
      <h4 className="canonical-result-card__section-title" id={titleId}>
        {section.title}
      </h4>
      <dl className="canonical-result-card__items">
        {section.items.slice(0, VISIBLE_ITEM_LIMIT).map((item, index) => (
          <ResultCardItemView item={item} key={`${index}:${item.label}`} />
        ))}
      </dl>
      {hiddenCount > 0 ? (
        <>
          <DisclosureContent expanded={expanded} id={contentId} mountPolicy="until-exit">
            <dl className="canonical-result-card__items canonical-result-card__items--hidden">
              {hiddenItems.map((item, index) => (
                <ResultCardItemView
                  item={item}
                  key={`${index + VISIBLE_ITEM_LIMIT}:${item.label}`}
                />
              ))}
            </dl>
          </DisclosureContent>
          <button
            aria-controls={contentId}
            aria-expanded={expanded}
            className="canonical-result-card__disclosure"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? '收起' : `再显示 ${hiddenCount} 项`}
            <ChevronDown
              aria-hidden="true"
              className={`tw:size-icon-sm ${expanded ? 'is-expanded' : undefined}`}
              size={APP_ICON_SIZES.sm}
            />
          </button>
        </>
      ) : null}
    </section>
  )
}

function ResultCardItemView({
  item,
}: {
  item: ResultCardSection['items'][number]
}): React.ReactNode {
  return (
    <div className="canonical-result-card__item" data-tone={item.tone ?? 'neutral'}>
      <dt>{item.label}</dt>
      {item.value ? <dd>{item.value}</dd> : null}
    </div>
  )
}

const REFERENCE_TOOLTIP_CLASS =
  'tw:max-w-[min(360px,calc(100vw-16px))] tw:whitespace-pre-wrap tw:break-words tw:[overflow-wrap:anywhere]'

function resolveReferenceDisplayPath(
  referencePath: string,
  workspacePath: string | null | undefined,
): string {
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(referencePath) || !workspacePath?.trim()) {
    return referencePath
  }
  const separator = workspacePath.includes('\\') ? '\\' : '/'
  return `${workspacePath.replace(/[\\/]+$/u, '')}${separator}${referencePath.replace(/^[.][\\/]/u, '')}`
}

function ResultCardReferenceItem({
  onOpenFileReference,
  reference,
  workspacePath,
}: {
  onOpenFileReference?: (reference: MarkdownFileReference, options: MarkdownFileOpenOptions) => void
  reference: ResultCardReference
  workspacePath?: string | null
}): React.ReactNode {
  const Icon = REFERENCE_ICON[reference.kind]
  const text = reference.label ?? reference.value
  if (reference.kind === 'url') {
    const url = safeCitationUrl(reference.value)
    return (
      <li className="canonical-result-card__reference">
        <Icon aria-hidden="true" size={APP_ICON_SIZES.sm} />
        <Tooltip
          className={REFERENCE_TOOLTIP_CLASS}
          content={reference.value}
          side="top"
          variant="default"
        >
          {url ? (
            <a
              className="tw:inline-flex tw:min-h-5 tw:min-w-5 tw:items-center"
              href={url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {text}
            </a>
          ) : (
            <span>{text}</span>
          )}
        </Tooltip>
      </li>
    )
  }
  if (reference.kind === 'file') {
    const parsed = resultCardFileReference(reference.value, workspacePath)
    const label =
      reference.label ?? (parsed ? formatFileReferenceShortLabel(parsed) : reference.value)
    const tooltip = parsed
      ? formatFileReferenceTooltip(parsed, resolveReferenceDisplayPath(parsed.path, workspacePath))
      : reference.value
    if (parsed && onOpenFileReference) {
      return (
        <li className="canonical-result-card__reference">
          <FileTypeIcon path={parsed.path} size={APP_ICON_SIZES.sm} />
          <Tooltip
            className={REFERENCE_TOOLTIP_CLASS}
            content={tooltip}
            side="top"
            variant="default"
          >
            <button
              aria-label={`打开文件 ${label}`}
              className="canonical-result-card__file-link"
              onClick={() => onOpenFileReference(parsed, { preview: true })}
              type="button"
            >
              {label}
            </button>
          </Tooltip>
        </li>
      )
    }
    return (
      <li className="canonical-result-card__reference">
        <FileTypeIcon path={parsed?.path ?? reference.value} size={APP_ICON_SIZES.sm} />
        <Tooltip className={REFERENCE_TOOLTIP_CLASS} content={tooltip} side="top" variant="default">
          <span>{label}</span>
        </Tooltip>
      </li>
    )
  }
  return (
    <li className="canonical-result-card__reference">
      <Icon aria-hidden="true" size={APP_ICON_SIZES.sm} />
      <Tooltip
        className={REFERENCE_TOOLTIP_CLASS}
        content={reference.value}
        side="top"
        variant="default"
      >
        <span>{text}</span>
      </Tooltip>
    </li>
  )
}
