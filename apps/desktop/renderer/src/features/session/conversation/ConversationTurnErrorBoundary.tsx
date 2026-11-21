import React from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'

type ConversationTurnErrorBoundaryProps = {
  children: React.ReactNode
  turnId: string
}

type ConversationTurnErrorBoundaryState = {
  failed: boolean
  turnId: string
}

export class ConversationTurnErrorBoundary extends React.Component<
  ConversationTurnErrorBoundaryProps,
  ConversationTurnErrorBoundaryState
> {
  state: ConversationTurnErrorBoundaryState = { failed: false, turnId: this.props.turnId }

  static getDerivedStateFromError(): Partial<ConversationTurnErrorBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: ConversationTurnErrorBoundaryProps,
    state: ConversationTurnErrorBoundaryState,
  ): Partial<ConversationTurnErrorBoundaryState> | null {
    if (props.turnId !== state.turnId) {
      return { failed: false, turnId: props.turnId }
    }
    return null
  }

  private retryAfterHotUpdate = (): void => {
    if (this.state.failed) this.setState({ failed: false })
  }

  componentDidMount(): void {
    import.meta.hot?.on('vite:afterUpdate', this.retryAfterHotUpdate)
  }

  componentWillUnmount(): void {
    import.meta.hot?.off('vite:afterUpdate', this.retryAfterHotUpdate)
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <article className="canonical-turn-error" role="alert">
        <CircleAlert size="var(--inline-icon-size, 1em)" aria-hidden="true" />
        <span>
          <strong>这一轮内容暂时无法显示</strong>
          <small>其他会话内容不受影响。</small>
        </span>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          <RotateCcw size="var(--inline-icon-size, 1em)" aria-hidden="true" />
          重试
        </button>
      </article>
    )
  }
}

type ConversationMarkdownErrorBoundaryState = {
  failed: boolean
  contentKey: string
}

export class ConversationMarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; contentKey: string },
  ConversationMarkdownErrorBoundaryState
> {
  state: ConversationMarkdownErrorBoundaryState = {
    failed: false,
    contentKey: this.props.contentKey,
  }

  static getDerivedStateFromError(): Partial<ConversationMarkdownErrorBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(
    props: Readonly<{ children: React.ReactNode; contentKey: string }>,
    state: ConversationMarkdownErrorBoundaryState,
  ): Partial<ConversationMarkdownErrorBoundaryState> | null {
    if (props.contentKey !== state.contentKey) {
      return { failed: false, contentKey: props.contentKey }
    }
    return null
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="canonical-markdown-error" role="alert">
        <CircleAlert size="var(--inline-icon-size, 1em)" aria-hidden="true" />
        <span>这段富文本无法渲染</span>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          重试
        </button>
      </div>
    )
  }
}
