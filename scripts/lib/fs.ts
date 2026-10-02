import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const readJson = async (file: string) =>
  JSON.parse(await readFile(file, 'utf8'))

/** full path of an executable on PATH, or undefined */
export const findCommand = (name: string) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, name))
    .find((file) => existsSync(file))

export const commandExists = (name: string) => findCommand(name) !== undefined
