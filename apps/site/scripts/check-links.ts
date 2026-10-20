import { globSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type DefaultTreeAdapterMap, parse } from 'parse5'

type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']
export function elements(html: string): Element[] {
  const result: Element[] = []
  function visit(node: Node) {
    if ('tagName' in node) result.push(node)
    if ('childNodes' in node) node.childNodes.forEach(visit)
  }
  visit(parse(html))
  return result
}
export const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value

export function checkBuiltLinks(directory: string): {
  pages: number
  links: number
  errors: string[]
} {
  const files = new Set(
    globSync('**/*', { cwd: directory, exclude: ['**/node_modules/**'] }).filter((file) =>
      statSync(join(directory, file)).isFile(),
    ),
  )
  const pages = new Map<string, Element[]>()
  for (const file of files) {
    if (!file.endsWith('.html')) continue
    const route =
      `/${file}`
        .replace(/\/index\.html$/, '/')
        .replace(/\.html$/, '')
        .replace(/\/$/, '') || '/'
    pages.set(route, elements(readFileSync(join(directory, file), 'utf8')))
  }
  const errors: string[] = []
  let links = 0
  for (const [route, nodes] of pages) {
    for (const node of nodes) {
      const href = attr(node, 'href')
      if (href === undefined) continue
      const url = new URL(href, `https://hourmere.com${route}`)
      if (!['http:', 'https:'].includes(url.protocol)) continue
      if (!['hourmere.com', 'www.hourmere.com'].includes(url.hostname)) continue
      links++
      const label = `${route}: ${href}`
      const path = decodeURI(url.pathname)
      if (node.tagName === 'link' && attr(node, 'rel') === 'canonical') {
        if (url.href !== `https://hourmere.com${route}`) errors.push(`${label}: noncanonical URL`)
      }
      if (path !== '/' && path.endsWith('/')) errors.push(`${label}: trailing slash`)
      const cleanPath =
        path
          .replace(/\/index\.html$/, '/')
          .replace(/\.html$/, '')
          .replace(/\/$/, '') || '/'
      const target = pages.get(cleanPath)
      if (target && path.endsWith('.html')) errors.push(`${label}: noncanonical HTML path`)
      if (!target) {
        if (!files.has(path.slice(1))) errors.push(`${label}: missing target`)
        continue
      }
      const fragment = decodeURIComponent(url.hash.slice(1))
      if (
        fragment &&
        fragment !== 'top' &&
        !target.some(
          (element) =>
            attr(element, 'id') === fragment ||
            (element.tagName === 'a' && attr(element, 'name') === fragment),
        )
      ) {
        errors.push(`${label}: missing anchor`)
      }
    }
  }
  if (pages.size === 0) errors.push('No built HTML pages found')
  return { pages: pages.size, links, errors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkBuiltLinks(process.argv[2] ?? new URL('../dist/', import.meta.url).pathname)
  for (const error of result.errors) console.error(error)
  console.log(`Checked ${result.links} internal links across ${result.pages} built pages`)
  if (result.errors.length) process.exitCode = 1
}
