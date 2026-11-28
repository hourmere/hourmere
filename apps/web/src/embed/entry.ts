import { setWidgetScriptSource } from './language.ts'
import { install } from './widget.ts'

const script = document.currentScript
setWidgetScriptSource(script instanceof HTMLScriptElement ? script.src : undefined)
install()
