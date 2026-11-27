import { PAYMENT_CURRENCIES, type PaymentCurrency } from '@hourmere/core/payment'
import { describedBy, Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { type PaymentDraft, paymentAmountField, paymentAmountLabel } from './payment-form.ts'

export function PaymentSettings({
  payment,
  durations,
  reason,
  errors,
  onChange,
}: {
  payment: PaymentDraft
  durations: number[]
  reason: MessageKey | null
  errors: FieldErrors
  onChange: (value: PaymentDraft) => void
}) {
  const { t, uiText } = useI18n()
  return (
    <>
      <label className="checkbox">
        <input
          id="payment"
          type="checkbox"
          checked={payment.enabled}
          disabled={reason !== null && !payment.enabled}
          aria-describedby={describedBy('payment-hint', errors.payment && 'payment-error')}
          aria-invalid={errors.payment ? true : undefined}
          onChange={(event) => onChange({ ...payment, enabled: event.target.checked })}
        />
        {t('Charge for bookings')}
      </label>
      <p id="payment-hint" className="hint">
        {t(reason ?? 'Set a price for every duration. Invitees pay through Stripe Checkout.')}
      </p>
      {errors.payment && <FieldError id="payment-error">{errors.payment}</FieldError>}
      {payment.enabled && reason === null && (
        <>
          <Field id="payment-currency" label={t('Currency')}>
            {(props) => (
              <select
                {...props}
                value={payment.currency}
                onChange={(event) =>
                  onChange({ ...payment, currency: event.target.value as PaymentCurrency })
                }
              >
                {PAYMENT_CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {durations.map((duration) => {
            const id = paymentAmountField(duration)
            return (
              <Field
                key={duration}
                id={id}
                label={uiText(paymentAmountLabel(duration))}
                error={errors[id]}
              >
                {(props) => (
                  <input
                    {...props}
                    inputMode={payment.currency === 'jpy' ? 'numeric' : 'decimal'}
                    value={payment.amounts[duration] ?? ''}
                    onChange={(event) =>
                      onChange({
                        ...payment,
                        amounts: { ...payment.amounts, [duration]: event.target.value },
                      })
                    }
                  />
                )}
              </Field>
            )
          })}
        </>
      )}
    </>
  )
}
