// shown as a mention in the Hack Club Slack and as a name (and link) anywhere else

export type Author = {
  /** display name, used wherever a mention can't be */
  name: string
  /** Hack Club Slack member id */
  slackId?: string
  /** where the name links to outside the Hack Club Slack */
  url?: string
}

export const AUTHORS = {
  jeremy: {
    name: 'Jeremy',
    slackId: 'U06UYA5GMB5',
    url: 'https://jeremywoolley.com',
  },
  rowan: { name: 'Rowan', slackId: 'U080A3QP42C', url: 'https://3kh0.net' },
  ani: {
    name: 'Ani',
    slackId: 'U01D9DWGEB0',
    url: 'https://github.com/anirudhb',
  },
  sahil: {
    name: 'Sahil',
    slackId: 'U08PUHSMW4V',
    url: 'https://sahil.ink',
  },
  miggy: {
    name: 'Miggy',
    slackId: 'U07VC9705D4',
    url: 'https://shymike.dev',
  },
  scooter: {
    name: 'Scooter',
    slackId: 'U046VA0KR8R',
    url: 'https://github.com/scooterthedev',
  },
  cyril: {
    name: 'Cyril',
    slackId: 'U07FXPUDYDC',
    url: 'https://github.com/CyrilSLi',
  },
  izie: {
    name: 'Izie',
    slackId: 'U09KKMHLS15',
    url: 'https://github.com/IzieStratt',
  },
  adryd: { name: 'adryd', url: 'https://adryd.com' },
} as const satisfies Record<string, Author>

export type AuthorKey = keyof typeof AUTHORS

/** registry keys or `Author`s, or an older mrkdwn string like `<@U06UYA5GMB5>, <@U080A3QP42C>` */
export type PluginAuthors = string | readonly (AuthorKey | Author)[]

export function authorBySlackId(id: string): Author | undefined {
  return Object.values(AUTHORS as Record<string, Author>).find(
    (author) => author.slackId === id
  )
}

/** unknown keys are kept as bare names */
export function resolveAuthors(authors: unknown): Author[] | string {
  if (typeof authors === 'string') return authors
  if (!Array.isArray(authors)) return []
  return authors.flatMap((item): Author[] => {
    if (typeof item === 'string') {
      return [(AUTHORS as Record<string, Author>)[item] ?? { name: item }]
    }
    if (item && typeof item === 'object' && typeof item.name === 'string') {
      return [item as Author]
    }
    return []
  })
}
