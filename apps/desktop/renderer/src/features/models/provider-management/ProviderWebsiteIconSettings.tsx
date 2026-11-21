import { Globe, RotateCcw, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { APP_ICON_SIZES } from '../../../components/ui/IconTokens.js'
import { Input } from '../../../components/ui/Input.js'
import { useProviderIconSource } from '../../../services/desktop-client/ProviderIconClient.js'
import { toUserErrorMessage } from '../../../utils/Errors.js'
import { ProviderIcon } from '../ProviderIcon.js'
import { readProviderIconUpload } from './ProviderIconUpload.js'
import { ProviderPanelActionButton } from './ProviderPanelActionButton.js'

export function ProviderWebsiteIconSettings({
  providerID,
  logoURL,
  address,
  draft = false,
  onNotice,
  onError,
}: {
  providerID: string
  logoURL?: string
  address: string
  draft?: boolean
  onNotice: (message: string) => void
  onError: (message: string) => void
}) {
  const [website, setWebsite] = useState(() => {
    try {
      return new URL(address).origin
    } catch {
      return ''
    }
  })
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const bridge = window.DesktopBridge
  const canSetWebsiteIcon = typeof bridge?.setProviderWebsiteIcon === 'function'
  const canUploadIcon = typeof bridge?.setProviderUploadedIcon === 'function'
  const { override } = useProviderIconSource(
    draft ? undefined : logoURL,
    draft ? undefined : providerID,
  )
  const hasCustomIcon = typeof bridge?.resolveProviderIcon === 'function' ? override : true
  if (!draft && (!bridge || !canSetWebsiteIcon)) return null

  async function update(restore: boolean) {
    if (draft || !bridge?.setProviderWebsiteIcon) return
    setBusy(true)
    try {
      await bridge.setProviderWebsiteIcon({
        providerID,
        ...(restore ? {} : { website: website.trim() }),
      })
      onNotice(restore ? '已恢复默认图标' : '网站图标已保存')
    } catch (error) {
      onError(toUserErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function upload(file: File) {
    if (draft || !bridge?.setProviderUploadedIcon) return
    setBusy(true)
    try {
      const dataURL = await readProviderIconUpload(file)
      await bridge.setProviderUploadedIcon({ providerID, dataURL })
      onNotice('图标已更新')
    } catch (error) {
      onError(toUserErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tw:grid tw:gap-3">
      <div className="tw:flex tw:min-w-0 tw:items-center tw:gap-3">
        <span className="provider-icon-settings-preview tw:flex tw:size-7 tw:shrink-0 tw:items-center tw:justify-center tw:overflow-hidden tw:rounded-4 tw:border tw:border-app-border-subtle tw:bg-app-control">
          {!draft || logoURL ? (
            <ProviderIcon
              providerID={providerID}
              logoURL={logoURL}
              className="tw:size-5"
              imageClassName="tw:object-contain"
            />
          ) : null}
        </span>
        <Input
          aria-label="图标来源网站"
          className="tw:min-w-0 tw:flex-1"
          disabled={busy || draft}
          placeholder="https://example.com"
          title={draft ? '创建供应商后可设置图标' : undefined}
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>
      <div className="tw:flex tw:flex-wrap tw:gap-2">
        {draft || canUploadIcon ? (
          <ProviderPanelActionButton
            disabled={busy || draft}
            icon={<Upload className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />}
            label="上传图片"
            title={draft ? '创建供应商后可上传图标' : '上传图片'}
            onClick={() => fileRef.current?.click()}
          />
        ) : null}
        <ProviderPanelActionButton
          disabled={busy || draft || !website.trim()}
          icon={<Globe className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />}
          label="从网站获取"
          loading={busy}
          title={draft ? '创建供应商后可从网站获取图标' : '从网站获取'}
          onClick={() => void update(false)}
        />
        <ProviderPanelActionButton
          disabled={busy || draft || !hasCustomIcon}
          icon={<RotateCcw className="tw:size-icon-sm" aria-hidden size={APP_ICON_SIZES.sm} />}
          label="恢复默认图标"
          title={
            draft
              ? '创建供应商后可恢复默认图标'
              : !hasCustomIcon
                ? '当前已使用默认图标'
                : '恢复默认图标'
          }
          onClick={() => void update(true)}
        />
      </div>
      <input
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
        disabled={busy}
        ref={fileRef}
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void upload(file)
        }}
      />
    </div>
  )
}
