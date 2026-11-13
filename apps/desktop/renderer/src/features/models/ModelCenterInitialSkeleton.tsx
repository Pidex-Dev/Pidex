import type React from 'react'
import { useSearchParams } from 'react-router-dom'
import { SkeletonBlock, SkeletonRegion } from '../../components/ui/Skeleton.js'
import { PrimaryPageLayout } from '../layout/primary-page/index.js'

export function ProvidersPageFallback(): React.ReactNode {
  const [params] = useSearchParams()
  const detail = Boolean(params.get('provider')) || params.get('newProvider') === '1'
  if (detail) {
    return (
      <div className="model-center-shell tw:@container tw:h-full tw:min-w-0 tw:overflow-y-auto tw:p-5">
        <div className="tw:mx-auto tw:w-full tw:max-w-[var(--page-content-max-width)] tw:pb-6">
          <ModelCenterInitialSkeleton view="detail" />
        </div>
      </div>
    )
  }
  return (
    <PrimaryPageLayout
      className="model-center-shell model-center-primary-page tw:@container"
      headerClassName="settings-page-header"
      title="供应商市场"
      description="浏览模型供应商，连接后可在左侧管理凭据与模型。"
      search={<SkeletonBlock className="tw:h-7 tw:w-full tw:rounded-full" shimmer />}
    >
      <ModelCenterInitialSkeleton view="catalog" />
    </PrimaryPageLayout>
  )
}

type ModelCenterInitialSkeletonProps = {
  view: 'catalog' | 'detail'
}

export function ModelCenterInitialSkeleton({
  view,
}: ModelCenterInitialSkeletonProps): React.ReactNode {
  if (view === 'detail') {
    return (
      <SkeletonRegion
        shimmer
        className="model-center-initial-skeleton tw:grid tw:min-w-0 tw:gap-3"
        label="正在加载 Provider 详情"
      >
        <header className="model-center-skeleton-provider-header tw:flex tw:min-h-7 tw:min-w-0 tw:items-center tw:gap-3">
          <SkeletonBlock className="model-center-skeleton-back tw:size-7 tw:rounded-3" />
          <SkeletonBlock className="model-center-skeleton-provider-logo tw:size-7 tw:rounded-3" />
          <div className="tw:grid tw:min-w-0 tw:flex-1 tw:gap-2">
            <SkeletonBlock className="model-center-skeleton-provider-title tw:h-[18px] tw:w-[min(150px,72%)]" />
            <SkeletonBlock className="model-center-skeleton-provider-copy tw:h-4 tw:w-[min(210px,88%)]" />
          </div>
        </header>
        <SkeletonBlock className="tw:h-[6rem] tw:rounded-3" />
        <SkeletonBlock className="tw:h-7 tw:w-[min(360px,100%)] tw:rounded-3" />
        <div className="tw:grid tw:min-w-0 tw:gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonBlock className="tw:h-[3.5rem] tw:rounded-3" key={index} />
          ))}
        </div>
      </SkeletonRegion>
    )
  }

  return (
    <SkeletonRegion
      shimmer
      className="model-center-initial-skeleton tw:grid tw:min-w-0 tw:gap-3"
      label="正在加载 Provider 目录"
    >
      <div className="model-center-heading model-center-skeleton-heading tw:grid tw:gap-2">
        <SkeletonBlock className="model-center-skeleton-page-title tw:h-6 tw:w-[min(190px,52%)] tw:rounded-3" />
        <SkeletonBlock className="model-center-skeleton-page-copy tw:h-[18px] tw:w-[min(460px,78%)] tw:rounded-3" />
      </div>
      <div className="model-center-skeleton-provider-grid tw:grid tw:min-w-0 tw:grid-cols-2 tw:gap-4 tw:@max-[900px]:grid-cols-1">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            className="model-center-skeleton-provider-card tw:grid tw:min-h-[78px] tw:min-w-0 tw:grid-cols-[auto_minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:rounded-4 tw:border tw:border-app-border-subtle tw:p-4"
            key={index}
          >
            <SkeletonBlock className="model-center-skeleton-logo tw:size-7 tw:rounded-3" />
            <div className="tw:grid tw:min-w-0 tw:gap-2">
              <SkeletonBlock className="model-center-skeleton-name tw:h-[18px] tw:w-[min(150px,72%)]" />
              <SkeletonBlock className="model-center-skeleton-meta tw:h-4 tw:w-[min(210px,88%)]" />
            </div>
            <SkeletonBlock className="model-center-skeleton-status tw:h-4 tw:w-9" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
}
