import { useMemo } from 'react'
import { useDesktopRuntimeSettingsField } from '../../settings/UseDesktopSettings.js'

export function useDesktopLayoutSettings() {
  const subscribedSidebarTimelineEnabled = useDesktopRuntimeSettingsField(
    (s) => s.values.sidebarTimelineEnabled,
  )
  const subscribedNotifications = useDesktopRuntimeSettingsField((s) => s.values.notifications)
  const subscribedLastActiveWorkspacePath = useDesktopRuntimeSettingsField(
    (s) => s.values.lastActiveWorkspacePath,
  )
  const subscribedRemovedWorkspaces = useDesktopRuntimeSettingsField(
    (s) => s.values.removedWorkspaces,
  )
  const subscribedPermissionConfig = useDesktopRuntimeSettingsField(
    (s) => s.values.permissionConfig,
  )
  const subscribedPet = useDesktopRuntimeSettingsField((s) => s.values.pet)
  const subscribedSidebarCustomization = useDesktopRuntimeSettingsField(
    (s) => s.values.sidebarCustomization,
  )
  const subscribedModel = useDesktopRuntimeSettingsField((s) => s.values.model)
  const subscribedCodingModel = useDesktopRuntimeSettingsField((s) => s.values.codingModel)
  const subscribedSessionName = useDesktopRuntimeSettingsField((s) => s.values.sessionName)
  const subscribedThinkingMode = useDesktopRuntimeSettingsField((s) => s.values.thinkingMode)
  const subscribedSystemPrompt = useDesktopRuntimeSettingsField((s) => s.values.systemPrompt)
  const subscribedAppendSystemPrompt = useDesktopRuntimeSettingsField(
    (s) => s.values.appendSystemPrompt,
  )
  const subscribedAdditionalDirectories = useDesktopRuntimeSettingsField(
    (s) => s.values.additionalDirectories,
  )
  const subscribedInstallPidexDependencies = useDesktopRuntimeSettingsField(
    (s) => s.values.installPidexDependencies,
  )
  const subscribedEnableMemory = useDesktopRuntimeSettingsField((s) => s.values.enableMemory)
  const subscribedRustSearchAndDiffKernels = useDesktopRuntimeSettingsField(
    (s) => s.values.rustSearchAndDiffKernels,
  )
  const subscribedComposerPredictions = useDesktopRuntimeSettingsField(
    (s) => s.values['desktop.composer_predictions'],
  )
  const subscribedEnableAutoReviewPermissionMode = useDesktopRuntimeSettingsField(
    (s) => s.values.enableAutoReviewPermissionMode,
  )
  const subscribedEnableFullAccessPermissionMode = useDesktopRuntimeSettingsField(
    (s) => s.values.enableFullAccessPermissionMode,
  )
  const subscribedRecentWorkspaces = useDesktopRuntimeSettingsField(
    (s) => s.values.recentWorkspaces,
  )
  const subscribedProviderID = useDesktopRuntimeSettingsField((s) => s.values.providerID)
  const subscribedProviderBaseURL = useDesktopRuntimeSettingsField((s) => s.values.providerBaseURL)
  const subscribedShowContextUsage = useDesktopRuntimeSettingsField(
    (s) => s.values.showContextUsage,
  )
  const subscribedContextUsageView = useDesktopRuntimeSettingsField(
    (s) => s.values.contextUsageView,
  )
  const subscribedDiffMarkerStyle = useDesktopRuntimeSettingsField((s) => s.values.diffMarkerStyle)
  const subscribedReviewView = useDesktopRuntimeSettingsField((s) => s.values.reviewView)
  const subscribedGitBranchPrefix = useDesktopRuntimeSettingsField((s) => s.values.gitBranchPrefix)
  const subscribedAllowForcePush = useDesktopRuntimeSettingsField((s) => s.values.allowForcePush)
  const subscribedCommitMessagePrompt = useDesktopRuntimeSettingsField(
    (s) => s.values.commitMessagePrompt,
  )
  const subscribedPullRequestPrompt = useDesktopRuntimeSettingsField(
    (s) => s.values.pullRequestPrompt,
  )
  const subscribedSidebarSessionPins = useDesktopRuntimeSettingsField(
    (s) => s.values.sidebarSessionPins,
  )
  const subscribedTitlebarSessionTabIds = useDesktopRuntimeSettingsField(
    (s) => s.values.titlebarSessionTabIds,
  )
  const subscribedSyncExternalSettingsPatch = useDesktopRuntimeSettingsField(
    (s) => s.syncExternalSettingsPatch,
  )
  const subscribedSetSidebarCustomization = useDesktopRuntimeSettingsField(
    (s) => s.setSidebarCustomization,
  )
  const subscribedPermissionMode = useDesktopRuntimeSettingsField((s) => s.permissionMode)
  const subscribedSettingsLoaded = useDesktopRuntimeSettingsField((s) => s.settingsLoaded)
  const subscribedSetPermissionMode = useDesktopRuntimeSettingsField((s) => s.setPermissionMode)
  const subscribedSetRecentWorkspaces = useDesktopRuntimeSettingsField((s) => s.setRecentWorkspaces)
  const subscribedSetDrawerTab = useDesktopRuntimeSettingsField((s) => s.setDrawerTab)
  const subscribedSetReviewView = useDesktopRuntimeSettingsField((s) => s.setReviewView)
  const subscribedSetSidebarSessionPins = useDesktopRuntimeSettingsField(
    (s) => s.setSidebarSessionPins,
  )
  const subscribedSetTitlebarSessionTabIds = useDesktopRuntimeSettingsField(
    (s) => s.setTitlebarSessionTabIds,
  )
  const subscribedSetSidebarTimelineEnabled = useDesktopRuntimeSettingsField(
    (s) => s.setSidebarTimelineEnabled,
  )

  return useMemo(
    () => ({
      values: {
        sidebarTimelineEnabled: subscribedSidebarTimelineEnabled,
        notifications: subscribedNotifications,
        lastActiveWorkspacePath: subscribedLastActiveWorkspacePath,
        removedWorkspaces: subscribedRemovedWorkspaces,
        permissionConfig: subscribedPermissionConfig,
        pet: subscribedPet,
        sidebarCustomization: subscribedSidebarCustomization,
        model: subscribedModel,
        codingModel: subscribedCodingModel,
        sessionName: subscribedSessionName,
        thinkingMode: subscribedThinkingMode,
        systemPrompt: subscribedSystemPrompt,
        appendSystemPrompt: subscribedAppendSystemPrompt,
        additionalDirectories: subscribedAdditionalDirectories,
        installPidexDependencies: subscribedInstallPidexDependencies,
        enableMemory: subscribedEnableMemory,
        rustSearchAndDiffKernels: subscribedRustSearchAndDiffKernels,
        'desktop.composer_predictions': subscribedComposerPredictions,
        enableAutoReviewPermissionMode: subscribedEnableAutoReviewPermissionMode,
        enableFullAccessPermissionMode: subscribedEnableFullAccessPermissionMode,
        recentWorkspaces: subscribedRecentWorkspaces,
        providerID: subscribedProviderID,
        providerBaseURL: subscribedProviderBaseURL,
        showContextUsage: subscribedShowContextUsage,
        contextUsageView: subscribedContextUsageView,
        diffMarkerStyle: subscribedDiffMarkerStyle,
        reviewView: subscribedReviewView,
        gitBranchPrefix: subscribedGitBranchPrefix,
        allowForcePush: subscribedAllowForcePush,
        commitMessagePrompt: subscribedCommitMessagePrompt,
        pullRequestPrompt: subscribedPullRequestPrompt,
        sidebarSessionPins: subscribedSidebarSessionPins,
        titlebarSessionTabIds: subscribedTitlebarSessionTabIds,
      },
      syncExternalSettingsPatch: subscribedSyncExternalSettingsPatch,
      setSidebarCustomization: subscribedSetSidebarCustomization,
      permissionMode: subscribedPermissionMode,
      settingsLoaded: subscribedSettingsLoaded,
      setPermissionMode: subscribedSetPermissionMode,
      setRecentWorkspaces: subscribedSetRecentWorkspaces,
      setDrawerTab: subscribedSetDrawerTab,
      setReviewView: subscribedSetReviewView,
      setSidebarSessionPins: subscribedSetSidebarSessionPins,
      setTitlebarSessionTabIds: subscribedSetTitlebarSessionTabIds,
      setSidebarTimelineEnabled: subscribedSetSidebarTimelineEnabled,
    }),
    [
      subscribedSidebarTimelineEnabled,
      subscribedNotifications,
      subscribedLastActiveWorkspacePath,
      subscribedRemovedWorkspaces,
      subscribedPermissionConfig,
      subscribedPet,
      subscribedSidebarCustomization,
      subscribedModel,
      subscribedCodingModel,
      subscribedSessionName,
      subscribedThinkingMode,
      subscribedSystemPrompt,
      subscribedAppendSystemPrompt,
      subscribedAdditionalDirectories,
      subscribedInstallPidexDependencies,
      subscribedEnableMemory,
      subscribedRustSearchAndDiffKernels,
      subscribedComposerPredictions,
      subscribedEnableAutoReviewPermissionMode,
      subscribedEnableFullAccessPermissionMode,
      subscribedRecentWorkspaces,
      subscribedProviderID,
      subscribedProviderBaseURL,
      subscribedShowContextUsage,
      subscribedContextUsageView,
      subscribedDiffMarkerStyle,
      subscribedReviewView,
      subscribedGitBranchPrefix,
      subscribedAllowForcePush,
      subscribedCommitMessagePrompt,
      subscribedPullRequestPrompt,
      subscribedSidebarSessionPins,
      subscribedTitlebarSessionTabIds,
      subscribedSyncExternalSettingsPatch,
      subscribedSetSidebarCustomization,
      subscribedPermissionMode,
      subscribedSettingsLoaded,
      subscribedSetPermissionMode,
      subscribedSetRecentWorkspaces,
      subscribedSetDrawerTab,
      subscribedSetReviewView,
      subscribedSetSidebarSessionPins,
      subscribedSetTitlebarSessionTabIds,
      subscribedSetSidebarTimelineEnabled,
    ],
  )
}
