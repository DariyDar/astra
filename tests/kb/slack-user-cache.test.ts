import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSlackMentions } from '../../src/kb/slack-user-cache.js'

describe('resolveSlackMentions', () => {
  const cache = new Map([
    ['U09AKPXRQ81', 'Dariy'],
    ['U123ABC456', 'John Smith'],
    ['U000000000', 'Bot User'],
  ])

  it('resolves simple <@U123> pattern', () => {
    const result = resolveSlackMentions('Hello <@U09AKPXRQ81>', cache)
    assert.equal(result, 'Hello Dariy')
  })

  it('resolves <@U123|display_name> pattern using cache', () => {
    const result = resolveSlackMentions('Hi <@U123ABC456|johnny>', cache)
    assert.equal(result, 'Hi John Smith')
  })

  it('falls back to pipe display name when user ID not in cache', () => {
    const result = resolveSlackMentions('Hey <@UNOTFOUND|Jane>', cache)
    assert.equal(result, 'Hey Jane')
  })

  it('keeps raw ID when not in cache and no pipe name', () => {
    const result = resolveSlackMentions('Hey <@UNOTFOUND>', cache)
    assert.equal(result, 'Hey <@UNOTFOUND>')
  })

  it('resolves multiple mentions in one string', () => {
    const result = resolveSlackMentions('<@U09AKPXRQ81> and <@U123ABC456> discussed', cache)
    assert.equal(result, 'Dariy and John Smith discussed')
  })

  it('handles text with no mentions', () => {
    const result = resolveSlackMentions('No mentions here', cache)
    assert.equal(result, 'No mentions here')
  })

  it('handles empty string', () => {
    const result = resolveSlackMentions('', cache)
    assert.equal(result, '')
  })

  it('handles empty cache', () => {
    const result = resolveSlackMentions('Hello <@U09AKPXRQ81>', new Map())
    assert.equal(result, 'Hello <@U09AKPXRQ81>')
  })

  it('resolves mention with pipe but empty display name', () => {
    const result = resolveSlackMentions('Hi <@U09AKPXRQ81|>', cache)
    assert.equal(result, 'Hi Dariy')
  })
})
