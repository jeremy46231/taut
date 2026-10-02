import { updateMonacoTheme } from '../cdn'
import { childWindowDocuments, onChildWindow } from '../slack/childWindows'

// weak so closed child windows' documents can be collected
type Sheet = {
  css: string
  key?: string
  elements: WeakMap<Document, HTMLStyleElement>
}

const sheets = new Set<Sheet>()
const keyed = new Map<string, Sheet>()

function liveDocuments(): Document[] {
  return [document, ...childWindowDocuments()]
}

function render(sheet: Sheet, doc: Document) {
  let element = sheet.elements.get(doc)
  if (!element) {
    element = doc.createElement('style')
    element.dataset.tautStyle = sheet.key ?? ''
    doc.head.appendChild(element)
    sheet.elements.set(doc, element)
  }
  if (element.textContent !== sheet.css) element.textContent = sheet.css
}

function drop(sheet: Sheet) {
  for (const doc of liveDocuments()) {
    sheet.elements.get(doc)?.remove()
    sheet.elements.delete(doc)
  }
  sheets.delete(sheet)
  if (sheet.key !== undefined) keyed.delete(sheet.key)
  updateMonacoTheme()
}

/** returns a disposer, a `key` replaces that key's sheet and a null `css` drops it */
export function setStyle(css: string | null, key?: string): () => void {
  let sheet = key === undefined ? undefined : keyed.get(key)

  if (css === null) {
    if (sheet) drop(sheet)
    return () => {}
  }

  if (!sheet) {
    sheet = { css, key, elements: new WeakMap() }
    sheets.add(sheet)
    if (key !== undefined) keyed.set(key, sheet)
  }
  sheet.css = css
  for (const doc of liveDocuments()) render(sheet, doc)
  updateMonacoTheme()

  const added = sheet
  return () => drop(added)
}

onChildWindow((doc) => {
  for (const sheet of sheets) render(sheet, doc)
})
