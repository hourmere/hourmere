import { readFileSync } from 'node:fs'
import type { INodeProperties } from 'n8n-workflow'
import { describe, expect, it } from 'vitest'
import { Hourmere } from './nodes/Hourmere/Hourmere.node'
import { HourmereTrigger } from './nodes/HourmereTrigger/HourmereTrigger.node'

type Translation = { [key: string]: string | Translation }

function checkProperties(properties: INodeProperties[], translations: Translation): void {
  for (const property of properties) {
    const translation = translations[property.name] as Translation
    expect(translation, `${property.name} translation`).toBeDefined()
    for (const field of ['displayName', 'description', 'placeholder'] as const) {
      if (property[field]) {
        expect(translation[field], `${property.name}.${field}`).toMatch(/[\u3400-\u9fff]/)
        expect(translation[field]).not.toBe(property[field])
      }
    }
    if (property.type === 'collection') {
      checkProperties(property.options as INodeProperties[], translation.options as Translation)
    } else if (property.type === 'options' || property.type === 'multiOptions') {
      for (const option of property.options ?? []) {
        if ('value' in option) {
          const entry = (translation.options as Translation)[String(option.value)] as Translation
          expect(entry?.displayName, `${property.name}.${option.value}`).toMatch(/[\u3400-\u9fff]/)
        }
      }
    }
  }
}

describe('community node Simplified Chinese parameter translations', () => {
  it.each(['zh', 'zh-CN'])('uses the product no-show term in %s', (locale) => {
    const translation = JSON.parse(
      readFileSync(
        new URL(
          `./nodes/HourmereTrigger/translations/${locale}/n8n-nodes-hourmere.hourmereTrigger.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    )
    expect(
      translation.nodeView.events.options['booking.attendee_no_show_changed'].displayName,
    ).toBe('参会者未出席标记已更改')
  })
  for (const Node of [Hourmere, HourmereTrigger]) {
    it(`${Node.name} covers every parameter in both supported locale spellings`, () => {
      const node = new Node()
      const load = (locale: string) =>
        JSON.parse(
          readFileSync(
            new URL(
              `./nodes/${Node.name}/translations/${locale}/n8n-nodes-hourmere.${node.description.name}.json`,
              import.meta.url,
            ),
            'utf8',
          ),
        ) as { nodeView: Translation }
      const chinese = load('zh')
      expect(load('zh-CN')).toEqual(chinese)
      checkProperties(node.description.properties, chinese.nodeView)
    })
  }
})
