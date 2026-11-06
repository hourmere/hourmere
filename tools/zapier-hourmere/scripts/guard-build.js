// Zapier invokes this hook for build and push, including direct CLI invocations. The CLI's
// `upload` command runs no app hook, so `npm run upload` calls this guard before it.
if (process.env.HOURMERE_ZAPIER_PUSH_APPROVED !== '1') {
  throw new Error(
    'Build, push and upload require explicit HOURMERE_ZAPIER_PUSH_APPROVED=1 approval.',
  )
}
