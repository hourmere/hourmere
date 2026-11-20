import { useEffect, useState } from 'react'
import type { Schemas } from '../../api/client.ts'
import { Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { QUESTIONS } from '../../limits.ts'
import { randomKey } from '../../public/api.ts'

type Question = Schemas['RoutingForm']['questions'][number]
type SelectQuestion = Extract<Question, { type: 'select' }>
type Direction = 'up' | 'down'
type FocusField = (id: string) => void
type AnnounceMove = (name: string, position: number, count: number) => void

const addQuestionId = 'routing-add-question'
const newOption = () => ({ id: randomKey(), label: '' })

export function RoutingQuestionsEditor({
  questions,
  onChange,
  errors = {},
}: {
  questions: Question[]
  onChange: (questions: Question[]) => void
  errors?: FieldErrors
}) {
  const { t, ui } = useI18n()
  const [focus, setFocus] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<UiText>('')

  useEffect(() => {
    if (focus === null) return
    document.getElementById(focus)?.focus()
    setFocus(null)
  }, [focus])

  function announceMove(name: string, position: number, count: number) {
    setAnnouncement(
      msg('Moved {0} to position {1} of {2}.', { '0': name, '1': position, '2': count }),
    )
  }

  return (
    <div className="questions">
      {errors.questions && <FieldError id="questions-error">{errors.questions}</FieldError>}
      {questions.length > 0 ? (
        <ol className="question-list">
          {questions.map((question, index) => {
            const field = `questions.${index}`
            const number = index + 1
            const name = question.label.trim()
              ? t('question {number}, “{label}”', { number, label: question.label.trim() })
              : t('question {number}', { number })
            const update = (updated: Question) =>
              onChange(questions.map((item) => (item.id === question.id ? updated : item)))
            return (
              <li key={question.id} className="question">
                <fieldset className="question-card">
                  <legend className="question-legend">{t('Question {number}', { number })}</legend>
                  <div className="question-fields">
                    <Field
                      id={`${field}.label`}
                      label={t('Question')}
                      error={errors[`${field}.label`]}
                    >
                      {(props) => (
                        <input
                          {...props}
                          value={question.label}
                          onChange={(event) => update({ ...question, label: event.target.value })}
                          maxLength={QUESTIONS.labelMaxLength}
                          autoComplete="off"
                          required
                        />
                      )}
                    </Field>
                    <Field
                      id={`${field}.type`}
                      label={t('Answer type')}
                      error={errors[`${field}.type`]}
                    >
                      {(props) => (
                        <select
                          {...props}
                          value={question.type}
                          onChange={(event) => {
                            const type = event.target.value as Question['type']
                            if (type === question.type) return
                            // A different answer type gives the question a new identity.
                            const { label, required } = question
                            const next = { id: randomKey(), label, required }
                            update(
                              type === 'select'
                                ? { ...next, type, options: [newOption()] }
                                : { ...next, type },
                            )
                            setFocus(`${field}.type`)
                          }}
                        >
                          <option value="short_text">{t('Short text')}</option>
                          <option value="email">{t('Email')}</option>
                          <option value="select">{t('Pick one (dropdown)')}</option>
                        </select>
                      )}
                    </Field>
                  </div>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={question.required}
                      onChange={(event) => update({ ...question, required: event.target.checked })}
                    />
                    {t('Required')}
                  </label>
                  {question.type === 'select' && (
                    <QuestionOptions
                      question={question}
                      number={number}
                      errors={errors}
                      onChange={(options) => update({ ...question, options })}
                      focusField={setFocus}
                      announceMove={announceMove}
                    />
                  )}
                  <div className="question-actions">
                    <ReorderButtons
                      id={question.id}
                      name={name}
                      items={questions}
                      index={index}
                      onChange={onChange}
                      focusField={setFocus}
                      announceMove={announceMove}
                    />
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => {
                        const rest = questions.filter((item) => item.id !== question.id)
                        onChange(rest)
                        setFocus(
                          rest.length > 0
                            ? `questions.${Math.min(index, rest.length - 1)}.label`
                            : addQuestionId,
                        )
                      }}
                      aria-label={t('Remove question: {0}', { '0': name })}
                    >
                      {t('Remove question')}
                    </button>
                  </div>
                </fieldset>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="muted">{t('No questions yet.')}</p>
      )}
      <button
        id={addQuestionId}
        type="button"
        className="button"
        disabled={questions.length >= QUESTIONS.maxQuestions}
        onClick={() => {
          onChange([
            ...questions,
            { id: randomKey(), type: 'short_text', label: '', required: false },
          ])
          setFocus(`questions.${questions.length}.label`)
        }}
      >
        {t('Add a question')}
      </button>
      <p className="visually-hidden" role="status">
        {ui(announcement)}
      </p>
    </div>
  )
}

function QuestionOptions({
  question,
  number,
  errors,
  onChange,
  focusField,
  announceMove,
}: {
  question: SelectQuestion
  number: number
  errors: FieldErrors
  onChange: (options: SelectQuestion['options']) => void
  focusField: FocusField
  announceMove: AnnounceMove
}) {
  const { t } = useI18n()
  const { options } = question
  const field = `questions.${number - 1}.options`
  const labelId = `routing-options-${question.id}`
  return (
    <section className="options" aria-labelledby={labelId}>
      <p id={labelId} className="options-label">
        {t('Options for question {number}', { number })}
      </p>
      {errors[field] && <FieldError id={`${field}-error`}>{errors[field]}</FieldError>}
      <ol className="option-list">
        {options.map((option, index) => {
          const name = t('Option {option} of question {number}', { option: index + 1, number })
          const id = `${field}.${index}.label`
          return (
            <li key={option.id} className="option">
              <Field id={id} label={name} error={errors[id]}>
                {(props) => (
                  <input
                    {...props}
                    value={option.label}
                    onChange={(event) =>
                      onChange(
                        options.map((item) =>
                          item.id === option.id ? { ...item, label: event.target.value } : item,
                        ),
                      )
                    }
                    maxLength={QUESTIONS.optionMaxLength}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
              <div className="question-actions">
                <ReorderButtons
                  id={option.id}
                  name={name}
                  items={options}
                  index={index}
                  onChange={onChange}
                  focusField={focusField}
                  announceMove={announceMove}
                />
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => {
                    const rest = options.filter((item) => item.id !== option.id)
                    onChange(rest)
                    focusField(`${field}.${Math.min(index, rest.length - 1)}.label`)
                  }}
                  disabled={options.length === 1}
                  aria-label={t('Remove option: {0}', { '0': name })}
                >
                  {t('Remove option')}
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        className="button button-small"
        disabled={options.length >= QUESTIONS.maxOptions}
        onClick={() => {
          onChange([...options, newOption()])
          focusField(`${field}.${options.length}.label`)
        }}
      >
        {t('Add an option')}
      </button>
    </section>
  )
}

function ReorderButtons<T extends { id: string }>({
  id,
  name,
  items,
  index,
  onChange,
  focusField,
  announceMove,
}: {
  id: string
  name: string
  items: T[]
  index: number
  onChange: (items: T[]) => void
  focusField: FocusField
  announceMove: AnnounceMove
}) {
  const { t } = useI18n()
  const controlId = (direction: Direction) => `routing-${id}-move-${direction}`

  function move(direction: Direction) {
    const target = index + (direction === 'up' ? -1 : 1)
    const reordered = [...items]
    const [moved] = reordered.splice(index, 1)
    if (!moved || target < 0 || target >= items.length) return
    reordered.splice(target, 0, moved)
    onChange(reordered)
    focusField(controlId(target === 0 ? 'down' : target === items.length - 1 ? 'up' : direction))
    announceMove(name, target + 1, items.length)
  }

  return (
    <>
      <button
        id={controlId('up')}
        type="button"
        className="button button-small"
        onClick={() => move('up')}
        disabled={index === 0}
        aria-label={t('Move up: {0}', { '0': name })}
      >
        {t('Move up')}
      </button>
      <button
        id={controlId('down')}
        type="button"
        className="button button-small"
        onClick={() => move('down')}
        disabled={index === items.length - 1}
        aria-label={t('Move down: {0}', { '0': name })}
      >
        {t('Move down')}
      </button>
    </>
  )
}
