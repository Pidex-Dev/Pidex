import { useState, type ReactNode } from 'react'
import { GlobalErrorModal } from '../../components/GlobalErrorModal.js'
import { EnvironmentSettings } from '../settings/EnvironmentSettings.js'

export function ProjectsView(): ReactNode {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null)
  return (
    <>
      <GlobalErrorModal message={errorMessage} onDismiss={() => setErrorMessage(null)} />
      <GlobalErrorModal
        message={noticeMessage}
        onDismiss={() => setNoticeMessage(null)}
        tone="status"
      />
      <EnvironmentSettings onError={setErrorMessage} onNotice={setNoticeMessage} />
    </>
  )
}
