import type { DesktopProviderModelDefinition } from '../../../../shared/Types.js'

export const modelPrice = (value: number | undefined) =>
  value === undefined ? '未知' : value === 0 ? '免费' : `$${value}`

type CatalogModel = Omit<DesktopProviderModelDefinition, 'id'> & { id: string }

const support = (value: boolean | undefined) => value === undefined ? '未知' : value ? '支持' : '不支持'

function SourceLink({ url, label }: { url: string; label: string }) {
  return /^https?:\/\//i.test(url)
    ? <a href={url} target="_blank" rel="noreferrer" className="tw:text-app-accent-fg tw:underline">{label}</a>
    : <span>{label}</span>
}

/** 目录声明与当前可执行能力分开显示，不将 PDF 声明变成上传能力。 */
export function ModelCatalogDetails({ model, current }: {
  model: CatalogModel
  current?: CatalogModel
}) {
  const info = model.catalog
  const price = model.cost
  const source = info?.priceSource
  const differences = current ? [
    ['上下文', current.contextWindow, model.contextWindow],
    ['最大输入', current.maxInputTokens, model.maxInputTokens],
    ['最大输出', current.maxTokens, model.maxTokens],
    ['输入价格', current.cost?.input, price?.input],
    ['输出价格', current.cost?.output, price?.output],
  ].filter(([, saved, recommended]) => saved !== undefined && recommended !== undefined && saved !== recommended) : []
  return <div className="tw:grid tw:gap-3 tw:type-1 tw:text-app-text-soft tw:select-text">
    <section aria-label="能力与限制">
      <strong className="tw:text-app-text">能力与限制</strong>
      <p>目录输入：{(info?.input ?? model.input)?.join(' · ') || '未知'}</p>
      <p>目录输出：{info?.output?.join(' · ') || '未知'}</p>
      {info?.input?.includes('pdf') && <p>目录支持 PDF；当前客户端暂未支持原生发送。</p>}
      <p>工具：{support(model.tools)} · 结构化输出：{support(info?.structuredOutput)} · 温度：{support(info?.temperature)}</p>
      <p>上下文 {model.contextWindow ?? '未知'} · 最大输入 {model.maxInputTokens ?? '未知'} · 最大输出 {model.maxTokens ?? '未知'} tokens</p>
      <p>附件实际发送能力还取决于当前协议适配。</p>
      <p>当前协议：{model.api}{info?.apiShape ? ` · 目录形态：${info.apiShape}` : ''}</p>
      {info?.providerSdk && <p>目录 SDK：{info.providerSdk}</p>}
      {info?.interleavedField && <p>目录推理字段：{info.interleavedField}（由协议适配决定实际处理方式）</p>}
    </section>
    <section aria-label="推理控制">
      <strong className="tw:text-app-text">推理控制</strong>
      {info?.reasoningOptions?.length ? info.reasoningOptions.map((option, index) => <p key={index}>
        {option.type === 'toggle' ? '推理开关' : option.type === 'effort'
          ? `推理档位：${option.values?.map((value) => value === null ? '默认（null）' : value).join(' · ') || '未提供'}`
          : `Token 预算：下限 ${option.min ?? '未提供'} / 上限 ${option.max ?? '未提供'}`}
      </p>) : <p>目录未提供控制方式。</p>}
      {model.optionSpecs?.reasoningLevel?.values && <p>当前可选值：{model.optionSpecs.reasoningLevel.values.join(' · ')}</p>}
    </section>
    <section aria-label="完整价格">
      <strong className="tw:text-app-text">价格 · USD / 百万 tokens</strong>
      <p>{source ? `${source.kind === 'provider' ? '供应商价格' : '原厂参考价'} · ${source.providerId}` : '价格来源未提供'}</p>
      <p>输入 {modelPrice(price?.input)} · 输出 {modelPrice(price?.output)}</p>
      <p>缓存读取 {modelPrice(price?.cacheRead)} · 缓存写入 {modelPrice(price?.cacheWrite)}</p>
      {price?.tiers?.map((tier) => <p key={tier.inputTokensAbove}>输入超过 {tier.inputTokensAbove} tokens：输入 {modelPrice(tier.input)} / 输出 {modelPrice(tier.output)} / 缓存读 {modelPrice(tier.cacheRead)} / 缓存写 {modelPrice(tier.cacheWrite)}</p>)}
      {(info?.reasoningCost !== undefined || info?.inputAudioCost !== undefined || info?.outputAudioCost !== undefined) && <>
        <p>推理 {modelPrice(info?.reasoningCost)} · 音频输入 {modelPrice(info?.inputAudioCost)} · 音频输出 {modelPrice(info?.outputAudioCost)}</p>
        <p>独立推理、音频单价仅供参考，未作为额外分项加入当前费用估算。</p>
      </>}
    </section>
    {differences.length > 0 && <section aria-label="当前配置差异"><strong>当前配置 / 目录推荐</strong>
      {differences.map(([label, saved, recommended]) => <p key={String(label)}>{label}：{saved} / {recommended}</p>)}
    </section>}
    <section aria-label="模型资料">
      <strong className="tw:text-app-text">模型资料</strong>
      {info?.description && <p>{info.description}</p>}
      <p>系列：{info?.family ?? '未知'} · 状态：{info?.status ?? '目录未标注'}</p>
      <p>发布：{info?.releaseDate ?? '未知'} · 更新：{info?.lastUpdated ?? '未知'} · 知识截止：{info?.knowledge ?? '未知'}</p>
      <p>开放权重：{support(info?.openWeights)} · 许可证：{info?.license ?? '未知'}</p>
      {!!(info?.links?.length || info?.weights?.length || info?.benchmarks?.length) && <details>
        <summary>资料链接、权重与测评</summary>
        {info.links?.map((link, index) => <p key={`link-${index}`}><SourceLink url={link.url} label={link.label ?? link.type ?? link.url} /></p>)}
        {info.weights?.map((weight, index) => <p key={`weight-${index}`}><SourceLink url={weight.url} label={weight.label ?? '权重'} /> {weight.format} {weight.quantization}</p>)}
        {info.benchmarks?.map((result, index) => <p key={`benchmark-${index}`}>
          {result.name}：{result.score} {[result.metric, result.harness, result.variant, result.dataset, result.version, result.date].filter(Boolean).join(' · ')}
          {result.source && <> · <SourceLink url={result.source} label="来源" /></>}
        </p>)}
      </details>}
    </section>
  </div>
}
