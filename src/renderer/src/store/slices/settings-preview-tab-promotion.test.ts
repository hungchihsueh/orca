import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

const settingsSet = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.clearAllMocks()
  settingsSet.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      settings: { get: vi.fn().mockResolvedValue({ notifications: {} }), set: settingsSet }
    }
  })
})

describe('createSettingsSlice preview tab promotion', () => {
  function openPreviewFile(store: ReturnType<typeof createTestStore>): void {
    store.getState().openFile(
      {
        filePath: '/repo/src/a.ts',
        relativePath: 'src/a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      { preview: true }
    )
  }

  it('promotes open preview tabs when preview tabs are turned off', async () => {
    const store = createTestStore()
    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: true }) })
    openPreviewFile(store)
    expect(store.getState().openFiles[0].isPreview).toBe(true)

    await store.getState().updateSettings({ editorPreviewTabsEnabled: false })

    expect(store.getState().openFiles.every((file) => !file.isPreview)).toBe(true)
  })

  it('leaves preview tabs alone when an unrelated setting changes', async () => {
    const store = createTestStore()
    store.setState({ settings: createGlobalSettingsFixture({ editorPreviewTabsEnabled: true }) })
    openPreviewFile(store)

    await store.getState().updateSettings({ confirmClosePinnedTab: false })

    expect(store.getState().openFiles[0].isPreview).toBe(true)
  })
})
