import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

/** Runs the zh-TW repair policy for repository terminology test cases. */
const repairZhTw = (enValue, localeValue) =>
  repairTranslatedValue({
    key: 'auto.components.test.zh-tw-repository-glossary',
    enValue,
    localeValue,
    locale: 'zh-TW'
  })

describe('locale-translation-policy zh-TW terminology', () => {
  it.each([
    ['反饋', '回饋'],
    ['鏈接', '連結'],
    ['信息', '資訊'],
    ['內存', '記憶體'],
    ['主頁', '首頁'],
    ['特工', 'Agent'],
    ['存儲庫', '存放庫'],
    ['隊列', '佇列']
  ])('repairs %s without depending on the English source', (source, expected) => {
    expect(repairZhTw('Unrelated English', source)).toBe(expected)
    expect(repairZhTw('Unrelated English', expected)).toBe(expected)
  })

  it('normalizes repository wording for explicit repository tokens', () => {
    expect(repairZhTw('Open repo', '開啟倉庫')).toBe('開啟存放庫')
    expect(repairZhTw('Open repository', '開啟儲存庫')).toBe('開啟存放庫')
    expect(repairZhTw('Browse repositories', '瀏覽倉庫')).toBe('瀏覽存放庫')
  })

  it('does not fire for words that merely contain the repo substring', () => {
    expect(repairZhTw('Report status', '倉庫狀態')).toBe('倉庫狀態')
    expect(repairZhTw('Reposition panel', '儲存庫面板')).toBe('儲存庫面板')
  })
})
