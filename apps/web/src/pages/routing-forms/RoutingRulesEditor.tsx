import { ROUTING_FORM_LIMITS } from '@hourmere/scheduling/routing-form-config'
import { useEffect, useState } from 'react'
import type { Schemas } from '../../api/client.ts'
import { controlProps, Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import { randomKey } from '../../public/api.ts'
import { ReorderButtons } from './RoutingQuestionsEditor.tsx'
import { RoutingTargetEditor } from './RoutingTargetEditor.tsx'
import type { RoutingTargetEvents } from './routing-target-events.ts'

type Form = Schemas['RoutingForm']
type Rule = Form['rules'][number]
type Condition = Rule['conditions'][number]
type Questions = Form['questions']
type Target = Form['fallback']

const addRuleId = 'routing-add-rule'
const newCondition = (): Condition => ({ questionId: '', operator: 'equals', value: '' })
const questionField = (path: string) => `${path}.questionId`

export function RoutingRulesEditor({
  questions,
  rules,
  fallback,
  onRulesChange,
  onFallbackChange,
  errors,
  events,
}: {
  questions: Questions
  rules: Rule[]
  fallback: Target
  onRulesChange: (rules: Rule[]) => void
  onFallbackChange: (fallback: Target) => void
  errors: FieldErrors
  events: RoutingTargetEvents
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
      <section className="questions" aria-labelledby="routing-rules-heading">
        <h2 id="routing-rules-heading">{t('Routing rules')}</h2>
        <p className="hint">
          {t(
            'The first rule whose conditions all match wins. The fallback applies when no rule matches or its target is unavailable.',
          )}
        </p>
        {errors.rules && <FieldError id="rules-error">{errors.rules}</FieldError>}
        {rules.length > 0 && (
          <ol className="question-list">
            {rules.map((rule, index) => {
              const path = `rules.${index}`
              const conditionsPath = `${path}.conditions`
              const identityPath = `${path}.id`
              const name = t('rule {number}', { number: index + 1 })
              const update = (patch: Partial<Rule>) =>
                onRulesChange(
                  rules.map((item) => (item.id === rule.id ? { ...rule, ...patch } : item)),
                )
              return (
                <li key={rule.id} className="question">
                  <fieldset className="question-card">
                    <legend className="question-legend">
                      {t('Rule {number}', { number: index + 1 })}
                    </legend>
                    {errors[path] && <FieldError id={`${path}-error`}>{errors[path]}</FieldError>}
                    {errors[identityPath] && (
                      <FieldError id={`${identityPath}-error`}>{errors[identityPath]}</FieldError>
                    )}
                    {errors[conditionsPath] && (
                      <FieldError id={`${conditionsPath}-error`}>
                        {errors[conditionsPath]}
                      </FieldError>
                    )}
                    <ol className="question-list">
                      {rule.conditions.map((condition, conditionIndex) => {
                        const conditionPath = `${conditionsPath}.${conditionIndex}`
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: Conditions have no IDs and their controls are fully controlled.
                          <li key={conditionIndex}>
                            <RuleCondition
                              condition={condition}
                              questions={questions}
                              path={conditionPath}
                              number={conditionIndex + 1}
                              errors={errors}
                              onChange={(next) =>
                                update({
                                  conditions: rule.conditions.map((item, i) =>
                                    i === conditionIndex ? next : item,
                                  ),
                                })
                              }
                              removable={rule.conditions.length > 1}
                              onRemove={() => {
                                const conditions = rule.conditions.filter(
                                  (_, i) => i !== conditionIndex,
                                )
                                update({ conditions })
                                setFocus(
                                  questionField(
                                    `${conditionsPath}.${Math.min(conditionIndex, conditions.length - 1)}`,
                                  ),
                                )
                              }}
                            />
                          </li>
                        )
                      })}
                    </ol>
                    <div className="question-actions">
                      <button
                        type="button"
                        className="button button-small"
                        disabled={
                          questions.length === 0 ||
                          rule.conditions.length >= ROUTING_FORM_LIMITS.conditionsPerRule
                        }
                        onClick={() => {
                          update({ conditions: [...rule.conditions, newCondition()] })
                          setFocus(questionField(`${conditionsPath}.${rule.conditions.length}`))
                        }}
                      >
                        {t('Add a condition')}
                      </button>
                    </div>
                    <RoutingTargetEditor
                      target={rule.target}
                      onChange={(target) => update({ target })}
                      questions={questions}
                      path={`${path}.target`}
                      errors={errors}
                      events={events}
                    />
                    <div className="question-actions">
                      <ReorderButtons
                        id={rule.id}
                        name={name}
                        items={rules}
                        index={index}
                        onChange={onRulesChange}
                        focusField={setFocus}
                        announceMove={announceMove}
                      />
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => {
                          const remaining = rules.filter(({ id }) => id !== rule.id)
                          onRulesChange(remaining)
                          const next =
                            remaining.length > 0
                              ? questionField(
                                  `rules.${Math.min(index, remaining.length - 1)}.conditions.0`,
                                )
                              : questions.length > 0
                                ? addRuleId
                                : 'routing-fallback-heading'
                          setFocus(next)
                        }}
                        aria-label={t('Remove rule: {0}', { '0': name })}
                      >
                        {t('Remove rule')}
                      </button>
                    </div>
                  </fieldset>
                </li>
              )
            })}
          </ol>
        )}
        {questions.length === 0 && (
          <p className="hint">{t('Add a question before adding a rule.')}</p>
        )}
        <div className="question-actions">
          <button
            id={addRuleId}
            type="button"
            className="button"
            disabled={questions.length === 0 || rules.length >= ROUTING_FORM_LIMITS.rulesPerForm}
            onClick={() => {
              onRulesChange([
                ...rules,
                {
                  id: randomKey(),
                  conditions: [newCondition()],
                  target: { kind: 'message', message: '' },
                },
              ])
              setFocus(questionField(`rules.${rules.length}.conditions.0`))
            }}
          >
            {t('Add a rule')}
          </button>
        </div>
        <p className="visually-hidden" role="status">
          {ui(announcement)}
        </p>
      </section>
      <section className="questions" aria-labelledby="routing-fallback-heading">
        <h2 id="routing-fallback-heading" tabIndex={-1}>
          {t('Fallback')}
        </h2>
        <RoutingTargetEditor
          target={fallback}
          onChange={onFallbackChange}
          questions={questions}
          path="fallback"
          errors={errors}
          events={events}
        />
      </section>
    </div>
  )
}

function RuleCondition({
  condition,
  questions,
  path,
  number,
  errors,
  onChange,
  removable,
  onRemove,
}: {
  condition: Condition
  questions: Questions
  path: string
  number: number
  errors: FieldErrors
  onChange: (condition: Condition) => void
  removable: boolean
  onRemove: () => void
}) {
  const { t } = useI18n()
  const question = questions.find(({ id }) => id === condition.questionId)
  const questionId = questionField(path)
  const operatorId = `${path}.operator`
  const name = t('Condition {number}', { number })
  return (
    <fieldset className="form-fieldset questions">
      <legend className="options-label">{name}</legend>
      {errors[path] && <FieldError id={`${path}-error`}>{errors[path]}</FieldError>}
      <div className="question-fields">
        <Field id={questionId} label={t('Routing question')} error={errors[questionId]}>
          {(props) => (
            <select
              {...props}
              value={condition.questionId}
              required
              onChange={(event) => onChange({ ...newCondition(), questionId: event.target.value })}
            >
              <option value="" disabled>
                {t('Select a routing question')}
              </option>
              {!question && condition.questionId && (
                <option value={condition.questionId} disabled>
                  {t('Unavailable question')}
                </option>
              )}
              {questions.map(({ id, label }, index) => (
                <option key={id} value={id}>
                  {label.trim() || t('Question {number}', { number: index + 1 })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={operatorId} label={t('Comparison')} error={errors[operatorId]}>
          {(props) => (
            <select
              {...props}
              disabled={!question}
              value={condition.operator}
              onChange={(event) =>
                onChange(
                  event.target.value === 'one_of'
                    ? {
                        questionId: condition.questionId,
                        operator: 'one_of',
                        values:
                          condition.operator === 'equals' && condition.value
                            ? [condition.value]
                            : [],
                      }
                    : {
                        questionId: condition.questionId,
                        operator: 'equals',
                        value:
                          condition.operator === 'one_of' && condition.values.length === 1
                            ? (condition.values[0] ?? '')
                            : '',
                      },
                )
              }
            >
              <option value="equals">{t('Equals')}</option>
              {(question?.type === 'select' || condition.operator === 'one_of') && (
                <option value="one_of" disabled={question?.type !== 'select'}>
                  {t('Is one of')}
                </option>
              )}
            </select>
          )}
        </Field>
      </div>
      {question && (
        <ConditionValue
          condition={condition}
          question={question}
          path={path}
          errors={errors}
          onChange={onChange}
        />
      )}
      {removable && (
        <div className="question-actions">
          <button
            type="button"
            className="button button-small"
            aria-label={t('Remove condition: {0}', { '0': name })}
            onClick={onRemove}
          >
            {t('Remove condition')}
          </button>
        </div>
      )}
    </fieldset>
  )
}

function ConditionValue({
  condition,
  question,
  path,
  errors,
  onChange,
}: {
  condition: Condition
  question: Questions[number]
  path: string
  errors: FieldErrors
  onChange: (condition: Condition) => void
}) {
  const { t } = useI18n()
  if (condition.operator === 'one_of') {
    if (question.type !== 'select') return null
    const id = `${path}.values`
    const selected = new Set(condition.values)
    const options = question.options
    const known = new Set(options.map((option) => option.id))
    const unavailable = condition.values.some((value) => !known.has(value))
    return (
      <fieldset
        {...controlProps(id, false, errors[id])}
        className="form-fieldset stack"
        tabIndex={-1}
      >
        <legend className="options-label">{t('Answers to match')}</legend>
        {errors[id] && <FieldError id={`${id}-error`}>{errors[id]}</FieldError>}
        {options.map((option, index) => (
          <label className="checkbox" key={option.id}>
            <input
              type="checkbox"
              checked={selected.has(option.id)}
              onChange={(event) => {
                if (event.target.checked) selected.add(option.id)
                else selected.delete(option.id)
                onChange({ ...condition, values: [...selected] })
              }}
            />
            <bdi className="user-content">
              {option.label.trim() || t('Option {number}', { number: index + 1 })}
            </bdi>
          </label>
        ))}
        {unavailable && (
          <div className="question-actions">
            <button
              type="button"
              className="button button-small"
              onClick={() =>
                onChange({
                  ...condition,
                  values: condition.values.filter((value) => known.has(value)),
                })
              }
            >
              {t('Remove unavailable options')}
            </button>
          </div>
        )}
      </fieldset>
    )
  }

  const id = `${path}.value`
  return (
    <Field id={id} label={t('Answer to match')} error={errors[id]}>
      {(props) =>
        question.type === 'select' ? (
          <select
            {...props}
            value={condition.value}
            required
            onChange={(event) => onChange({ ...condition, value: event.target.value })}
          >
            <option value="" disabled>
              {t('Select an option')}
            </option>
            {condition.value &&
              !question.options.some((option) => option.id === condition.value) && (
                <option value={condition.value} disabled>
                  {t('Unavailable option')}
                </option>
              )}
            {question.options.map((option, index) => (
              <option key={option.id} value={option.id}>
                {option.label.trim() || t('Option {number}', { number: index + 1 })}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...props}
            value={condition.value}
            type={question.type === 'email' ? 'email' : 'text'}
            maxLength={ROUTING_FORM_LIMITS.textAnswerLength}
            onChange={(event) => onChange({ ...condition, value: event.target.value })}
            autoComplete="off"
            required
          />
        )
      }
    </Field>
  )
}
