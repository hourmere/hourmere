import type { SourceRow } from './types.ts'

/**
 * Literal defaults from ensureBookingInputsHaveSystemFields in
 * cal.diy a5ee96f77edd644439e7de8c3255ccb2eb2c5941 (lines 91-245) and
 * cal.diy v6.2.0 (lines 163-317), whose two default arrays are identical.
 * packages/features/bookings/lib/getBookingFields.ts
 * Empty bookingFields/customInputs, guests enabled, title hidden, notes optional,
 * and (v6.2.0) no workflows. bookingFieldsManager persists these full system shapes.
 * Preserve defaultLabel translation keys, editable, sources, optionsInputs and views.
 */
export const caldiyDefaultBookingFields: SourceRow[] = [
  ...[
    {
      type: 'name',
      name: 'name',
      editable: 'system',
      defaultLabel: 'your_name',
      required: true,
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'email_address',
      type: 'email',
      name: 'email',
      required: true,
      editable: 'system-but-optional',
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'phone_number',
      type: 'phone',
      name: 'attendeePhoneNumber',
      required: false,
      hidden: true,
      editable: 'system-but-optional',
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'location',
      type: 'radioInput',
      name: 'location',
      editable: 'system',
      hideWhenJustOneOption: true,
      required: false,
      getOptionsAt: 'locations',
      optionsInputs: {
        attendeeInPerson: {
          type: 'address',
          required: true,
          placeholder: '',
        },
        somewhereElse: {
          type: 'text',
          required: true,
          placeholder: '',
        },
        phone: {
          type: 'phone',
          required: true,
          placeholder: '',
        },
      },
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
  ],
  ...[
    {
      defaultLabel: 'what_is_this_meeting_about',
      type: 'text',
      name: 'title',
      editable: 'system-but-optional',
      required: true,
      hidden: true,
      defaultPlaceholder: '',
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'additional_notes',
      type: 'textarea',
      name: 'notes',
      editable: 'system-but-optional',
      required: false,
      defaultPlaceholder: 'share_additional_notes',
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'additional_guests',
      type: 'multiemail',
      editable: 'system-but-optional',
      name: 'guests',
      defaultPlaceholder: 'email',
      required: false,
      hidden: false,
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
    {
      defaultLabel: 'reason_for_reschedule',
      type: 'textarea',
      editable: 'system-but-optional',
      name: 'rescheduleReason',
      defaultPlaceholder: 'reschedule_placeholder',
      required: false,
      views: [
        {
          id: 'reschedule',
          label: 'Reschedule View',
        },
      ],
      sources: [
        {
          label: 'Default',
          id: 'default',
          type: 'default',
        },
      ],
    },
  ],
]
