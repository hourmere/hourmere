import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it } from 'vitest'
import { BookingForm, type BookingFormValues, validateBookingForm } from './BookingForm.tsx'

function Form() {
  const [values, setValues] = useState<BookingFormValues>({
    name: 'Visitor',
    email: 'visitor@example.com',
    guests: [],
    answers: {},
  })
  return (
    <BookingForm
      smsRemindersEnabled
      allowGuests={false}
      questions={[]}
      values={values}
      onChange={setValues}
      serverErrors={{}}
      formError={null}
      submitting={false}
      onSubmit={() => {}}
    />
  )
}
it('requires an explicit SMS opt-in before collecting a reminder phone', async () => {
  const user = userEvent.setup()
  render(<Form />)
  expect(screen.queryByLabelText('Your phone number')).toBeNull()
  const consent = screen.getByRole('checkbox', { name: /I agree to SMS/ })
  expect((consent as HTMLInputElement).checked).toBe(false)
  await user.click(consent)
  expect(screen.getByLabelText('Your phone number')).toBeTruthy()
  await user.click(consent)
  expect(screen.queryByLabelText('Your phone number')).toBeNull()
})

it('requires an international phone only when the invitee consents', () => {
  const values = { name: 'Visitor', email: 'visitor@example.com', guests: [], answers: {} }
  expect(validateBookingForm([], values)).toEqual({})
  expect(validateBookingForm([], { ...values, smsConsent: true })).toHaveProperty('inviteePhone')
  expect(
    validateBookingForm([], { ...values, smsConsent: true, inviteePhone: '+1 (415) 555-0123' }),
  ).toEqual({})
})
