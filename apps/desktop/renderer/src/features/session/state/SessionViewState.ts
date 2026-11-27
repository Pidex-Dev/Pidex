import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { Message, SessionViewState } from '../../../UiTypes.js'
import type { DesktopSessionEvent, DesktopWorkflowEvent } from '../../../../shared/Types.js'

export type SessionViewStateSetters = {
  setEvents: Dispatch<SetStateAction<DesktopSessionEvent[]>>
  setWorkflowEvents: Dispatch<SetStateAction<DesktopWorkflowEvent[]>>
  setMessages: Dispatch<SetStateAction<Message[]>>
  setContextUsage: Dispatch<SetStateAction<SessionViewState['contextUsage']>>
}

export function createEmptySessionView(): SessionViewState {
  return {
    events: [],
    workflowEvents: [],
    messages: [],
    toolLog: [],
    pendingPermissions: [],
    contextUsage: null,
    selectedFile: null,
  }
}

export function applySessionView(view: SessionViewState, setters: SessionViewStateSetters): void {
  setters.setEvents(view.events)
  setters.setWorkflowEvents(view.workflowEvents)
  setters.setMessages(view.messages)
  setters.setContextUsage(view.contextUsage)
}

export function setSessionView(
  sessionViewsRef: MutableRefObject<Record<string, SessionViewState>>,
  targetSessionId: string,
  view: SessionViewState,
): void {
  sessionViewsRef.current = {
    ...sessionViewsRef.current,
    [targetSessionId]: view,
  }
}
