import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { SettingsContentArea } from '../SettingsContentArea.js'
import { LocalEnvironmentProjectSettings } from './LocalEnvironmentProjectSettings.js'

type Props = {
  onError: (message: string) => void
  onNotice?: (message: string) => void
}

export function EnvironmentPage({ onError, onNotice }: Props): React.ReactNode {
  const [params] = useSearchParams()
  const projectId = params.get('projectId')
  const threadId = params.get('threadId')

  return (
    <SettingsContentArea>
      <div className="settings-content-inner tw:w-full tw:min-w-0 tw:mx-auto tw:p-5 tw:max-w-[calc(var(--page-content-max-width)+var(--cpx-sys-space-6)*2)]">
        {!projectId && !threadId ? (
          <>
            <h2 className="tw:m-0 tw:mb-3 tw:type-7 tw:weight-bold tw:text-app-text">环境</h2>
            <p className="tw:m-0 tw:mb-5 tw:type-1 tw:text-app-text-soft">
              本地环境用于设置项目工作树及启动操作。
            </p>
          </>
        ) : null}
        <React.Suspense fallback={<p>正在加载环境设置…</p>}>
          <LocalEnvironmentProjectSettings onError={onError} onNotice={onNotice} />
        </React.Suspense>
      </div>
    </SettingsContentArea>
  )
}
