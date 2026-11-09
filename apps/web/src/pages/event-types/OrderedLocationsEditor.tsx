import { useState } from 'react'
import { Field, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import {
  type EventTypeDraft,
  LOCATION_KINDS,
  type LocationOption,
  orderedLocations,
} from './event-type-form.ts'

export function OrderedLocationsEditor({
  draft,
  errors,
  set,
}: {
  draft: EventTypeDraft
  errors: FieldErrors
  set: <K extends keyof EventTypeDraft>(name: K, value: EventTypeDraft[K]) => void
}) {
  const { t, ui } = useI18n()
  const [addition, setAddition] = useState('')
  const options = orderedLocations(draft)
  const defaultId = (options.find((option) => option.isDefault) ?? options[0])?.id
  const available = LOCATION_KINDS.filter(
    (kind) => kind.value && !options.some((option) => option.kind === kind.value),
  )
  function update(id: string, change: LocationOption) {
    set(
      'locationOptions',
      options.map((option) => (option.id === id ? change : option)),
    )
  }
  function move(index: number, direction: number) {
    const next = [...options]
    const [option] = next.splice(index, 1)
    if (!option) return
    next.splice(index + direction, 0, option)
    set('locationOptions', next)
  }
  function add() {
    const kind = available.find((item) => item.value === addition)?.value ?? available[0]?.value
    if (!kind) return
    const id = `location_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    const option: LocationOption =
      kind === 'phone'
        ? { id, kind, askInvitee: true }
        : kind === 'in_person'
          ? { id, kind, address: '' }
          : kind === 'link'
            ? { id, kind, url: '' }
            : { id, kind }
    set('locationOptions', [...options, option])
  }
  return (
    <section aria-label={t('Location options')} className="stack">
      {options.map((option, index) => {
        const id = `location-option-${option.id}`
        const primary = option.id === draft.primaryLocationId
        return (
          <fieldset key={option.id} className="stack">
            <legend>
              {ui(LOCATION_KINDS.find((kind) => kind.value === option.kind)?.label ?? '')}
            </legend>
            <Field
              id={`${id}-label`}
              label={t('Location label')}
              optional
              error={errors[`${id}-label`]}
            >
              {(props) => (
                <input
                  {...props}
                  value={option.label ?? ''}
                  maxLength={100}
                  onChange={(event) => {
                    const { label: _label, ...rest } = option
                    update(
                      option.id,
                      event.target.value ? { ...rest, label: event.target.value } : rest,
                    )
                  }}
                />
              )}
            </Field>
            {option.kind === 'phone' && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={option.askInvitee === true}
                    onChange={(event) => {
                      if (primary) {
                        set('phoneAskInvitee', event.target.checked)
                        set('phone', '')
                        return
                      }
                      const { number: _number, askInvitee: _ask, ...rest } = option
                      update(
                        option.id,
                        event.target.checked
                          ? { ...rest, askInvitee: true }
                          : { ...rest, number: '' },
                      )
                    }}
                  />
                  {t('Invitee provides a phone number')}
                </label>
                {!primary && !option.askInvitee && (
                  <Field id={`${id}-value`} label={t('Phone number')} error={errors[`${id}-value`]}>
                    {(props) => (
                      <input
                        {...props}
                        type="tel"
                        value={option.number ?? ''}
                        onChange={(event) =>
                          update(option.id, { ...option, number: event.target.value })
                        }
                      />
                    )}
                  </Field>
                )}
              </>
            )}
            {!primary && option.kind === 'in_person' && (
              <Field id={`${id}-value`} label={t('Address')} error={errors[`${id}-value`]}>
                {(props) => (
                  <input
                    {...props}
                    value={option.address}
                    onChange={(event) =>
                      update(option.id, { ...option, address: event.target.value })
                    }
                  />
                )}
              </Field>
            )}
            {!primary && option.kind === 'link' && (
              <Field id={`${id}-value`} label={t('Meeting link')} error={errors[`${id}-value`]}>
                {(props) => (
                  <input
                    {...props}
                    type="url"
                    value={option.url}
                    onChange={(event) => update(option.id, { ...option, url: event.target.value })}
                  />
                )}
              </Field>
            )}
            <label>
              <input
                type="radio"
                name="default-location"
                checked={option.id === defaultId}
                onChange={() =>
                  set(
                    'locationOptions',
                    options.map((item) => {
                      const { isDefault: _default, ...rest } = item
                      return item.id === option.id ? { ...rest, isDefault: true } : rest
                    }),
                  )
                }
              />
              {t('Default location')}
            </label>
            <div className="row">
              <button
                className="button button-small"
                type="button"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                {t('Move location up')}
              </button>
              <button
                className="button button-small"
                type="button"
                disabled={index === options.length - 1}
                onClick={() => move(index, 1)}
              >
                {t('Move location down')}
              </button>
              {!primary && (
                <button
                  className="button button-small"
                  type="button"
                  onClick={() =>
                    set(
                      'locationOptions',
                      options.filter((item) => item.id !== option.id),
                    )
                  }
                >
                  {t('Remove location option')}
                </button>
              )}
            </div>
          </fieldset>
        )
      })}
      <Field id="location-option-add-kind" label={t('Add location option')}>
        {(props) => (
          <select
            {...props}
            disabled={available.length === 0}
            value={
              available.some((item) => item.value === addition)
                ? addition
                : (available[0]?.value ?? '')
            }
            onChange={(event) => setAddition(event.target.value)}
          >
            {available.map((item) => (
              <option key={item.value} value={item.value}>
                {ui(item.label)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <button
        className="button button-small"
        type="button"
        disabled={available.length === 0}
        onClick={add}
      >
        {t('Add location option')}
      </button>
    </section>
  )
}
