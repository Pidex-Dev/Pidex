import React from 'react'
import { createRoot } from 'react-dom/client'
import {
  installStartupSplashHandoff,
  reportStartupLabel,
  reportStartupFailure,
  PET_OVERLAY_HASH_PREFIX,
} from './startup/StartupSplashHandoff.js'
import {
  publishStartupConnectionSnapshot,
  subscribeStartupConnection,
} from './startup/StartupConnection.js'
import './styles/tailwind.css'

installStartupSplashHandoff()
document.documentElement.dataset.startupEntry = 'loaded'
let mounting = false
async function mountApplication(): Promise<void> {
  if (mounting) return
  mounting = true
  try {
    const [{ App }, { initializeRendererDataEpoch }] = await Promise.all([
      import('./App.js'),
      import('./services/desktop-client/DataEpoch.js'),
    ])
    initializeRendererDataEpoch()
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    console.info('desktop.business-root-mounted')
  } catch {
    reportStartupFailure('界面模块加载失败，请重新加载或查看日志。')
  }
}
const bridge = window.DesktopBridge
if (!window.location.hash.startsWith(PET_OVERLAY_HASH_PREFIX) && bridge) {
  const unsubscribe = subscribeStartupConnection(
    bridge,
    (snapshot) => {
      publishStartupConnectionSnapshot(snapshot)
      if (snapshot.state === 'connected') {
        reportStartupLabel(snapshot.label)
        void mountApplication()
      } else if (snapshot.state === 'failed') {
        reportStartupFailure(snapshot.label, () => {
          void bridge
            .retryStartup(snapshot.generation)
            .catch(() => reportStartupFailure('无法重试连接，请查看日志。'))
        })
      } else {
        reportStartupLabel(snapshot.label)
      }
    },
    () => reportStartupFailure('无法读取启动状态，请重新加载或查看日志。'),
  )
  window.addEventListener('pagehide', unsubscribe, { once: true })
} else {
  void mountApplication()
}
