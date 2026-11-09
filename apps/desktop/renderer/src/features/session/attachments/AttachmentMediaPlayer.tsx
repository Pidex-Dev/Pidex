import { Popover } from '../../../components/ui/floating/Popover.js'
import * as Slider from '@radix-ui/react-slider'
import {
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Button } from '../../../components/ui/Button.js'
import { APP_ICON_SIZE } from '../../../components/ui/IconTokens.js'
import { Select } from '../../../components/ui/Select.js'

function mediaTime(seconds: number): string {
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole / 60) % 60
  const tail = String(whole % 60).padStart(2, '0')
  return hours ? [hours, String(minutes).padStart(2, '0'), tail].join(':') : minutes + ':' + tail
}

function MediaSlider({
  label,
  value,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <Slider.Root
      className="tw:relative tw:flex tw:h-6 tw:min-w-0 tw:flex-1 tw:touch-none tw:items-center"
      min={0}
      max={max || 1}
      step={step}
      value={[value]}
      disabled={max === 0}
      onValueChange={([next]) => {
        if (next !== undefined) onChange(next)
      }}
    >
      <Slider.Track className="tw:relative tw:h-0.5 tw:grow tw:rounded-full tw:bg-app-border">
        <Slider.Range className="tw:absolute tw:h-full tw:rounded-full tw:bg-app-text" />
      </Slider.Track>
      <Slider.Thumb
        aria-label={label}
        className="tw:block tw:size-2 tw:rounded-full tw:bg-app-text tw:outline-offset-2"
      />
    </Slider.Root>
  )
}

export function AttachmentMediaPlayer({
  kind,
  name,
  source,
  onError,
}: {
  kind: 'video' | 'audio'
  name: string
  source: string
  onError: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLMediaElement | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [paused, setPaused] = useState(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState('1')
  const [fullscreen, setFullscreen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  useEffect(() => {
    const node = root.current
    if (!node) return
    const doc = node.ownerDocument
    const sync = () => {
      setFullscreen(doc.fullscreenElement === node)
      setVolumeOpen(false)
    }
    doc.addEventListener('fullscreenchange', sync)
    return () => doc.removeEventListener('fullscreenchange', sync)
  }, [])
  const [actionFailed, setActionFailed] = useState(false)
  const bindMedia = useCallback((node: HTMLMediaElement | null) => {
    media.current = node
    if (!node) return
    return () => {
      node.pause()
      media.current = null
    }
  }, [])
  const run = (action: () => Promise<unknown>) => {
    setActionFailed(false)
    void action().catch(() => setActionFailed(true))
  }
  const togglePlayback = () => {
    const node = media.current
    if (!node) return
    if (node.paused) run(() => node.play())
    else node.pause()
  }
  const updateDuration = ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) =>
    setDuration(Number.isFinite(currentTarget.duration) ? currentTarget.duration : 0)
  const seek = (next: number) => {
    if (!media.current || !duration) return
    media.current.currentTime = Math.min(duration, Math.max(0, next))
    setTime(media.current.currentTime)
  }
  const mediaProps = {
    ref: bindMedia,
    src: source,
    preload: 'metadata' as const,
    'aria-label': name,
    onLoadedMetadata: updateDuration,
    onDurationChange: updateDuration,
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) =>
      setTime(event.currentTarget.currentTime),
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEnded: () => setPaused(true),
    onVolumeChange: ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) => {
      setMuted(currentTarget.muted)
      setVolume(currentTarget.volume)
    },
    onRateChange: ({ currentTarget }: SyntheticEvent<HTMLMediaElement>) =>
      setRate(String(currentTarget.playbackRate)),
    onError,
  }
  const video = kind === 'video'
  const FullscreenIcon = fullscreen ? Minimize2 : Maximize2
  const PlayIcon = paused ? Play : Pause
  const VolumeIcon = muted || volume === 0 ? VolumeX : Volume2
  return (
    <div
      ref={root}
      data-attachment-media-player
      className="tw:flex tw:min-h-0 tw:w-full tw:flex-1 tw:flex-col tw:justify-center tw:overflow-hidden tw:bg-app-canvas"
      onKeyDown={(event) => {
        if (event.target !== root.current && event.target !== media.current) return
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          togglePlayback()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          seek(time + (event.key === 'ArrowRight' ? 5 : -5))
        }
      }}
    >
      {video ? (
        <div className="tw:relative tw:flex tw:min-h-0 tw:flex-1 tw:items-center tw:justify-center tw:overflow-hidden">
          <video
            {...mediaProps}
            playsInline
            tabIndex={0}
            onClick={togglePlayback}
            className="tw:h-full tw:min-h-0 tw:w-full tw:cursor-pointer tw:object-contain"
          />
          {paused ? (
            <Button
              isIconOnly
              shape="pill"
              size="lg"
              aria-label="播放视频"
              onClick={togglePlayback}
              className="tw:absolute tw:bg-app-canvas"
            >
              <Play size={APP_ICON_SIZE} />
            </Button>
          ) : null}
        </div>
      ) : (
        <audio {...mediaProps} />
      )}
      <div
        role="group"
        aria-label="媒体播放控件"
        className="tw:flex tw:shrink-0 tw:flex-wrap tw:items-center tw:gap-2 tw:border-t tw:border-app-border tw:px-2 tw:py-1"
      >
        <Button
          isIconOnly
          size="toolbar"
          color="ghostSecondary"
          aria-label={paused ? '播放' : '暂停'}
          onClick={togglePlayback}
        >
          <PlayIcon size={APP_ICON_SIZE} />
        </Button>
        <div className="tw:flex tw:min-w-16 tw:flex-1">
          <MediaSlider
            label="播放进度"
            value={Math.min(time, duration)}
            max={duration}
            step={0.1}
            onChange={seek}
          />
        </div>
        <span className="tw:shrink-0 tw:tabular-nums tw:type-caption tw:text-app-text-meta">
          {mediaTime(time)} / {mediaTime(duration)}
        </span>
        <Popover.Root open={volumeOpen} onOpenChange={setVolumeOpen}>
          <Popover.Trigger asChild>
            <Button isIconOnly size="toolbar" color="ghostSecondary" aria-label="音量设置">
              <VolumeIcon size={APP_ICON_SIZE} />
            </Button>
          </Popover.Trigger>
          <Popover.Portal container={fullscreen ? root.current : undefined}>
            <Popover.Content side="top" align="end" size="sm" aria-label="音量设置">
              <div className="tw:flex tw:w-40 tw:shrink-0 tw:items-center tw:gap-2 tw:p-2">
                <Button
                  isIconOnly
                  size="toolbar"
                  color="ghostSecondary"
                  aria-label={muted ? '取消静音' : '静音'}
                  onClick={() => {
                    if (media.current) media.current.muted = !media.current.muted
                  }}
                >
                  <VolumeIcon size={APP_ICON_SIZE} />
                </Button>
                <MediaSlider
                  label="音量"
                  value={muted ? 0 : volume}
                  max={1}
                  step={0.01}
                  onChange={(next) => {
                    if (!media.current) return
                    media.current.volume = next
                    media.current.muted = false
                  }}
                />
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <Select
          ariaLabel="播放倍速"
          size="sm"
          value={rate}
          options={['0.5', '0.75', '1', '1.25', '1.5', '2'].map((value) => ({
            value,
            label: value + '×',
          }))}
          onValueChange={(next) => {
            if (media.current) media.current.playbackRate = Number(next)
          }}
        />
        {video && typeof document !== 'undefined' && document.pictureInPictureEnabled ? (
          <Button
            isIconOnly
            size="toolbar"
            color="ghostSecondary"
            aria-label="画中画"
            onClick={() => {
              const node = media.current
              if (!(node instanceof HTMLVideoElement)) return
              run(() =>
                document.pictureInPictureElement === node
                  ? document.exitPictureInPicture()
                  : node.requestPictureInPicture(),
              )
            }}
          >
            <PictureInPicture2 size={APP_ICON_SIZE} />
          </Button>
        ) : null}
        {video && typeof document !== 'undefined' && document.fullscreenEnabled ? (
          <Button
            isIconOnly
            size="toolbar"
            color="ghostSecondary"
            aria-label={fullscreen ? '退出全屏' : '进入全屏'}
            title={fullscreen ? '退出全屏' : '进入全屏'}
            onClick={() => {
              const node = root.current
              if (node)
                run(() =>
                  node.ownerDocument.fullscreenElement === node
                    ? node.ownerDocument.exitFullscreen()
                    : node.requestFullscreen(),
                )
            }}
          >
            <FullscreenIcon size={APP_ICON_SIZE} />
          </Button>
        ) : null}
      </div>
      {actionFailed ? (
        <p role="status" className="tw:px-2 tw:type-caption">
          播放操作未完成，请重试。
        </p>
      ) : null}
    </div>
  )
}
