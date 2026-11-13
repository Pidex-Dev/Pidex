import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, MoreHorizontal, Pencil, Plus, X } from 'lucide-react'
import type {
  DesktopVoiceHandsFreeMode,
  DesktopVoiceLanguage,
  DesktopVoiceRecordingEntry,
} from '../../../shared/Types.js'
import { desktopClient } from '../../services/desktop-client/index.js'
import { Button } from '../../components/ui/Button.js'
import { Input } from '../../components/ui/Input.js'
import { PopoverItem } from '../../components/ui/PopoverItem.js'
import { PopoverMenu } from '../../components/ui/PopoverMenu.js'
import { ToggleSwitch } from '../../components/ui/ToggleSwitch.js'
import { arrayBufferToBase64 } from '../../utils/BinaryEncoding.js'
import { errorMessageOf } from '@pidex/shared/errors'
import { useSpeechStatus } from '../speech/UseSpeechStatus.js'
import {
  clearCachedVoiceRecordingBlobs,
  formatShortcutFromKeyboardEvent,
  getCachedVoiceRecordingBlob,
  prependVoiceRecording,
  removeCachedVoiceRecordingBlob,
} from '../speech/VoiceRecordingCache.js'
import { audioBlobToPcm16Wav } from '../session/composer/SpeechAudio.js'
import { useLocale } from '../i18n/LocaleProvider.js'
import {
  useDesktopSettingsDraftActions,
  useDesktopSettingsDraftValue,
} from './UseDesktopSettings.js'
import { SettingsContentArea } from './SettingsContentArea.js'
import { SettingsDropdown } from './SettingsDropdown.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsSection } from './SettingsSection.js'

const VOICE_LANGUAGE_OPTIONS: Array<{ value: DesktopVoiceLanguage; label: string }> = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'yue', label: '粤语' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]

const HANDS_FREE_MODE_OPTIONS: Array<{ value: DesktopVoiceHandsFreeMode; label: string }> = [
  { value: 'hold-or-double-tap', label: '按住或连按两次' },
  { value: 'toggle', label: '单次按键切换' },
]

function speechStatusLabel(
  status: import('../../services/desktop-client/index.js').DesktopSpeechStatus | null,
  loading: boolean,
): string {
  if (loading && !status) return '检查中…'
  if (!status) return '不可用'
  if (status.state === 'unsupported') return '不支持'
  if (status.state === 'not-installed') return '未安装'
  if (status.state === 'downloading') return '下载中'
  if (status.state === 'installing') return '安装中'
  if (status.state === 'ready') return '已就绪'
  if (status.state === 'transcribing') return '转写中'
  return '出错'
}

function speechStatusDescription(
  status: import('../../services/desktop-client/index.js').DesktopSpeechStatus | null,
  error: string | null,
): string {
  const message = status?.error?.message ?? error
  if (message) return message
  const progress = status?.progress
  if (progress) {
    if (progress.totalBytes) {
      return `SenseVoice 本地运行时 · ${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%`
    }
    return `SenseVoice 本地运行时 · 已接收 ${Math.round(progress.receivedBytes / 1_048_576)} MB`
  }
  return 'SenseVoice Small 在本机离线转写，音频不会发送到云端。'
}

function recordingStatusLabel(status: DesktopVoiceRecordingEntry['status']): string {
  switch (status) {
    case 'saved':
      return '录音已保存'
    case 'cancelled':
      return '录音已取消'
    case 'error':
      return '录音失败'
  }
}

function formatRecordingTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

export function VoiceSettings({ onNotice }: { onNotice?: (message: string) => void }) {
  const { t } = useLocale()
  const draft = useDesktopSettingsDraftActions()
  const preferredInputDeviceId = useDesktopSettingsDraftValue(
    'desktop.voice.preferredInputDeviceId',
  )
  const voiceLanguage = useDesktopSettingsDraftValue('desktop.voice.language')
  const showLiveTranscript = useDesktopSettingsDraftValue('desktop.voice.showLiveTranscript')
  const dictationShortcut = useDesktopSettingsDraftValue('desktop.voice.dictationShortcut')
  const handsFreeMode = useDesktopSettingsDraftValue('desktop.voice.handsFreeMode')
  const recentRecordings = useDesktopSettingsDraftValue('desktop.voice.recentRecordings')
  const dictionary = useDesktopSettingsDraftValue('desktop.voice.dictionary')

  const speech = useSpeechStatus()
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [addingEntry, setAddingEntry] = useState(false)
  const [newEntryText, setNewEntryText] = useState('')
  const newEntryInputRef = useRef<HTMLInputElement | null>(null)

  const refreshAudioInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    setAudioInputs(devices.filter((device) => device.kind === 'audioinput'))
  }, [])

  useEffect(() => {
    void refreshAudioInputs().catch(() => {})
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioInputs)
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshAudioInputs)
    }
  }, [refreshAudioInputs])

  const saveSetting = useCallback(
    <K extends keyof import('../../../shared/Types.js').DesktopStoredSettings>(
      key: K,
      value: import('../../../shared/Types.js').DesktopStoredSettings[K],
    ) => {
      draft.setValue(key, value)
      draft.autoSave()
    },
    [draft],
  )

  useEffect(() => {
    if (!recordingShortcut) return
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingShortcut(false)
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        saveSetting('desktop.voice.dictationShortcut', '')
        setRecordingShortcut(false)
        return
      }
      const formatted = formatShortcutFromKeyboardEvent(event)
      if (!formatted) return
      saveSetting('desktop.voice.dictationShortcut', formatted)
      setRecordingShortcut(false)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [recordingShortcut, saveSetting])

  useEffect(() => {
    if (addingEntry) {
      newEntryInputRef.current?.focus()
    }
  }, [addingEntry])

  const handleRetryRecording = useCallback(
    async (entry: DesktopVoiceRecordingEntry) => {
      const blob = getCachedVoiceRecordingBlob(entry.id)
      if (!blob) {
        onNotice?.('该录音暂无本地音频缓存，请在输入框中重新发起听写。')
        return
      }
      setRetryingId(entry.id)
      try {
        const wav = await audioBlobToPcm16Wav(blob)
        const result = await desktopClient.transcribeSpeech({
          operationId: crypto.randomUUID(),
          audio: {
            mediaType: 'audio/wav',
            encoding: 'base64',
            data: arrayBufferToBase64(wav),
          },
        })
        const transcript = result?.text?.trim() ?? ''
        const updatedEntry: DesktopVoiceRecordingEntry = {
          ...entry,
          status: 'saved',
          durationMs: result?.durationMs ?? entry.durationMs,
          ...(transcript ? { transcript } : {}),
          error: undefined,
        }
        saveSetting(
          'desktop.voice.recentRecordings',
          prependVoiceRecording(recentRecordings, updatedEntry),
        )
        if (transcript && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(transcript).catch(() => {})
          onNotice?.('重新转写成功，文本已复制到剪贴板。')
        } else {
          onNotice?.(transcript ? '重新转写成功。' : '未检测到有效语音内容。')
        }
      } catch (error) {
        onNotice?.(errorMessageOf(error))
      } finally {
        setRetryingId(null)
      }
    },
    [onNotice, recentRecordings, saveSetting],
  )

  const handleCopyTranscript = useCallback(
    async (entry: DesktopVoiceRecordingEntry) => {
      if (!entry.transcript) return
      try {
        await navigator.clipboard.writeText(entry.transcript)
        onNotice?.('已复制转写文本。')
      } catch (error) {
        onNotice?.(error instanceof Error ? error.message : String(error))
      } finally {
        setOpenMenuId(null)
      }
    },
    [onNotice],
  )

  const handleDeleteRecording = useCallback(
    (id: string) => {
      removeCachedVoiceRecordingBlob(id)
      saveSetting(
        'desktop.voice.recentRecordings',
        recentRecordings.filter((item) => item.id !== id),
      )
      setOpenMenuId(null)
    },
    [recentRecordings, saveSetting],
  )

  const handleClearRecordings = useCallback(() => {
    clearCachedVoiceRecordingBlobs()
    saveSetting('desktop.voice.recentRecordings', [])
    setOpenMenuId(null)
  }, [saveSetting])

  const handleAddDictionaryEntry = useCallback(() => {
    const trimmed = newEntryText.trim()
    if (!trimmed) return
    if (dictionary.includes(trimmed)) {
      onNotice?.('词典中已存在该条目。')
      return
    }
    saveSetting('desktop.voice.dictionary', [...dictionary, trimmed])
    setNewEntryText('')
    setAddingEntry(false)
  }, [dictionary, newEntryText, onNotice, saveSetting])

  const handleRemoveDictionaryEntry = useCallback(
    (word: string) => {
      saveSetting(
        'desktop.voice.dictionary',
        dictionary.filter((item) => item !== word),
      )
    },
    [dictionary, saveSetting],
  )

  const modelNotReady = speech.status?.state !== 'ready'

  return (
    <SettingsContentArea>
      <div className="settings-content-inner tw:@container tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-5)*2)]">
        <div className="settings-page-header tw:mt-0 tw:mx-0 tw:mb-8 tw:grid tw:gap-2">
          <h2 className="settings-page-title tw:m-0 tw:type-page-title tw:text-app-text">
            {t('语音')}
          </h2>
        </div>

        <SettingsSection title="常规">
          <SettingsRow
            title="麦克风"
            description="用于语音聊天和听写"
            control={
              <SettingsDropdown
                size="md"
                value={preferredInputDeviceId}
                options={[
                  { value: '', label: '系统默认' },
                  ...audioInputs.map((device, index) => ({
                    value: device.deviceId,
                    label: device.label || `麦克风 ${index + 1}`,
                  })),
                ]}
                onChange={(value) => saveSetting('desktop.voice.preferredInputDeviceId', value)}
                ariaLabel="麦克风"
              />
            }
          />
          <SettingsRow
            title="语言"
            control={
              <SettingsDropdown
                size="md"
                value={voiceLanguage}
                options={VOICE_LANGUAGE_OPTIONS}
                onChange={(value) =>
                  saveSetting('desktop.voice.language', value as DesktopVoiceLanguage)
                }
                ariaLabel="语言"
              />
            }
          />
          {modelNotReady ? (
            <SettingsRow
              title="本地语音模型"
              description={speechStatusDescription(speech.status, speech.error)}
              control={
                <>
                  <span className="settings-row-status tw:text-app-text-soft tw:type-body-sm">
                    {speechStatusLabel(speech.status, speech.loading)}
                  </span>
                  {speech.status?.state === 'error' || speech.status?.state === 'not-installed' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={speech.loading}
                      onClick={() => void speech.install(true)}
                      type="button"
                    >
                      重试
                    </Button>
                  ) : null}
                </>
              }
            />
          ) : null}
        </SettingsSection>

        <SettingsSection bare title="听写">
          <div className="tw:grid tw:gap-3">
            <SettingsSection.Content surface="card">
              <SettingsRow
                title="始终显示实时转写文本"
                control={({ labelledby, describedby }) => (
                  <ToggleSwitch
                    ariaDescribedby={describedby}
                    ariaLabelledby={labelledby}
                    checked={showLiveTranscript}
                    onChange={(checked) => saveSetting('desktop.voice.showLiveTranscript', checked)}
                  />
                )}
              />
            </SettingsSection.Content>

            <SettingsSection.Content surface="card">
              <div className="settings-row tw:min-w-0 tw:bg-transparent tw:px-3 tw:py-2 tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4">
                <div className="settings-row-info tw:min-w-0">
                  <h4 className="settings-row-title tw:m-0 tw:text-app-text tw:type-row-title">
                    {t('听写快捷键')}
                  </h4>
                  <p className="settings-row-desc tw:mt-1 tw:mr-0 tw:mb-0 tw:ml-0 tw:max-w-[68ch] tw:text-app-text-soft tw:type-body-sm">
                    {t('按住即可进行听写，或连按两次启用免提模式')}
                  </p>
                  <button
                    type="button"
                    className="tw:mt-1.5 tw:inline-flex tw:items-center tw:gap-1 tw:border-0 tw:bg-transparent tw:p-0 tw:text-app-text-soft tw:type-body-sm tw:cursor-pointer tw:hover:text-app-text tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen((prev) => !prev)}
                  >
                    <span>{t('高级')}</span>
                    <ChevronRight
                      size={14}
                      className={`tw:transition-transform tw:duration-feedback ${advancedOpen ? 'tw:rotate-90' : ''}`}
                    />
                  </button>
                </div>

                <div className="settings-row-control tw:relative tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:justify-end tw:gap-2">
                  {recordingShortcut ? (
                    <div className="tw:flex tw:items-center tw:gap-2">
                      <span className="tw:rounded-md tw:border tw:border-app-focus tw:bg-app-control tw:px-2.5 tw:py-1 tw:text-app-text tw:type-body-sm">
                        按下快捷键…
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => {
                          saveSetting('desktop.voice.dictationShortcut', '')
                          setRecordingShortcut(false)
                        }}
                      >
                        清除
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => setRecordingShortcut(false)}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="tw:inline-flex tw:items-center tw:gap-1.5 tw:rounded-md tw:border-0 tw:bg-transparent tw:px-2 tw:py-1 tw:text-app-text-soft tw:type-body-sm tw:cursor-pointer tw:hover:bg-app-text/5 tw:hover:text-app-text tw:focus-visible:outline-2 tw:focus-visible:outline-offset-2 tw:focus-visible:outline-app-focus"
                      onClick={() => setRecordingShortcut(true)}
                      aria-label="编辑听写快捷键"
                    >
                      <span>{dictationShortcut || t('关闭')}</span>
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              </div>

              {advancedOpen ? (
                <>
                  <SettingsRow
                    title="免提触发模式"
                    description="设置通过快捷键启动和结束免提听写的交互方式"
                    control={
                      <SettingsDropdown
                        size="md"
                        value={handsFreeMode}
                        options={HANDS_FREE_MODE_OPTIONS}
                        onChange={(value) =>
                          saveSetting(
                            'desktop.voice.handsFreeMode',
                            value as DesktopVoiceHandsFreeMode,
                          )
                        }
                        ariaLabel="免提触发模式"
                      />
                    }
                  />
                  {!modelNotReady ? (
                    <SettingsRow
                      title="本地语音模型"
                      description={speechStatusDescription(speech.status, speech.error)}
                      control={
                        <span className="settings-row-status tw:text-app-text-soft tw:type-body-sm">
                          {speechStatusLabel(speech.status, speech.loading)}
                        </span>
                      }
                    />
                  ) : null}
                  <SettingsRow
                    title="麦克风隐私设置"
                    description="打开 Windows 麦克风权限页面，允许 Pidex 使用输入设备。"
                    control={
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          void desktopClient.openMicrophonePrivacySettings().catch((error) => {
                            onNotice?.(error instanceof Error ? error.message : String(error))
                          })
                        }}
                        type="button"
                      >
                        打开设置
                      </Button>
                    }
                  />
                </>
              ) : null}
            </SettingsSection.Content>

            <SettingsSection.Content surface="card">
              <SettingsRow
                title="最近录音"
                description="你最近的 20 段录音会保存在此设备上"
              />
              {recentRecordings.length === 0 ? (
                <div className="settings-row tw:min-w-0 tw:bg-transparent tw:px-3 tw:py-3 tw:text-app-text-soft tw:type-body-sm">
                  {t('暂无最近录音')}
                </div>
              ) : (
                recentRecordings.map((entry) => (
                  <div
                    key={entry.id}
                    className="settings-row tw:min-w-0 tw:bg-transparent tw:px-3 tw:py-2 tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4"
                  >
                    <div className="settings-row-info tw:min-w-0">
                      <h4 className="settings-row-title tw:m-0 tw:text-app-text tw:type-row-title">
                        {t(recordingStatusLabel(entry.status))}
                      </h4>
                      <p className="settings-row-desc tw:mt-1 tw:mr-0 tw:mb-0 tw:ml-0 tw:truncate tw:text-app-text-soft tw:type-body-sm">
                        {formatRecordingTimestamp(entry.createdAt)}
                        {entry.transcript ? ` · ${entry.transcript}` : ''}
                      </p>
                    </div>
                    <div className="settings-row-control tw:relative tw:flex tw:min-w-0 tw:shrink-0 tw:items-center tw:justify-end tw:gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        disabled={retryingId === entry.id}
                        onClick={() => void handleRetryRecording(entry)}
                      >
                        {retryingId === entry.id ? '重试中…' : '重试'}
                      </Button>
                      <PopoverMenu
                        align="end"
                        open={openMenuId === entry.id}
                        onOpenChange={(open) => setOpenMenuId(open ? entry.id : null)}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            isIconOnly
                            type="button"
                            aria-label="更多操作"
                          >
                            <MoreHorizontal size={16} />
                          </Button>
                        }
                      >
                        <PopoverItem
                          disabled={!entry.transcript}
                          onClick={() => void handleCopyTranscript(entry)}
                        >
                          复制转写文本
                        </PopoverItem>
                        <PopoverItem onClick={() => handleDeleteRecording(entry.id)}>
                          删除记录
                        </PopoverItem>
                        <PopoverItem onClick={handleClearRecordings}>清空全部录音</PopoverItem>
                      </PopoverMenu>
                    </div>
                  </div>
                ))
              )}
            </SettingsSection.Content>

            <SettingsSection.Content surface="card">
              <SettingsRow
                title="听写词典"
                description="听写应能识别的单词或短语"
                control={
                  <Button
                    size="sm"
                    variant="secondary"
                    type="button"
                    onClick={() => setAddingEntry(true)}
                  >
                    <Plus size={14} />
                    <span>添加条目</span>
                  </Button>
                }
              />
              {addingEntry ? (
                <div className="settings-row tw:min-w-0 tw:bg-transparent tw:px-3 tw:py-2 tw:flex tw:items-center tw:gap-2">
                  <Input
                    ref={newEntryInputRef}
                    className="tw:flex-1"
                    size="sm"
                    placeholder="输入单词或短语，例如 Pidex、TypeScript"
                    value={newEntryText}
                    onChange={(event) => setNewEntryText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleAddDictionaryEntry()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setAddingEntry(false)
                        setNewEntryText('')
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    type="button"
                    disabled={!newEntryText.trim()}
                    onClick={handleAddDictionaryEntry}
                  >
                    添加
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setAddingEntry(false)
                      setNewEntryText('')
                    }}
                  >
                    取消
                  </Button>
                </div>
              ) : null}
              {dictionary.map((word) => (
                <div
                  key={word}
                  className="settings-row tw:min-w-0 tw:bg-transparent tw:px-3 tw:py-2 tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4"
                >
                  <span className="tw:truncate tw:text-app-text tw:type-body-sm">{word}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    isIconOnly
                    type="button"
                    aria-label={`删除 ${word}`}
                    onClick={() => handleRemoveDictionaryEntry(word)}
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
            </SettingsSection.Content>
          </div>
        </SettingsSection>
      </div>
    </SettingsContentArea>
  )
}
