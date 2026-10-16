// The booking form's extra questions: add, remove and reorder them, set their type, whether
// they must be answered, and the options of the choice types. Focus follows each change, and
// moves are announced, so the list works from the keyboard and with a screen reader.
import { useEffect, useRef, useState } from 'react'
import { Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { QUESTIONS } from '../../limits.ts'
import {
  isChoice,
  newOption,
  newQuestion,
  optionField,
  QUESTION_TYPES,
  type QuestionDraft,
  type QuestionType,
  questionField,
} from './event-type-form.ts'

/** Where focus goes after the next render: an element id. */
type FocusTarget = string | null

export function QuestionsEditor({
  questions,
  onChange,
  errors,
}: {
  questions: QuestionDraft[]
  onChange: (questions: QuestionDraft[]) => void
  errors: FieldErrors
}) {
  const [focus, setFocus] = useState<FocusTarget>(null)
  const [announcement, setAnnouncement] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (focus === null) return
    const element = document.getElementById(focus)
    if (element && !(element as HTMLButtonElement).disabled) element.focus()
    else addButton.current?.focus()
    setFocus(null)
  }, [focus])

  const update = (key: string, change: Partial<QuestionDraft>) =>
    onChange(questions.map((q) => (q.key === key ? { ...q, ...change } : q)))

  function add() {
    const question = newQuestion()
    onChange([...questions, question])
    setFocus(questionField(question, 'label'))
    setAnnouncement('')
  }

  function remove(index: number) {
    const removed = questions[index]
    if (!removed) return
    const rest = questions.filter((_, i) => i !== index)
    onChange(rest)
    // To the question that took its place, or the one before, or the add button.
    const next = rest[index] ?? rest[index - 1]
    setFocus(next ? questionField(next, 'label') : 'add-question')
    setAnnouncement(`Removed question ${index + 1}${removed.label ? `, “${removed.label}”` : ''}.`)
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by
    const moved = questions[index]
    if (!moved || target < 0 || target >= questions.length) return
    const reordered = [...questions]
    reordered.splice(index, 1)
    reordered.splice(target, 0, moved)
    onChange(reordered)
    // Stay on the same button of the moved question; at either end, on the other one.
    const atEnd = target === 0 || target === questions.length - 1
    const button = by === -1 ? (atEnd ? 'down' : 'up') : atEnd ? 'up' : 'down'
    setFocus(`question-${moved.key}-move-${button}`)
    setAnnouncement(
      `Moved ${moved.label ? `“${moved.label}”` : 'the question'} to position ${target + 1} of ${questions.length}.`,
    )
  }

  function changeType(q: QuestionDraft, type: QuestionType) {
    // A choice needs options; start with an empty one to fill in.
    const options = isChoice(type) && q.options.length === 0 ? [newOption()] : q.options
    update(q.key, { type, options })
  }

  const listError = errors.questions
  return (
    <div className="questions">
      <p className="hint">
        Invitees always give their name and email. Add questions for anything else you need to know,
        up to {QUESTIONS.maxQuestions}.
      </p>
      {listError && <FieldError id="questions-error">{listError}</FieldError>}
      {questions.length === 0 ? (
        <p className="muted">No extra questions.</p>
      ) : (
        <ol className="question-list">
          {questions.map((q, index) => (
            <li key={q.key} className="question">
              <QuestionCard
                question={q}
                index={index}
                count={questions.length}
                errors={errors}
                onUpdate={(change) => update(q.key, change)}
                onType={(type) => changeType(q, type)}
                onMove={(by) => move(index, by)}
                onRemove={() => remove(index)}
                setFocus={setFocus}
              />
            </li>
          ))}
        </ol>
      )}
      <button
        ref={addButton}
        id="add-question"
        type="button"
        className="button"
        onClick={add}
        disabled={questions.length >= QUESTIONS.maxQuestions}
      >
        Add a question
      </button>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  )
}

function QuestionCard({
  question: q,
  index,
  count,
  errors,
  onUpdate,
  onType,
  onMove,
  onRemove,
  setFocus,
}: {
  question: QuestionDraft
  index: number
  count: number
  errors: FieldErrors
  onUpdate: (change: Partial<QuestionDraft>) => void
  onType: (type: QuestionType) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
  setFocus: (id: FocusTarget) => void
}) {
  const number = index + 1
  const name = q.label.trim() ? `question ${number}, “${q.label.trim()}”` : `question ${number}`
  const legendId = `question-${q.key}-legend`
  const optionsError = errors[questionField(q, 'options')]

  function addOption() {
    const option = newOption()
    onUpdate({ options: [...q.options, option] })
    setFocus(optionField(q, option))
  }

  function removeOption(optionIndex: number) {
    const rest = q.options.filter((_, i) => i !== optionIndex)
    onUpdate({ options: rest })
    const next = rest[optionIndex] ?? rest[optionIndex - 1]
    setFocus(next ? optionField(q, next) : `question-${q.key}-add-option`)
  }

  return (
    <fieldset className="question-card" aria-labelledby={legendId}>
      <legend id={legendId} className="question-legend">
        Question {number}
      </legend>
      <div className="question-fields">
        <Field
          id={questionField(q, 'label')}
          label="Question"
          error={errors[questionField(q, 'label')]}
        >
          {(props) => (
            <input
              {...props}
              value={q.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
              autoComplete="off"
            />
          )}
        </Field>
        <Field
          id={questionField(q, 'type')}
          label="Answer type"
          error={errors[questionField(q, 'type')]}
        >
          {(props) => (
            <select
              {...props}
              value={q.type}
              onChange={(e) => onType(e.target.value as QuestionType)}
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={q.required}
          onChange={(e) => onUpdate({ required: e.target.checked })}
        />
        {q.type === 'checkbox' ? 'Must be ticked to book' : 'Required'}
      </label>

      {isChoice(q.type) && (
        // biome-ignore lint/a11y/useSemanticElements: nested fieldsets read poorly; a group with a name does the job
        <div
          className="options"
          role="group"
          aria-labelledby={`question-${q.key}-options-label`}
          aria-describedby={optionsError ? `${questionField(q, 'options')}-error` : undefined}
        >
          <p id={`question-${q.key}-options-label`} className="options-label">
            Options for question {number}
          </p>
          {optionsError && (
            <FieldError id={`${questionField(q, 'options')}-error`}>{optionsError}</FieldError>
          )}
          <ol className="option-list">
            {q.options.map((o, optionIndex) => {
              const id = optionField(q, o)
              const error = errors[id]
              return (
                <li key={o.key} className={`option${error ? ' field-invalid' : ''}`}>
                  <label htmlFor={id} className="visually-hidden">
                    Option {optionIndex + 1} of question {number}
                  </label>
                  {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
                  <div className="option-row">
                    <input
                      id={id}
                      value={o.text}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onChange={(e) =>
                        onUpdate({
                          options: q.options.map((x) =>
                            x.key === o.key ? { ...x, text: e.target.value } : x,
                          ),
                        })
                      }
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => removeOption(optionIndex)}
                      aria-label={`Remove option ${optionIndex + 1}${o.text.trim() ? `, “${o.text.trim()}”` : ''}, of question ${number}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          <button
            id={`question-${q.key}-add-option`}
            type="button"
            className="button button-small"
            onClick={addOption}
            disabled={q.options.length >= QUESTIONS.maxOptions}
          >
            Add an option
          </button>
        </div>
      )}

      <div className="question-actions">
        <button
          id={`question-${q.key}-move-up`}
          type="button"
          className="button button-small"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={`Move up: ${name}`}
        >
          Move up
        </button>
        <button
          id={`question-${q.key}-move-down`}
          type="button"
          className="button button-small"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label={`Move down: ${name}`}
        >
          Move down
        </button>
        <button
          type="button"
          className="button button-small"
          onClick={onRemove}
          aria-label={`Remove question: ${name}`}
        >
          Remove question
        </button>
      </div>
    </fieldset>
  )
}
