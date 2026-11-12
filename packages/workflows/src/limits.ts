// The pinned workflow limits (docs/workflows.md, "Definitions, ownership and limits"). The
// document test binds every number in that table to these constants, so the two cannot drift.
// The definition contract enforces the structural ones (name, subject and body sizes, actions,
// conditions and timer offsets); later steps enforce the rest where their behavior lives.
// WORKFLOW_MAIL_MAX_PER_HOUR and WORKFLOW_OWNER_MAIL_MAX_PER_HOUR are the defaults of the
// operator sub-caps that a later step reads from the configuration.

/** Matching enabled definitions per event type, including all-event definitions. */
export const WORKFLOW_MAX_ENABLED_PER_EVENT = 5
/** All retained definitions of one owner, including disabled drafts. */
export const WORKFLOW_MAX_DEFINITIONS_PER_OWNER = 100
/** UTF-8 bytes of a definition name after normalization. */
export const WORKFLOW_NAME_MAX_BYTES = 200
/** UTF-8 bytes of a custom subject. */
export const WORKFLOW_SUBJECT_MAX_BYTES = 200
/** UTF-8 bytes of a custom body, per locale, after line-ending normalization. */
export const WORKFLOW_BODY_MAX_BYTES = 8000
/** Expanded plain text per recipient before HTML escaping. */
export const WORKFLOW_RENDERED_MAX_BYTES = 16000
/** Actions per definition; independent actions are separate workflows. */
export const WORKFLOW_MAX_ACTIONS = 1
/** Conditions, joined only by AND. */
export const WORKFLOW_MAX_CONDITIONS = 5
/** Smallest before-start or after-end offset. */
export const WORKFLOW_MIN_TIMER_OFFSET_MINUTES = 5
/** Largest timer offset or lifecycle delay. */
export const WORKFLOW_MAX_OFFSET_MINUTES = 43200
/** Strict upper bound on catch-up lateness. */
export const WORKFLOW_MAX_LATE_MINUTES = 60
/** Default instance workflow mail per sliding hour, before the shared-budget reserve. */
export const WORKFLOW_MAIL_MAX_PER_HOUR = 20
/** A positive core cap is divided by this before the workflow ceiling applies. */
export const WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR = 5
/** Default workflow mail per sliding hour for each personal owner or team. */
export const WORKFLOW_OWNER_MAIL_MAX_PER_HOUR = 5
/** Workflow mail per normalized recipient address per sliding hour, hosts included. */
export const WORKFLOW_RECIPIENT_EMAILS_PER_HOUR = 1
/** Workflow mail per normalized recipient address per sliding day, hosts included. */
export const WORKFLOW_RECIPIENT_EMAILS_PER_DAY = 3
/** Visible run history and scheduled metadata retention after a terminal state. */
export const WORKFLOW_HISTORY_DAYS = 30

/** Every pinned limit by its documented identifier. */
export const WORKFLOW_LIMITS = Object.freeze({
  WORKFLOW_MAX_ENABLED_PER_EVENT,
  WORKFLOW_MAX_DEFINITIONS_PER_OWNER,
  WORKFLOW_NAME_MAX_BYTES,
  WORKFLOW_SUBJECT_MAX_BYTES,
  WORKFLOW_BODY_MAX_BYTES,
  WORKFLOW_RENDERED_MAX_BYTES,
  WORKFLOW_MAX_ACTIONS,
  WORKFLOW_MAX_CONDITIONS,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES,
  WORKFLOW_MAX_OFFSET_MINUTES,
  WORKFLOW_MAX_LATE_MINUTES,
  WORKFLOW_MAIL_MAX_PER_HOUR,
  WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR,
  WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
  WORKFLOW_RECIPIENT_EMAILS_PER_HOUR,
  WORKFLOW_RECIPIENT_EMAILS_PER_DAY,
  WORKFLOW_HISTORY_DAYS,
})
