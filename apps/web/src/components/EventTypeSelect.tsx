import { useI18n } from '../i18n/runtime.tsx'
import { Field } from './forms.tsx'

export function EventTypeSelect({
  id,
  eventTypes,
  value,
  onChange,
}: {
  id: string
  eventTypes: readonly { id: string; title: string }[]
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  return (
    <Field id={id} label={t('Event type')}>
      {(control) => (
        <select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
          {eventTypes.map((event) => (
            <option key={event.id} value={event.id} dir="auto">
              {event.title}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}
