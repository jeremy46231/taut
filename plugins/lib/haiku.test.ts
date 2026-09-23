import { describe, expect, test } from 'bun:test'
import {
  blocksToSlackText,
  dictionaryLookup,
  findHaiku,
  humanizeInteger,
} from './haiku'

describe('Orpheus haiku matching', () => {
  const counts: Record<string, number> = {
    a: 1,
    again: 2,
    an: 1,
    frog: 1,
    into: 2,
    jumps: 1,
    old: 1,
    pond: 1,
    silence: 2,
    silent: 2,
    splash: 1,
    the: 1,
    x: 4,
    y: 2,
    z: 1,
  }
  const lookup = (word: string) => counts[word]

  test('splits a hidden haiku only at exact 5/7/5 boundaries', () => {
    expect(
      findHaiku(
        'An old silent pond, a frog jumps into the pond — splash, silence again.',
        lookup
      )
    ).toEqual([
      'an old silent pond',
      'a frog jumps into the pond',
      'splash silence again.',
    ])

    expect(findHaiku('x y z z z z z z z z z z z', lookup)).toBeNull()
  })

  test('matches humanize 3.1.0 number wording', () => {
    expect(humanizeInteger('0')).toBe('zero')
    expect(humanizeInteger('1001')).toBe('one thousand and one')
    expect(humanizeInteger('1100')).toBe('one thousand, one hundred')
    expect(humanizeInteger('12345')).toBe(
      'twelve thousand, three hundred and forty-five'
    )
  })
})

test('dictionary lookup handles boundaries without building a Map', () => {
  const dictionary = 'alpha 2\nbeta 1\nomega 3\n'
  expect(dictionaryLookup(dictionary, 'alpha')).toBe(2)
  expect(dictionaryLookup(dictionary, 'beta')).toBe(1)
  expect(dictionaryLookup(dictionary, 'omega')).toBe(3)
  expect(dictionaryLookup(dictionary, 'missing')).toBeUndefined()
})

test('rich text is reconstructed like a Slack message event', () => {
  expect(
    blocksToSlackText([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'hello ' },
              { type: 'user', user_id: 'U123' },
              { type: 'text', text: ' in ' },
              { type: 'channel', channel_id: 'C456' },
              { type: 'text', text: ' ' },
              { type: 'link', url: 'https://example.com', text: 'example' },
              { type: 'text', text: ' ' },
              { type: 'emoji', name: 'wave' },
            ],
          },
        ],
      },
    ])
  ).toBe('hello <@U123> in <#C456> <https://example.com|example> :wave:')
})
